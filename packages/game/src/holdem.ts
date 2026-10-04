import { createDeck, shuffle, type Card } from "./cards.js";
import { bestHand, compareHands, describeHand, type HandValue } from "./hands.js";

export interface Settings {
	startingChips: number;
	smallBlind: number;
	bigBlind: number;
	/** 盲注每隔多少分钟翻倍；0 表示不涨。 */
	blindIncreaseMinutes: 0 | 10 | 15 | 20;
	/** 每次行动的限时秒数；0 表示不限时。 */
	actionSeconds: 0 | 30 | 60;
}

export const DEFAULT_SETTINGS: Settings = {
	startingChips: 1000,
	smallBlind: 10,
	bigBlind: 20,
	blindIncreaseMinutes: 0,
	actionSeconds: 30,
};

export interface PlayerState {
	id: string;
	name: string;
	chips: number;
	holeCards: Card[];
	/** 这一手牌是否参与（开始时有筹码）。 */
	inHand: boolean;
	folded: boolean;
	allIn: boolean;
	/** 本轮（当前街）已下注额。 */
	streetBet: number;
	/** 这一手牌累计下注额，用于计算边池。 */
	handBet: number;
	/** 本轮最近一次行动时的 raiseCount；null 表示本轮还没行动。 */
	actedAt: number | null;
	/** 淘汰名次；null 表示还在比赛中。 */
	place: number | null;
}

export type Street = "preflop" | "flop" | "turn" | "river" | "showdown";

export type ActionRecord = {
	type: "smallBlind" | "bigBlind" | "fold" | "check" | "call" | "bet" | "raise" | "allIn";
	amount: number;
};

export interface PotResult {
	amount: number;
	eligibleIds: string[];
	winnerIds: string[];
	/** 每位赢家分到的筹码（含零头）。 */
	shares: Record<string, number>;
}

export interface HandResult {
	/** 只剩一人未弃牌，直接赢下底池。 */
	uncontested: boolean;
	pots: PotResult[];
	/** 摊牌时亮出的牌和牌型。 */
	revealed: Record<string, { cards: Card[]; handName: string; best: Card[] }>;
	eliminatedIds: string[];
}

export interface HandState {
	number: number;
	dealerSeat: number;
	smallBlindSeat: number;
	bigBlindSeat: number;
	level: number;
	smallBlind: number;
	bigBlind: number;
	deck: Card[];
	board: Card[];
	street: Street;
	/** 本轮最高下注额。 */
	currentBet: number;
	/** 最小加注幅度：本轮上一次完整加注的幅度，至少一个大盲。 */
	minRaise: number;
	/** 本轮完整加注的次数；全下不足一个完整加注时不增加，因此不会重新开放加注。 */
	raiseCount: number;
	turn: number | null;
	/** 每个座位在本轮最近的动作，用于桌面展示。 */
	actions: (ActionRecord | null)[];
	result: HandResult | null;
	/** 这一手开始时各座位的筹码，用于同一手多人淘汰时排名次。 */
	startingChips: number[];
}

export interface MatchState {
	settings: Settings;
	startedAt: number;
	players: PlayerState[];
	phase: "playing" | "handOver" | "finished";
	hand: HandState;
	winnerId: string | null;
}

export type PokerAction =
	| { type: "fold" }
	| { type: "check" }
	| { type: "call" }
	| { type: "raise"; to: number }
	| { type: "allIn" };

export class RuleViolation extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RuleViolation";
	}
}

/** 当前时间对应的盲注级别。 */
export function blindsAt(settings: Settings, startedAt: number, now: number): { level: number; smallBlind: number; bigBlind: number } {
	const minutes = settings.blindIncreaseMinutes;
	const level = minutes > 0 ? Math.max(0, Math.floor((now - startedAt) / (minutes * 60_000))) : 0;
	const factor = 2 ** level;
	return { level, smallBlind: settings.smallBlind * factor, bigBlind: settings.bigBlind * factor };
}

