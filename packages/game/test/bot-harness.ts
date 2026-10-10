/**
 * 人机模拟用的公共代码：几种策略 + 打一整场比赛。bot.test.ts 和
 * ~/projects/qa-reports/tools/bots/sim-texas-holdem.ts 共用。
 */
import { botCommand } from "../src/bot.js";
import { bestHand } from "../src/hands.js";
import {
	DEFAULT_SETTINGS,
	applyAction,
	createMatch,
	legalActions,
	startNextHand,
	type MatchState,
	type PokerAction,
	type Settings,
} from "../src/holdem.js";
import { viewForPlayer } from "../src/view.js";

export type Policy = (state: MatchState, playerId: string, random: () => number) => PokerAction;

export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function seatOf(state: MatchState, playerId: string): number {
	return state.players.findIndex((player) => player.id === playerId);
}

/** 随机：在能做的行动里随便挑（全下的机会小一点）。 */
const randomPolicy: Policy = (state, playerId, random) => {
	const seat = seatOf(state, playerId);
	const legal = legalActions(state, seat)!;
	const pot = state.players.reduce((sum, player) => sum + player.handBet, 0);
	const options: PokerAction[] = [];
	if (legal.canCall) options.push({ type: "fold" }, { type: "call" });
	if (legal.canCheck) options.push({ type: "check" }, { type: "check" });
	if (legal.canRaise) {
		const high = Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, state.hand.currentBet + pot));
		options.push({ type: "raise", to: legal.minRaiseTo + Math.floor(random() * (high - legal.minRaiseTo + 1)) });
	}
	if (legal.canAllIn && random() < 0.25) options.push({ type: "allIn" });
	return options[Math.floor(random() * options.length)]!;
};

/** 跟注站：能过就过，否则跟到底。 */
const stationPolicy: Policy = (state, playerId) => {
	const legal = legalActions(state, seatOf(state, playerId))!;
	if (legal.canCheck) return { type: "check" };
	return legal.canCall && state.players[seatOf(state, playerId)]!.chips > legal.toCall ? { type: "call" } : { type: "allIn" };
};

/** 老实人：只看自己的牌型，好牌加注、一般牌跟、差牌弃。 */
const simplePolicy: Policy = (state, playerId) => {
	const seat = seatOf(state, playerId);
	const legal = legalActions(state, seat)!;
	const me = state.players[seat]!;
	const hand = state.hand;
	const bb = hand.bigBlind;
	const pot = state.players.reduce((sum, player) => sum + player.handBet, 0);
	const passive = (): PokerAction => (legal.canCheck ? { type: "check" } : { type: "fold" });
	const call = (): PokerAction => (legal.canCheck ? { type: "check" } : me.chips > legal.toCall ? { type: "call" } : { type: "allIn" });
	const raise = (to: number): PokerAction =>
		legal.canRaise ? { type: "raise", to: Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, Math.round(to))) } : call();
	const [a, b] = me.holeCards;
	if (!a || !b) return passive();
	if (hand.street === "preflop") {
		const high = Math.max(a.rank, b.rank);
		const low = Math.min(a.rank, b.rank);
		const pair = a.rank === b.rank;
		if ((pair && low >= 9) || (high === 14 && low >= 12)) return raise(hand.currentBet * 3);
		if (pair || high === 14 || low >= 10 || (a.suit === b.suit && high - low === 1)) return legal.toCall <= 4 * bb ? call() : passive();
		return passive();
	}
	const value = bestHand([...me.holeCards, ...hand.board]);
	const boardTop = Math.max(...hand.board.map((card) => card.rank));
	const topPair = value.category === 1 && value.ranks[0]! >= boardTop && me.holeCards.some((card) => card.rank === value.ranks[0]);
	if (value.category >= 2 || topPair) return legal.toCall === 0 ? raise(hand.currentBet + pot / 2) : call();
	if (value.category === 1 && legal.toCall <= pot / 2) return call();
	return passive();
};

const botPolicy: Policy = (state, playerId, random) => {
	const action = botCommand(viewForPlayer(state, playerId), playerId, { random });
	if (!action) throw new Error("人机没给出行动");
	return action;
};

/** 单测用：蒙特卡洛次数少一点，跑得快。 */
const botFastPolicy: Policy = (state, playerId, random) => {
	const action = botCommand(viewForPlayer(state, playerId), playerId, { random, samples: 120 });
	if (!action) throw new Error("人机没给出行动");
	return action;
};

