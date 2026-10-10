/**
 * 德州扑克人机（只有「普通」一个难度）。
 *
 * 输入只能是这个座位自己的视角 viewForPlayer(match, playerId)：看得到自己的底牌、公共牌、
 * 各人筹码和下注，看不到别人的底牌和牌堆。
 *
 * 思路：
 * 1. 用蒙特卡洛估「摊牌时的胜率」（平分算一半）：把还没弃牌的对手的底牌、没发的公共牌随机补齐，
 *    比牌型。对手下过注 / 加过注的，按翻牌前起手牌强度把他的手牌限制在较强的一段里（粗略的范围）。
 * 2. 和底池赔率比：胜率高出「跟注要付的比例」才跟；胜率明显高于「人人平分」的份额就加注。
 * 3. 筹码不多（≤ 10 个大盲）时翻牌前只全下或弃牌；加注后剩下的筹码太少就直接全下。
 * 4. 少量诈唬：没人下注、对手不多时偶尔下注偷底池（提示模式不诈唬）。
 */
import type { Card } from "./cards.js";
import { legalActions, type MatchState, type PokerAction } from "./holdem.js";
import type { MatchView } from "./view.js";

export interface BotAdvice {
	action: PokerAction;
	/** 给玩家看的一句理由（教程「提示」用）。 */
	reason: string;
	/** 估出来的胜率 0–1。 */
	equity: number;
}

export interface BotOptions {
	random?: () => number;
	/** 提示模式：不诈唬，理由照实说。 */
	hint?: boolean;
	/** 蒙特卡洛次数（默认按人数自动定）。 */
	samples?: number;
}

// ---------- 快速牌力估值（只给人机用；规则判定仍用 hands.ts） ----------

const SUIT_INDEX: Record<string, number> = { S: 0, H: 1, D: 2, C: 3 };
/** 牌编码：rank * 4 + suit，rank 2–14。 */
export const encodeCard = (card: Card): number => card.rank * 4 + SUIT_INDEX[card.suit]!;

const counts = new Int8Array(15);
const suitMasks = new Int32Array(4);
const suitCounts = new Int8Array(4);

function straightTop(mask: number): number {
	let m = mask;
	if (m & (1 << 14)) m |= 2;
	for (let high = 14; high >= 5; high -= 1) {
		if (((m >> (high - 4)) & 31) === 31) return high;
	}
	return 0;
}

function topRanks(mask: number, n: number): number {
	let packed = 0;
	let taken = 0;
	for (let rank = 14; rank >= 2 && taken < n; rank -= 1) {
		if (mask & (1 << rank)) {
			packed = packed * 16 + rank;
			taken += 1;
		}
	}
	for (; taken < 5; taken += 1) packed *= 16;
	return packed;
}

/** 5–7 张牌（编码后）的牌力整数，越大越好；和 compareHands 的先后一致。 */
export function rankCodes(cards: ArrayLike<number>, length = cards.length): number {
	counts.fill(0);
	suitMasks.fill(0);
	suitCounts.fill(0);
	let mask = 0;
	for (let index = 0; index < length; index += 1) {
		const code = cards[index]!;
		const rank = code >> 2;
		const suit = code & 3;
		counts[rank]! += 1;
		suitMasks[suit]! |= 1 << rank;
		suitCounts[suit]! += 1;
		mask |= 1 << rank;
	}
	let flushMask = 0;
	for (let suit = 0; suit < 4; suit += 1) {
		if (suitCounts[suit]! >= 5) {
			flushMask = suitMasks[suit]!;
			const sf = straightTop(flushMask);
			if (sf) return 8 * 2 ** 20 + sf * 2 ** 16;
		}
	}
	let quad = 0;
	let trip1 = 0;
	let trip2 = 0;
	let pair1 = 0;
	let pair2 = 0;
	for (let rank = 14; rank >= 2; rank -= 1) {
		const count = counts[rank]!;
		if (count === 4) quad = rank;
		else if (count === 3) {
			if (!trip1) trip1 = rank;
			else if (!trip2) trip2 = rank;
		} else if (count === 2) {
			if (!pair1) pair1 = rank;
			else if (!pair2) pair2 = rank;
		}
	}
	if (quad) return 7 * 2 ** 20 + quad * 2 ** 16 + (topRanks(mask & ~(1 << quad), 1) >> 4);
	if (trip1 && (trip2 || pair1)) return 6 * 2 ** 20 + trip1 * 2 ** 16 + Math.max(trip2, pair1) * 2 ** 12;
	if (flushMask) return 5 * 2 ** 20 + topRanks(flushMask, 5);
	const st = straightTop(mask);
	if (st) return 4 * 2 ** 20 + st * 2 ** 16;
	if (trip1) return 3 * 2 ** 20 + trip1 * 2 ** 16 + (topRanks(mask & ~(1 << trip1), 2) >> 4);
	if (pair1 && pair2) {
		return 2 * 2 ** 20 + pair1 * 2 ** 16 + pair2 * 2 ** 12 + (topRanks(mask & ~(1 << pair1) & ~(1 << pair2), 1) >> 8);
	}
	if (pair1) return 1 * 2 ** 20 + pair1 * 2 ** 16 + (topRanks(mask & ~(1 << pair1), 3) >> 4);
	return topRanks(mask, 5);
}