export function validateSettings(settings: Settings): string | null {
	const { startingChips, smallBlind, bigBlind, blindIncreaseMinutes, actionSeconds } = settings;
	if (![startingChips, smallBlind, bigBlind].every((value) => Number.isInteger(value) && value > 0)) return "筹码和盲注必须是正整数。";
	if (startingChips > 1_000_000) return "初始筹码最多 1000000。";
	if (smallBlind >= bigBlind) return "小盲必须小于大盲。";
	if (bigBlind * 10 > startingChips) return "初始筹码至少要有 10 个大盲。";
	if (![0, 10, 15, 20].includes(blindIncreaseMinutes)) return "盲注上涨间隔无效。";
	if (![0, 30, 60].includes(actionSeconds)) return "行动限时无效。";
	return null;
}

function seatCount(state: MatchState): number {
	return state.players.length;
}

/** 从 from 之后（不含）按座位顺序找第一个满足条件的座位。 */
function nextSeat(state: MatchState, from: number, accept: (player: PlayerState) => boolean): number | null {
	const total = seatCount(state);
	for (let step = 1; step <= total; step += 1) {
		const seat = (from + step) % total;
		if (accept(state.players[seat]!)) return seat;
	}
	return null;
}

const inGame = (player: PlayerState) => player.place === null && player.chips > 0;
const isLive = (player: PlayerState) => player.inHand && !player.folded;
/** 还能下注的玩家：在这一手中、未弃牌、未全下。 */
const isActor = (player: PlayerState) => isLive(player) && !player.allIn;

function putChips(state: MatchState, seat: number, amount: number): number {
	const player = state.players[seat]!;
	const paid = Math.min(amount, player.chips);
	player.chips -= paid;
	player.streetBet += paid;
	player.handBet += paid;
	if (player.chips === 0) player.allIn = true;
	return paid;
}

function startHand(state: MatchState, now: number, random: () => number, firstHand: boolean): void {
	const previous = state.hand;
	const blinds = blindsAt(state.settings, state.startedAt, now);
	for (const player of state.players) {
		Object.assign(player, { holeCards: [], inHand: inGame(player), folded: false, allIn: false, streetBet: 0, handBet: 0, actedAt: null });
	}
	const contenders = state.players.filter((player) => player.inHand);
	const dealerSeat = firstHand
		? state.players.indexOf(contenders[Math.floor(random() * contenders.length)]!)
		: nextSeat(state, previous.dealerSeat, (player) => player.inHand)!;
	// 两人对局时庄位下小盲。
	const smallBlindSeat = contenders.length === 2 ? dealerSeat : nextSeat(state, dealerSeat, (player) => player.inHand)!;
	const bigBlindSeat = nextSeat(state, smallBlindSeat, (player) => player.inHand)!;

	state.hand = {
		number: firstHand ? 1 : previous.number + 1,
		dealerSeat,
		smallBlindSeat,
		bigBlindSeat,
		level: blinds.level,
		smallBlind: blinds.smallBlind,
		bigBlind: blinds.bigBlind,
		deck: shuffle(createDeck(), random),
		board: [],
		street: "preflop",
		currentBet: blinds.bigBlind,
		minRaise: blinds.bigBlind,
		raiseCount: 0,
		turn: null,
		actions: state.players.map(() => null),
		result: null,
		startingChips: state.players.map((player) => player.chips),
	};
	const hand = state.hand;
	hand.actions[smallBlindSeat] = { type: "smallBlind", amount: putChips(state, smallBlindSeat, blinds.smallBlind) };
	hand.actions[bigBlindSeat] = { type: "bigBlind", amount: putChips(state, bigBlindSeat, blinds.bigBlind) };
	for (let round = 0; round < 2; round += 1) {
		for (const player of contenders) player.holeCards.push(hand.deck.pop()!);
	}
	state.phase = "playing";
	// 翻牌前从大盲左手第一位开始（两人对局时庄位/小盲先行动）。
	continueBetting(state, bigBlindSeat);
}