export const POLICIES: Record<string, Policy> = { bot: botPolicy, botFast: botFastPolicy, random: randomPolicy, station: stationPolicy, simple: simplePolicy };

export const MAX_STEPS = 40_000;

export interface MatchResult {
	winnerSeat: number;
	/** 每个座位的名次（1 = 冠军）。 */
	places: number[];
	hands: number;
	steps: number;
	problems: string[];
	botMs: number[];
}

/** 每手牌算多少毫秒（盲注每 20 分钟翻倍 → 每 40 手翻倍一次），保证比赛会结束。 */
export const HAND_MS = Number(process.env.SIM_HAND_MS ?? 30_000);

/** 打一整场淘汰赛。 */
export function playMatch(
	policies: Policy[],
	seed: number,
	options: { settings?: Partial<Settings>; timeBot?: Policy; maxHands?: number } = {},
): MatchResult {
	const random = mulberry32(seed);
	const settings: Settings = { ...DEFAULT_SETTINGS, blindIncreaseMinutes: 20, ...options.settings };
	const players = policies.map((_, index) => ({ id: `p${index}`, name: `P${index}` }));
	let now = 0;
	let state = createMatch(players, settings, now, random);
	const total = settings.startingChips * players.length;
	const problems: string[] = [];
	const botMs: number[] = [];
	let steps = 0;
	while (state.phase !== "finished") {
		if (steps > MAX_STEPS) {
			problems.push(`超过最大步数 ${MAX_STEPS}`);
			break;
		}
		if (state.phase === "handOver") {
			if (options.maxHands && state.hand.number >= options.maxHands) break;
			now += HAND_MS;
			state = startNextHand(state, now, random);
			continue;
		}
		const seat = state.hand.turn;
		if (seat === null) {
			problems.push(`没有人行动却还在下注中（第 ${state.hand.number} 手）`);
			break;
		}
		const id = state.players[seat]!.id;
		const policy = policies[seat]!;
		const started = policy === options.timeBot ? performance.now() : 0;
		const action = policy(state, id, random);
		if (policy === options.timeBot) botMs.push(performance.now() - started);
		try {
			state = applyAction(state, id, action);
		} catch (error) {
			problems.push(`座位 ${seat} 行动不合法：${JSON.stringify(action)}（${(error as Error).message}）`);
			const legal = legalActions(state, seat)!;
			state = applyAction(state, id, legal.canCheck ? { type: "check" } : { type: "fold" });
		}
		steps += 1;
		const chips = state.players.reduce((sum, player) => sum + player.chips + player.handBet, 0);
		if (state.phase === "playing" && chips !== total) problems.push(`筹码不守恒：${chips} ≠ ${total}`);
	}
	const places = state.players.map((player) => player.place ?? 1);
	if (state.phase !== "finished") {
		// 打到上限还没结束：按筹码排名。
		const order = state.players.map((player, index) => ({ index, chips: player.chips })).sort((a, b) => b.chips - a.chips);
		order.forEach(({ index }, rank) => (places[index] = state.players[index]!.place ?? rank + 1));
	}
	const winnerSeat = places.indexOf(1);
	return { winnerSeat, places, hands: state.hand.number, steps, problems, botMs };
}

export function timing(ms: number[]): { avg: number; p99: number; max: number } {
	if (ms.length === 0) return { avg: 0, p99: 0, max: 0 };
	const sorted = [...ms].sort((a, b) => a - b);
	return {
		avg: ms.reduce((sum, value) => sum + value, 0) / ms.length,
		p99: sorted[Math.floor(sorted.length * 0.99)]!,
		max: sorted[sorted.length - 1]!,
	};
}

/** 1 个 hero 对其余 villain，hero 轮流坐每个座位。 */
export function headToHead(hero: Policy, villain: Policy, games: number, seats: number, seed: number, settings?: Partial<Settings>) {
	let wins = 0;
	let placeSum = 0;
	const problems: string[] = [];
	for (let index = 0; index < games; index += 1) {
		const heroSeat = index % seats;
		const policies = Array.from({ length: seats }, (_, seat) => (seat === heroSeat ? hero : villain));
		const result = playMatch(policies, seed + index, settings ? { settings } : {});
		if (result.winnerSeat === heroSeat) wins += 1;
		placeSum += result.places[heroSeat]!;
		problems.push(...result.problems);
	}
	return { winRate: wins / games, fair: 1 / seats, avgPlace: placeSum / games, problems };
}