// ---------- 起手牌强度（陈氏公式）和百分位 ----------

/** 陈氏公式：两张底牌的粗略强度，AA = 20，72 不同花 ≈ -1。 */
export function chenScore(rankA: number, rankB: number, suited: boolean): number {
	const high = Math.max(rankA, rankB);
	const low = Math.min(rankA, rankB);
	const points = (rank: number) => (rank === 14 ? 10 : rank === 13 ? 8 : rank === 12 ? 7 : rank === 11 ? 6 : rank / 2);
	if (high === low) return Math.max(5, points(high) * 2);
	let score = points(high);
	if (suited) score += 2;
	const gap = high - low - 1;
	score -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
	if (gap <= 1 && high < 12) score += 1;
	return Math.ceil(score);
}

/** 1326 种起手组合按陈氏分排名后的百分位：0 = 最强，1 = 最弱。下标 code1 * 64 + code2。 */
const PREFLOP_PERCENTILE = (() => {
	const combos: { key: number; score: number }[] = [];
	for (let a = 8; a < 60; a += 1) {
		for (let b = a + 1; b < 60; b += 1) {
			combos.push({ key: a * 64 + b, score: chenScore(a >> 2, b >> 2, (a & 3) === (b & 3)) });
		}
	}
	combos.sort((left, right) => right.score - left.score);
	const table = new Float32Array(64 * 64);
	let index = 0;
	while (index < combos.length) {
		let end = index;
		while (end < combos.length && combos[end]!.score === combos[index]!.score) end += 1;
		const pct = (index + end) / 2 / combos.length;
		for (let k = index; k < end; k += 1) {
			const { key } = combos[k]!;
			table[key] = pct;
			table[(key & 63) * 64 + (key >> 6)] = pct;
		}
		index = end;
	}
	return table;
})();

export const preflopPercentile = (a: number, b: number): number => PREFLOP_PERCENTILE[a * 64 + b]!;

// ---------- 蒙特卡洛胜率 ----------

/**
 * 摊牌胜率（平分算份额）。ranges[i] 是第 i 个对手手牌的百分位上限（1 = 任意两张）。
 */