export function createMatch(
	players: { id: string; name: string }[],
	settings: Settings,
	now: number,
	random: () => number = Math.random,
): MatchState {
	if (players.length < 2 || players.length > 6) throw new RuleViolation("德州扑克需要 2–6 位玩家。");
	const error = validateSettings(settings);
	if (error) throw new RuleViolation(error);
	const state: MatchState = {
		settings: { ...settings },
		startedAt: now,
		players: players.map((player) => ({
			id: player.id,
			name: player.name,
			chips: settings.startingChips,
			holeCards: [],
			inHand: true,
			folded: false,
			allIn: false,
			streetBet: 0,
			handBet: 0,
			actedAt: null,
			place: null,
		})),
		phase: "playing",
		hand: undefined as unknown as HandState,
		winnerId: null,
	};
	startHand(state, now, random, true);
	return state;
}

function needsToAct(hand: HandState, player: PlayerState): boolean {
	return isActor(player) && (player.actedAt === null || player.streetBet < hand.currentBet);
}

/** 本轮是否已经没有人需要行动。 */
function bettingRoundComplete(state: MatchState): boolean {
	const hand = state.hand;
	const actors = state.players.filter(isActor);
	if (actors.length === 0) return true;
	// 只剩一个人还能下注、且他已经跟平：没有对手可以再下注了。
	if (actors.length === 1 && actors[0]!.streetBet >= hand.currentBet) return true;
	return !actors.some((player) => needsToAct(hand, player));
}

/** 行动之后：结束这一手、进入下一街，或把行动权交给下一位。 */
function continueBetting(state: MatchState, lastSeat: number): void {
	const hand = state.hand;
	if (state.players.filter(isLive).length === 1) {
		finishHand(state);
		return;
	}
	if (!bettingRoundComplete(state)) {
		hand.turn = nextSeat(state, lastSeat, (player) => needsToAct(hand, player));
		return;
	}
	advanceStreet(state);
}

function advanceStreet(state: MatchState): void {
	const hand = state.hand;
	for (const player of state.players) {
		player.streetBet = 0;
		player.actedAt = null;
	}
	hand.currentBet = 0;
	hand.minRaise = hand.bigBlind;
	hand.raiseCount = 0;
	hand.actions = state.players.map((player) => (player.inHand && player.folded ? { type: "fold", amount: 0 } : null));
	if (hand.street === "river") {
		hand.street = "showdown";
		finishHand(state);
		return;
	}
	const drawCount = hand.street === "preflop" ? 3 : 1;
	hand.board.push(...hand.deck.splice(-drawCount).reverse());
	hand.street = hand.street === "preflop" ? "flop" : hand.street === "flop" ? "turn" : "river";
	// 两人以上还能下注才开新一轮；否则直接发完公共牌。
	if (state.players.filter(isActor).length < 2) {
		advanceStreet(state);
		return;
	}
	// 翻牌后从庄位左手第一位开始行动。
	hand.turn = nextSeat(state, hand.dealerSeat, (player) => needsToAct(hand, player));
}

/** 按各人累计下注切分主池和边池。 */
function buildPots(state: MatchState): { amount: number; eligibleIds: string[] }[] {
	const contributors = state.players.filter((player) => player.handBet > 0);
	const levels = [...new Set(state.players.filter(isLive).map((player) => player.handBet))].filter((level) => level > 0).sort((a, b) => a - b);
	const pots: { amount: number; eligibleIds: string[] }[] = [];
	let previous = 0;
	for (const level of levels) {
		const amount = contributors.reduce((total, player) => total + Math.max(0, Math.min(player.handBet, level) - previous), 0);
		const eligibleIds = state.players.filter((player) => isLive(player) && player.handBet >= level).map((player) => player.id);
		const last = pots[pots.length - 1];
		if (last && last.eligibleIds.join() === eligibleIds.join()) last.amount += amount;
		else pots.push({ amount, eligibleIds });
		previous = level;
	}
	const total = contributors.reduce((sum, player) => sum + player.handBet, 0);
	const assigned = pots.reduce((sum, pot) => sum + pot.amount, 0);
	if (pots.length > 0 && total > assigned) pots[pots.length - 1]!.amount += total - assigned;
	return pots;
}

