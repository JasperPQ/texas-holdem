import { describe, expect, it } from "vitest";
import {
	DEFAULT_SETTINGS,
	applyAction,
	bestHand,
	botAdvice,
	botCommand,
	compareHands,
	createDeck,
	createMatch,
	encodeCard,
	estimateEquity,
	rankCodes,
	shuffle,
	viewForPlayer,
	type Card,
	type MatchState,
	type MatchView,
} from "../src/index.js";
import { POLICIES, mulberry32, playMatch } from "./bot-harness.js";

function card(spec: string): Card {
	const rank = ({ T: 10, J: 11, Q: 12, K: 13, A: 14 } as Record<string, number>)[spec[0]!] ?? Number(spec[0]);
	return { id: `${spec[1]!.toUpperCase()}${rank}`, rank, suit: spec[1]!.toUpperCase() as Card["suit"] };
}
const cards = (specs: string) => specs.split(" ").map(card);
const codes = (specs: string) => cards(specs).map(encodeCard);

/** 两人桌（0 号庄位 = 小盲），按需改底牌、公共牌、街。 */
function headsUp(holes: [string, string], options: { board?: string; street?: MatchState["hand"]["street"] } = {}): MatchState {
	const state = createMatch([{ id: "a", name: "A" }, { id: "b", name: "B" }], DEFAULT_SETTINGS, 0, () => 0);
	state.players[0]!.holeCards = cards(holes[0]);
	state.players[1]!.holeCards = cards(holes[1]);
	if (options.board) state.hand.board = cards(options.board);
	if (options.street) state.hand.street = options.street;
	return state;
}

const seeded = (seed = 1) => ({ random: mulberry32(seed) });

describe("人机：快速牌力估值", () => {
	it("和规则用的 bestHand 比大小完全一致（随机 3000 对 + 各种牌型）", () => {
		const random = mulberry32(42);
		for (let index = 0; index < 3000; index += 1) {
			const deck = shuffle(createDeck(), random);
			const left = deck.slice(0, 7);
			const right = deck.slice(7, 14);
			expect(Math.sign(rankCodes(left.map(encodeCard)) - rankCodes(right.map(encodeCard)))).toBe(Math.sign(compareHands(bestHand(left), bestHand(right))));
		}
		const ladder = [
			"2s 4h 6d 8c Tc Qd 3h", // 高牌
			"As Ah 2d 5c 7h 9s Jd", // 一对
			"Ks Kh 2d 2c 7h 9s Jd", // 两对
			"Qs Qh Qd 5c 7h 9s 2d", // 三条
			"As 2h 3d 4c 5h 9s Jd", // 最小顺子
			"6s 7h 8d 9c Th 2s 3d", // 顺子
			"2h 5h 7h 9h Jh As Kd", // 同花
			"3s 3h 3d 2c 2h 9s Jd", // 葫芦
			"9s 9h 9d 9c 2h 4s 6d", // 四条
			"As 2s 3s 4s 5s Kd Qd", // 最小同花顺
			"Ts Js Qs Ks As 2d 3d", // 皇家同花顺
		];
		for (let index = 1; index < ladder.length; index += 1) {
			expect(rankCodes(codes(ladder[index]!))).toBeGreaterThan(rankCodes(codes(ladder[index - 1]!)));
		}
		// 两个三条 = 葫芦（大三条带小三条当对子）；三对只取最大两对 + 最大踢脚。
		expect(rankCodes(codes("8s 8h 8d 5c 5h 5s 2d"))).toBeGreaterThan(rankCodes(codes("8s 8h 8d 4c 4h As 2d")));
		expect(rankCodes(codes("Ks Kh 7d 7c 3h 3s 2d"))).toBe(rankCodes(codes("Ks Kh 7d 7c 2h 3s 3d")));
	});

	it("胜率估计：AA 对一手随机牌约 85%，同花听牌在翻牌约 35% 以上", () => {
		const aces = estimateEquity(codes("As Ah"), [], [1], 4000, mulberry32(3));
		expect(aces).toBeGreaterThan(0.82);
		expect(aces).toBeLessThan(0.88);
		const draw = estimateEquity(codes("Ah 5h"), codes("Kh 9h 2c"), [1], 4000, mulberry32(4));
		expect(draw).toBeGreaterThan(0.45);
		// 对手范围收紧后，同一手牌的胜率下降。
		const tight = estimateEquity(codes("Ts 9s"), [], [0.15], 4000, mulberry32(5));
		expect(tight).toBeLessThan(estimateEquity(codes("Ts 9s"), [], [1], 4000, mulberry32(5)));
	});
});