export function estimateEquity(hole: number[], board: number[], ranges: number[], samples: number, random: () => number): number {
	const known = new Set([...hole, ...board]);
	const pool: number[] = [];
	for (let code = 8; code < 60; code += 1) if (!known.has(code)) pool.push(code);
	const opponents = ranges.length;
	const missing = 5 - board.length;
	const full = new Int32Array(7);
	const mine = new Int32Array(7);
	const oppCards = new Int32Array(opponents * 2);
	for (let index = 0; index < board.length; index += 1) full[index] = board[index]!;
	mine[0] = hole[0]!;
	mine[1] = hole[1]!;
	let total = 0;
	const length = pool.length;
	for (let sample = 0; sample < samples; sample += 1) {
		let pos = 0;
		const draw = () => {
			const pick = pos + Math.floor(random() * (length - pos));
			const card = pool[pick]!;
			pool[pick] = pool[pos]!;
			pool[pos] = card;
			pos += 1;
			return card;
		};
		for (let opp = 0; opp < opponents; opp += 1) {
			const limit = ranges[opp]!;
			let a = draw();
			let b = draw();
			for (let attempt = 0; limit < 1 && attempt < 24 && preflopPercentile(a, b) > limit; attempt += 1) {
				pos -= 2;
				a = draw();
				b = draw();
			}
			oppCards[opp * 2] = a;
			oppCards[opp * 2 + 1] = b;
		}
		for (let index = 0; index < missing; index += 1) full[board.length + index] = draw();
		for (let index = 0; index < 5; index += 1) mine[index + 2] = full[index]!;
		const myRank = rankCodes(mine, 7);
		let best = true;
		let ties = 0;
		for (let opp = 0; opp < opponents && best; opp += 1) {
			full[5] = oppCards[opp * 2]!;
			full[6] = oppCards[opp * 2 + 1]!;
			const rank = rankCodes(full, 7);
			if (rank > myRank) best = false;
			else if (rank === myRank) ties += 1;
		}
		if (best) total += 1 / (ties + 1);
	}
	return total / samples;
}

// ---------- 决策 ----------

/** 押上整手筹码跟注时，胜率要比赔率多出的把握（对紧的对手 0.5，对很松的对手减半）。 */
const RISK = 0.5;
const FLOOR = 0.5;

const pct = (value: number) => `${Math.round(value * 100)}%`;

function roundTo(value: number, unit: number): number {
	return Math.round(value / unit) * unit;
}

function assertRedacted(view: MatchView): void {
	if ("deck" in (view.hand as object)) throw new Error("人机只能看自己的视角（viewForPlayer 之后的状态）。");
}