/** 零头从庄位左手边开始依次分给赢家。 */
function splitPot(state: MatchState, amount: number, winnerIds: string[]): Record<string, number> {
	const order: string[] = [];
	for (let step = 1; step <= seatCount(state); step += 1) {
		const player = state.players[(state.hand.dealerSeat + step) % seatCount(state)]!;
		if (winnerIds.includes(player.id)) order.push(player.id);
	}
	const base = Math.floor(amount / order.length);
	let remainder = amount - base * order.length;
	const shares: Record<string, number> = {};
	for (const id of order) {
		shares[id] = base + (remainder > 0 ? 1 : 0);
		if (remainder > 0) remainder -= 1;
	}
	return shares;
}

function finishHand(state: MatchState): void {
	const hand = state.hand;
	hand.turn = null;
	const live = state.players.filter(isLive);
	const uncontested = live.length === 1;
	const values = new Map<string, HandValue>();
	const revealed: HandResult["revealed"] = {};
	if (!uncontested) {
		for (const player of live) {
			const value = bestHand([...player.holeCards, ...hand.board]);
			values.set(player.id, value);
			revealed[player.id] = { cards: [...player.holeCards], handName: describeHand(value), best: value.cards };
		}
	}
	const pots: PotResult[] = buildPots(state).map((pot) => {
		let winnerIds = pot.eligibleIds;
		if (!uncontested && pot.eligibleIds.length > 1) {
			const best = pot.eligibleIds.reduce((top, id) => (compareHands(values.get(id)!, values.get(top)!) > 0 ? id : top));
			winnerIds = pot.eligibleIds.filter((id) => compareHands(values.get(id)!, values.get(best)!) === 0);
		}
		return { ...pot, winnerIds, shares: splitPot(state, pot.amount, winnerIds) };
	});
	for (const pot of pots) {
		for (const [id, share] of Object.entries(pot.shares)) state.players.find((player) => player.id === id)!.chips += share;
	}

	// 淘汰：同一手多人出局时，这手开始时筹码多的人名次靠前。
	const remainingBefore = state.players.filter((player) => player.place === null).length;
	const busted = state.players
		.map((player, seat) => ({ player, seat }))
		.filter(({ player }) => player.place === null && player.chips === 0)
		.sort((left, right) => hand.startingChips[left.seat]! - hand.startingChips[right.seat]!);
	busted.forEach(({ player }, index) => {
		player.place = remainingBefore - index;
	});
	hand.result = { uncontested, pots, revealed, eliminatedIds: busted.map(({ player }) => player.id) };
	hand.street = uncontested ? hand.street : "showdown";

	const survivors = state.players.filter((player) => player.place === null);
	if (survivors.length <= 1) {
		const winner = survivors[0] ?? null;
		if (winner) winner.place = 1;
		state.winnerId = winner?.id ?? null;
		state.phase = "finished";
		return;
	}
	state.phase = "handOver";
}

/** 一手结束、展示完结果后，发下一手。 */
export function startNextHand(previous: MatchState, now: number, random: () => number = Math.random): MatchState {
	if (previous.phase !== "handOver") throw new RuleViolation("现在不能发下一手。");
	const state = structuredClone(previous);
	startHand(state, now, random, false);
	return state;
}

export interface LegalActions {
	toCall: number;
	canCheck: boolean;
	canCall: boolean;
	canRaise: boolean;
	/** 下注/加注到的最小和最大总额（本轮）。 */
	minRaiseTo: number;
	maxRaiseTo: number;
	canAllIn: boolean;
}

