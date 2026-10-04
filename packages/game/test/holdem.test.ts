import { describe, expect, it } from "vitest";
import {
	DEFAULT_SETTINGS,
	applyAction,
	blindsAt,
	createMatch,
	legalActions,
	startNextHand,
	timeoutAction,
	viewForPlayer,
	type Card,
	type MatchState,
	type PokerAction,
	type Settings,
} from "../src/index.js";

const zero = () => 0;
const ids = ["p0", "p1", "p2", "p3", "p4", "p5"];

function card(spec: string): Card {
	const rank = ({ T: 10, J: 11, Q: 12, K: 13, A: 14 } as Record<string, number>)[spec[0]!] ?? Number(spec[0]);
	return { id: spec, rank, suit: spec[1]!.toUpperCase() as Card["suit"] };
}

/** 建一桌：第一手庄位固定在 0 号座位。 */
function table(count: number, settings: Partial<Settings> = {}): MatchState {
	return createMatch(ids.slice(0, count).map((id) => ({ id, name: id.toUpperCase() })), { ...DEFAULT_SETTINGS, ...settings }, 0, zero);
}

/** 指定底牌和五张公共牌（公共牌按翻牌、转牌、河牌的顺序从牌堆末尾发出）。 */
function rig(state: MatchState, holes: string[], board: string): MatchState {
	holes.forEach((hole, seat) => {
		if (hole) state.players[seat]!.holeCards = hole.split(" ").map(card);
	});
	const boardCards = board.split(" ").map(card);
	const used = new Set([...holes.join(" ").split(" "), ...board.split(" ")]);
	const filler = state.hand.deck.filter((entry) => !used.has(entry.id));
	state.hand.deck = [...filler, boardCards[4]!, boardCards[3]!, boardCards[2]!, boardCards[1]!, boardCards[0]!];
	return state;
}

function act(state: MatchState, seat: number, action: PokerAction): MatchState {
	return applyAction(state, ids[seat]!, action);
}

const chips = (state: MatchState) => state.players.map((player) => player.chips);

describe("blinds and action order", () => {
	it("has the dealer post the small blind and act first preflop when heads-up, then act last after the flop", () => {
		let state = table(2);
		expect(state.hand).toMatchObject({ dealerSeat: 0, smallBlindSeat: 0, bigBlindSeat: 1, turn: 0, currentBet: 20 });
		expect(chips(state)).toEqual([990, 980]);
		state = act(state, 0, { type: "call" });
		expect(state.hand.turn).toBe(1);
		state = act(state, 1, { type: "check" });
		expect(state.hand.street).toBe("flop");
		expect(state.hand.board).toHaveLength(3);
		expect(state.hand.turn).toBe(1);
	});

	it("starts preflop left of the big blind and postflop left of the dealer with three players", () => {
		let state = table(3);
		expect(state.hand).toMatchObject({ dealerSeat: 0, smallBlindSeat: 1, bigBlindSeat: 2, turn: 0 });
		expect(() => act(state, 0, { type: "raise", to: 30 })).toThrow("最少要加到 40");
		state = act(state, 0, { type: "raise", to: 60 });
		expect(legalActions(state, 1)?.minRaiseTo).toBe(100);
		state = act(state, 1, { type: "fold" });
		state = act(state, 2, { type: "call" });
		expect(state.hand.street).toBe("flop");
		expect(state.hand.turn).toBe(2);
		expect(() => act(state, 2, { type: "raise", to: 10 })).toThrow("最少要加到 20");
	});

	it("gives the big blind the option to raise when everyone limps", () => {
		let state = table(3);
		state = act(state, 0, { type: "call" });
		state = act(state, 1, { type: "call" });
		expect(state.hand.turn).toBe(2);
		expect(legalActions(state, 2)).toMatchObject({ canCheck: true, canRaise: true });
	});
});

describe("raising rules", () => {
	it("does not reopen raising after an all-in that is less than a full raise", () => {
		let state = table(3);
		state.players[1]!.chips = 120; // 小盲总共只有 130
		state = act(state, 0, { type: "raise", to: 100 });
		state = act(state, 1, { type: "allIn" });
		expect(state.hand.currentBet).toBe(130);
		state = act(state, 2, { type: "call" });
		expect(state.hand.turn).toBe(0);
		expect(legalActions(state, 0)).toMatchObject({ canRaise: false, canCall: true, toCall: 30 });
		expect(() => act(state, 0, { type: "raise", to: 300 })).toThrow("不能加注");
		state = act(state, 0, { type: "call" });
		expect(state.hand.street).toBe("flop");
	});

	it("reopens raising after a full raise, even an all-in one", () => {
		let state = table(3);
		state.players[1]!.chips = 190; // 小盲全下到 200，比加到 100 多出 100，是完整加注
		state = act(state, 0, { type: "raise", to: 100 });
		state = act(state, 1, { type: "allIn" });
		state = act(state, 2, { type: "call" });
		expect(legalActions(state, 0)).toMatchObject({ canRaise: true, minRaiseTo: 300 });
	});

	it("only lets a player call when everyone else is already all in", () => {
		let state = table(2);
		state.players[1]!.chips = 100;
		state = act(state, 0, { type: "raise", to: 400 });
		expect(legalActions(state, 1)).toMatchObject({ canRaise: false, canAllIn: true, toCall: 380 });
	});
});