/** 人机这一步该怎么做；不是它行动时返回 null。 */
export function botAdvice(view: MatchView, playerId: string, options: BotOptions = {}): BotAdvice | null {
	assertRedacted(view);
	const random = options.random ?? Math.random;
	const seat = view.players.findIndex((player) => player.id === playerId);
	if (seat < 0 || view.phase !== "playing" || view.hand.turn !== seat) return null;
	const legal = legalActions(view as unknown as MatchState, seat);
	if (!legal) return null;
	const me = view.players[seat]!;
	const hand = view.hand;
	const bb = hand.bigBlind;
	const preflop = hand.street === "preflop";

	const opponents = view.players
		.map((player, index) => ({ player, index }))
		.filter(({ player, index }) => index !== seat && player.inHand && !player.folded);
	// 对手松紧：这场比赛里他加注的比例（桌上人人看得见）。爱加注的人加注时手牌不一定好。
	const aggression = (player: MatchView["players"][number]) => (player.stats.raises + 1) / (player.stats.actions + 6);
	const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
	// 对手范围：这一轮加过注/下过注的，限制在强的一段（越爱加注的人放得越宽）；翻牌后还在的，去掉最差的一截。
	const ranges = opponents.map(({ player, index }) => {
		const record = hand.actions[index];
		const aggressive = record && (record.type === "raise" || record.type === "bet" || (record.type === "allIn" && record.amount > bb));
		const af = aggression(player);
		if (aggressive) return preflop ? clamp(0.4 + (af - 0.2) * 3, 0.25, 1) : clamp(0.6 + (af - 0.2) * 2.5, 0.4, 1);
		return preflop ? 1 : 0.85;
	});
	const samples = options.samples ?? (opponents.length >= 4 ? 1000 : opponents.length >= 2 ? 1300 : 1600);
	const hole = me.holeCards.map(encodeCard);
	const board = hand.board.map(encodeCard);
	const equity = hole.length === 2 ? estimateEquity(hole, board, ranges, samples, random) : 0;

	const pot = view.players.reduce((sum, player) => sum + player.handBet, 0);
	const toCall = legal.toCall;
	const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;
	// 跟注要押上一大截筹码时多要一点把握：人机平均打得比对手好，少冒被淘汰的险更划算。
	// 对手越爱乱加注，越不用怕他。
	const bettor = opponents.reduce<MatchView["players"][number] | null>((best, { player }) => (!best || player.streetBet > best.streetBet ? player : best), null);
	const tight = bettor ? clamp(1 - (aggression(bettor) - 0.15) * 4, 0, 1) : 1;
	const riskPremium = RISK * (FLOOR + (1 - FLOOR) * tight) * Math.min(1, toCall / Math.max(1, me.chips));
	// 对手几乎不弃牌时，诈唬没用。
	const foldRate = Math.min(...opponents.map(({ player }) => (player.stats.folds + 1) / (player.stats.actions + 4)));
	const fair = 1 / (opponents.length + 1);
	const strength = equity / fair;
	const stack = me.chips;
	// 有效筹码：自己和对手里最多的那个比，取小。
	const biggestOpponent = Math.max(0, ...opponents.map(({ player }) => player.chips + player.streetBet));
	const effective = Math.min(stack + me.streetBet, biggestOpponent);
	const eq = pct(equity);

	const fold = (why: string): BotAdvice =>
		legal.canCheck ? { action: { type: "check" }, reason: `${why}，不花钱就过牌`, equity } : { action: { type: "fold" }, reason: `${why}，弃牌`, equity };
	const call = (why: string): BotAdvice => {
		if (legal.canCheck) return { action: { type: "check" }, reason: `${why}，过牌`, equity };
		if (toCall >= stack) return { action: { type: "allIn" }, reason: `${why}，筹码不够跟，全下跟注`, equity };
		return { action: { type: "call" }, reason: `${why}，跟注 ${toCall}`, equity };
	};
	const raise = (target: number, why: string): BotAdvice => {
		if (!legal.canRaise) return call(why);
		let to = Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, roundTo(target, hand.smallBlind)));
		// 加完剩下的筹码不到底池的三分之一，不如直接全下。
		const left = legal.maxRaiseTo - to;
		if (left < (pot + to - me.streetBet) * 0.35) to = legal.maxRaiseTo;
		if (to >= legal.maxRaiseTo) return { action: { type: "allIn" }, reason: `${why}，全下 ${legal.maxRaiseTo}`, equity };
		const verb = hand.currentBet === 0 ? "下注" : "加注到";
		return { action: { type: "raise", to }, reason: `${why}，${verb} ${to}`, equity };
	};
	const shove = (why: string): BotAdvice =>
		legal.canAllIn ? { action: { type: "allIn" }, reason: `${why}，全下`, equity } : call(why);

	if (hole.length !== 2) return fold("没有底牌");

	if (preflop) {
		const myPct = preflopPercentile(hole[0]!, hole[1]!);
		const raisedPot = hand.currentBet > bb;
		// 短筹码：只全下或弃牌。
		if (effective <= 10 * bb) {
			const need = raisedPot ? 1.25 : opponents.length >= 3 ? 1.35 : 1.1;
			if (strength >= need || equity > potOdds + 0.05 + riskPremium && toCall >= stack * 0.5) return shove(`筹码只剩 ${Math.round(stack / bb)} 个大盲，起手牌够好（胜率约 ${eq}）`);
			if (legal.canCheck) return { action: { type: "check" }, reason: `筹码不多、牌一般，免费看翻牌`, equity };
			if (toCall <= bb / 2 && equity > potOdds) return call(`只差半个大盲，胜率约 ${eq}`);
			return fold(`筹码只剩 ${Math.round(stack / bb)} 个大盲，这手牌（胜率约 ${eq}）不值得拼`);
		}
		if (!raisedPot) {
			// 没人加注：好牌主动加注，中等牌便宜就跟，坐在后面位置可以放宽一点。
			const late = seat === hand.dealerSeat || seat === hand.smallBlindSeat;
			const limpers = view.players.filter((player, index) => index !== seat && player.streetBet === bb && hand.actions[index]?.type === "call").length;
			// 人越少，能玩的牌越多：单挑时大半的牌都值得打。
			const heads = opponents.length;
			const openLimit = heads === 1 ? 0.6 : heads === 2 ? 0.4 : late && limpers === 0 ? 0.32 : 0.2;
			const limpLimit = heads === 1 ? 0.85 : heads === 2 ? 0.6 : 0.45;
			if (myPct <= openLimit || strength >= 1.6) {
				return raise(bb * 3 + limpers * bb, `起手牌在前 ${Math.max(1, Math.round(myPct * 100))}%（胜率约 ${eq}），主动加注`);
			}
			if (legal.canCheck) return { action: { type: "check" }, reason: `起手牌一般（胜率约 ${eq}），大盲位免费看翻牌，过牌`, equity };
			if (myPct <= limpLimit && equity > potOdds * 1.15) return call(`起手牌还可以（胜率约 ${eq}），跟注只要 ${toCall}`);
			return fold(`起手牌偏弱（胜率约 ${eq}）`);
		}
		// 有人加过注。
		if ((strength >= 2.1 || myPct <= 0.035) && equity > potOdds + riskPremium) {
			return raise(hand.currentBet * 3, `起手牌非常强（胜率约 ${eq}），再加注`);
		}
		if (equity > potOdds * 1.2 + 0.02 + riskPremium && (myPct <= (opponents.length === 1 ? 0.65 : 0.4) || toCall <= 2 * bb)) {
			return call(`对手加注了，我的胜率约 ${eq}，跟注要付底池的 ${pct(potOdds)}，划算`);
		}
		return fold(`对手加注了，我的胜率约 ${eq}，跟注要付底池的 ${pct(potOdds)}，不划算`);
	}

	// 翻牌后。
	const street = hand.street === "flop" ? "翻牌" : hand.street === "turn" ? "转牌" : "河牌";
	const river = hand.street === "river";
	if (strength >= (opponents.length === 1 ? 1.45 : 1.75) && equity >= 0.55) {
		const size = strength >= 1.8 ? 0.9 : 0.6;
		const target = toCall > 0 ? hand.currentBet * 2.5 + pot * 0.3 : (pot * size);
		if (toCall === 0 || equity >= Math.max(0.62, potOdds + 0.04 + riskPremium)) return raise(Math.max(target, bb), `${street}后牌很强（胜率约 ${eq}），要多赢一点`);
	}
	if (toCall === 0) {
		// 没人下注。
		if (strength >= 1.2 && equity >= 0.5 && !river) return raise(Math.max(pot * 0.5, bb), `胜率约 ${eq}，比对手好，下注`);
		const bluff = Math.max(legal.minRaiseTo, roundTo(Math.max(pot * 0.5, bb), hand.smallBlind));
		// 诈唬只用小注，不拿全部筹码去偷。
		if (!options.hint && opponents.length <= 2 && legal.canRaise && bluff < legal.maxRaiseTo * 0.5 && foldRate >= 0.2 && random() < (river ? 0.07 : 0.12)) {
			return { action: { type: "raise", to: bluff }, reason: `没人下注，试着下注 ${bluff} 偷底池`, equity };
		}
		return { action: { type: "check" }, reason: `胜率约 ${eq}，没人下注，过牌看下一张`, equity };
	}
	// 面对下注：胜率要比赔率高一点才跟（后面可能还要再付钱）。
	const margin = river ? 0.01 : 0.04;
	if (equity > potOdds + margin + riskPremium) return call(`胜率约 ${eq}，跟注要付底池的 ${pct(potOdds)}，划算`);
	return fold(`胜率约 ${eq}，跟注要付底池的 ${pct(potOdds)}，不划算`);
}

/** 人机这一步的行动；不是它行动时返回 null。 */
export function botCommand(view: MatchView, playerId: string, options: BotOptions = {}): PokerAction | null {
	return botAdvice(view, playerId, options)?.action ?? null;
}