export function legalActions(state: MatchState, seat: number): LegalActions | null {
	const hand = state.hand;
	const player = state.players[seat];
	if (state.phase !== "playing" || hand.turn !== seat || !player) return null;
	const toCall = Math.max(0, hand.currentBet - player.streetBet);
	const maxRaiseTo = player.streetBet + player.chips;
	const othersCanRespond = state.players.some((other, index) => index !== seat && isActor(other));
	const reopened = player.actedAt === null || player.actedAt < hand.raiseCount;
	const canRaise = othersCanRespond && reopened && player.chips > toCall;
	const minRaiseTo = Math.min(maxRaiseTo, hand.currentBet + hand.minRaise);
	return {
		toCall,
		canCheck: toCall === 0,
		canCall: toCall > 0,
		canRaise,
		minRaiseTo,
		maxRaiseTo,
		// 不能加注时，全下只能是筹码不够跟注的情况（等同跟注）。
		canAllIn: canRaise || player.chips <= toCall,
	};
}

function seatOf(state: MatchState, playerId: string): number {
	const seat = state.players.findIndex((player) => player.id === playerId);
	if (seat < 0) throw new RuleViolation("你不在这场比赛中。");
	return seat;
}

export function applyAction(previous: MatchState, playerId: string, action: PokerAction): MatchState {
	const state = structuredClone(previous);
	const seat = seatOf(state, playerId);
	const hand = state.hand;
	const player = state.players[seat]!;
	const legal = legalActions(state, seat);
	if (!legal) throw new RuleViolation(state.phase === "playing" ? "还没轮到你行动。" : "这一手已经结束。");

	const raiseTo = (target: number, label: "bet" | "raise" | "allIn") => {
		const increment = target - hand.currentBet;
		putChips(state, seat, target - player.streetBet);
		if (increment >= hand.minRaise) {
			// 完整加注：重新开放加注，并把最小加注幅度提高到这次的幅度。
			hand.minRaise = increment;
			hand.raiseCount += 1;
		}
		hand.currentBet = Math.max(hand.currentBet, target);
		hand.actions[seat] = { type: label, amount: player.streetBet };
	};

	switch (action?.type) {
		case "fold":
			player.folded = true;
			hand.actions[seat] = { type: "fold", amount: 0 };
			break;
		case "check":
			if (!legal.canCheck) throw new RuleViolation("现在需要跟注，不能过牌。");
			hand.actions[seat] = { type: "check", amount: 0 };
			break;
		case "call": {
			if (!legal.canCall) throw new RuleViolation("现在没有需要跟的注。");
			putChips(state, seat, legal.toCall);
			hand.actions[seat] = { type: player.allIn ? "allIn" : "call", amount: player.streetBet };
			break;
		}
		case "raise": {
			if (!legal.canRaise) throw new RuleViolation("现在不能加注。");
			const target = action.to;
			if (!Number.isInteger(target)) throw new RuleViolation("加注额必须是整数。");
			if (target > legal.maxRaiseTo) throw new RuleViolation("筹码不够。");
			if (target < legal.minRaiseTo) throw new RuleViolation(`最少要加到 ${legal.minRaiseTo}。`);
			raiseTo(target, target === legal.maxRaiseTo ? "allIn" : hand.currentBet === 0 ? "bet" : "raise");
			break;
		}
		case "allIn": {
			if (!legal.canAllIn) throw new RuleViolation("现在不能全下。");
			if (legal.maxRaiseTo <= hand.currentBet) {
				putChips(state, seat, player.chips);
				hand.actions[seat] = { type: "allIn", amount: player.streetBet };
			} else {
				raiseTo(legal.maxRaiseTo, "allIn");
			}
			break;
		}
		default:
			throw new RuleViolation("无法识别的行动。");
	}
	player.actedAt = hand.raiseCount;
	continueBetting(state, seat);
	return state;
}

/** 超时：能过牌就过牌，否则弃牌。 */
export function timeoutAction(state: MatchState): { playerId: string; action: PokerAction } | null {
	const seat = state.hand.turn;
	if (state.phase !== "playing" || seat === null) return null;
	const legal = legalActions(state, seat)!;
	return { playerId: state.players[seat]!.id, action: legal.canCheck ? { type: "check" } : { type: "fold" } };
}