describe("showdown and pots", () => {
	it("splits side pots between the right players", () => {
		let state = rig(table(3), ["Ah Ad", "Kh Kd", "Qh Qd"], "2c 7s 9d Jc 3h");
		state.players[0]!.chips = 100; // 0 号总共 100
		state.players[1]!.chips = 290; // 1 号小盲，总共 300
		state = act(state, 0, { type: "allIn" });
		state = act(state, 1, { type: "allIn" });
		state = act(state, 2, { type: "call" });
		expect(state.hand.board).toHaveLength(5);
		const pots = state.hand.result!.pots;
		expect(pots.map((pot) => [pot.amount, pot.winnerIds])).toEqual([[300, ["p0"]], [400, ["p1"]]]);
		expect(chips(state)).toEqual([300, 400, 700]);
	});

	it("returns an uncalled bet to the player who made it", () => {
		let state = rig(table(2), ["2c 7d", "Ah Ad"], "3s 8h 9c Jd Kh");
		state.players[1]!.chips = 80; // 大盲总共 100
		state = act(state, 0, { type: "raise", to: 500 });
		state = act(state, 1, { type: "call" });
		expect(state.hand.result!.pots.map((pot) => [pot.amount, pot.winnerIds])).toEqual([[200, ["p1"]], [400, ["p0"]]]);
		expect(chips(state)).toEqual([900, 200]);
	});

	it("gives the odd chip to the first winner left of the dealer", () => {
		let state = rig(table(3, { smallBlind: 5, bigBlind: 10 }), ["2c 3d", "4c 5d", "6c 7d"], "As Ks Qs Js Ts");
		state = act(state, 0, { type: "allIn" });
		state = act(state, 1, { type: "fold" });
		state = act(state, 2, { type: "call" });
		expect(state.hand.result!.pots[0]).toMatchObject({ amount: 2005, winnerIds: ["p0", "p2"], shares: { p2: 1003, p0: 1002 } });
	});

	it("awards the pot without a showdown when everyone else folds", () => {
		let state = table(3);
		state = act(state, 0, { type: "fold" });
		state = act(state, 1, { type: "fold" });
		expect(state.phase).toBe("handOver");
		expect(state.hand.result).toMatchObject({ uncontested: true, revealed: {} });
		expect(chips(state)).toEqual([1000, 990, 1010]);
		const next = startNextHand(state, 1000, zero);
		expect(next.hand).toMatchObject({ number: 2, dealerSeat: 1, smallBlindSeat: 2, bigBlindSeat: 0, turn: 1 });
	});
});

describe("elimination and blinds", () => {
	it("ranks players busted in the same hand by their chips at the start of that hand", () => {
		let state = rig(table(3), ["Ah Ad", "2c 7d", "3c 8d"], "Ks Qh 9c 5d 4h");
		state.players[1]!.chips = 290; // 1 号开始时 300
		state.players[2]!.chips = 480; // 2 号开始时 500
		state = act(state, 0, { type: "allIn" });
		state = act(state, 1, { type: "allIn" });
		state = act(state, 2, { type: "allIn" });
		expect(state.phase).toBe("finished");
		expect(state.winnerId).toBe("p0");
		expect(state.players.map((player) => player.place)).toEqual([1, 3, 2]);
	});

	it("doubles the blinds on schedule from the next hand", () => {
		const settings = { ...DEFAULT_SETTINGS, blindIncreaseMinutes: 10 as const };
		expect(blindsAt(settings, 0, 25 * 60_000)).toEqual({ level: 2, smallBlind: 40, bigBlind: 80 });
		let state = table(2, { blindIncreaseMinutes: 10 });
		state = act(state, 0, { type: "fold" });
		const next = startNextHand(state, 11 * 60_000, zero);
		expect(next.hand).toMatchObject({ level: 1, smallBlind: 20, bigBlind: 40, currentBet: 40 });
	});

	it("checks when possible and folds otherwise on timeout", () => {
		let state = table(3);
		expect(timeoutAction(state)).toEqual({ playerId: "p0", action: { type: "fold" } });
		state = act(state, 0, { type: "call" });
		state = act(state, 1, { type: "call" });
		expect(timeoutAction(state)).toEqual({ playerId: "p2", action: { type: "check" } });
	});
});

describe("viewForPlayer", () => {
	it("hides other hole cards and the deck until showdown", () => {
		let state = rig(table(2), ["Ah Ad", "Kh Kd"], "2c 7s 9d Jc 3h");
		const before = viewForPlayer(state, "p1");
		expect(before.mySeat).toBe(1);
		expect(before.players[0]!.holeCards).toEqual([]);
		expect(before.players[0]!.hasCards).toBe(true);
		expect(before.players[1]!.holeCards.map((entry) => entry.id)).toEqual(["Kh", "Kd"]);
		expect(JSON.stringify(before)).not.toContain('"Ah"');
		expect("deck" in before.hand).toBe(false);
		state = act(state, 0, { type: "allIn" });
		state = act(state, 1, { type: "call" });
		const after = viewForPlayer(state, "p1");
		expect(after.players[0]!.holeCards.map((entry) => entry.id)).toEqual(["Ah", "Ad"]);
		expect(after.hand.result?.revealed.p0?.handName).toBe("一对 A");
	});
});