describe("人机：只看自己的视角", () => {
	it("拿到带牌堆的完整状态直接报错；视角里没有对手底牌", () => {
		const state = headsUp(["As Ah", "7c 2d"]);
		expect(() => botCommand(state as unknown as MatchView, "a")).toThrow(/视角/);
		const view = viewForPlayer(state, "a");
		expect(view.players[1]!.holeCards).toEqual([]);
		expect("deck" in view.hand).toBe(false);
		expect(botCommand(view, "a", seeded())).not.toBeNull();
	});

	it("对手的底牌换成什么都不影响人机的决定（同一随机数）", () => {
		const one = headsUp(["Ks Qs", "7c 2d"]);
		const two = headsUp(["Ks Qs", "Ad Ac"]);
		expect(botAdvice(viewForPlayer(one, "a"), "a", seeded(9))).toEqual(botAdvice(viewForPlayer(two, "a"), "a", seeded(9)));
	});

	it("不是它行动时返回 null", () => {
		const state = headsUp(["As Ah", "7c 2d"]);
		expect(botCommand(viewForPlayer(state, "b"), "b", seeded())).toBeNull();
	});
});

describe("人机：关键决策", () => {
	it("AA 在翻牌前主动加注；理由里说了胜率", () => {
		const advice = botAdvice(viewForPlayer(headsUp(["As Ah", "7c 2d"]), "a"), "a", seeded())!;
		expect(["raise", "allIn"]).toContain(advice.action.type);
		expect(advice.reason).toMatch(/胜率约 \d+%/);
	});

	it("72 不同花面对全下：弃牌", () => {
		let state = createMatch([{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }], DEFAULT_SETTINGS, 0, () => 0);
		// 三人桌 0 号庄位，1 号小盲，2 号大盲；0 号先行动 → 全下，轮到 1 号。
		state.players[1]!.holeCards = cards("7c 2d");
		state = applyAction(state, "a", { type: "allIn" });
		const advice = botAdvice(viewForPlayer(state, "b"), "b", seeded())!;
		expect(advice.action).toEqual({ type: "fold" });
		expect(advice.reason).toMatch(/不划算|不值得/);
	});

	it("河牌拿着同花顺坚果：下注或加注，不会过牌放走", () => {
		const state = headsUp(["9h 8h", "Ac Ad"], { board: "Th Jh Qh 2c 3d", street: "river" });
		// 翻牌后大盲（1 号）先行动，让 1 号过牌后轮到 0 号。
		state.hand.currentBet = 0;
		state.hand.minRaise = 20;
		for (const player of state.players) player.streetBet = 0;
		state.hand.actions = [null, { type: "check", amount: 0 }];
		state.players[1]!.actedAt = 0;
		state.hand.turn = 0;
		const advice = botAdvice(viewForPlayer(state, "a"), "a", seeded())!;
		expect(["raise", "allIn"]).toContain(advice.action.type);
	});

	it("翻牌后一无所有、没人下注、提示模式：过牌而不是诈唬", () => {
		const state = headsUp(["7c 2d", "Ac Ad"], { board: "Kh Qs 9h", street: "flop" });
		state.hand.currentBet = 0;
		for (const player of state.players) player.streetBet = 0;
		state.hand.actions = [null, { type: "check", amount: 0 }];
		state.players[1]!.actedAt = 0;
		state.hand.turn = 0;
		for (let seed = 1; seed <= 20; seed += 1) {
			expect(botAdvice(viewForPlayer(state, "a"), "a", { random: mulberry32(seed), hint: true })!.action).toEqual({ type: "check" });
		}
	});

	it("诈唬只用小注，不会拿全部筹码去偷", () => {
		const state = headsUp(["7c 2d", "Ac Ad"], { board: "Kh Qs 9h", street: "flop" });
		state.hand.currentBet = 0;
		for (const player of state.players) player.streetBet = 0;
		state.hand.actions = [null, { type: "check", amount: 0 }];
		state.players[1]!.actedAt = 0;
		state.hand.turn = 0;
		for (let seed = 1; seed <= 60; seed += 1) {
			const action = botCommand(viewForPlayer(state, "a"), "a", { random: mulberry32(seed) })!;
			expect(action.type).not.toBe("allIn");
			if (action.type === "raise") expect(action.to).toBeLessThan(state.players[0]!.chips / 2);
		}
	});
});

describe("人机：自对弈", () => {
	it.each([2, 3, 4, 5, 6])("%i 人：全是人机打 50 场淘汰赛，每一步都合法、筹码守恒、不会死循环", (seats) => {
		for (let index = 0; index < 50; index += 1) {
			const result = playMatch(Array.from({ length: seats }, () => POLICIES.botFast!), 900 + seats * 100 + index, {
				settings: { blindIncreaseMinutes: 10 },
			});
			expect(result.problems).toEqual([]);
			expect(result.winnerSeat).toBeGreaterThanOrEqual(0);
			expect([...result.places].sort()).toEqual(Array.from({ length: seats }, (_, place) => place + 1));
		}
	}, 60_000);
});
