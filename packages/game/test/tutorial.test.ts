import { describe, expect, it } from "vitest";
import {
	TUTORIAL_DEALER,
	TUTORIAL_RIVALS,
	TUTORIAL_SELF,
	TUTORIAL_STEPS,
	anchorVisible,
	applyTutorial,
	botCommand,
	createPracticeGame,
	createTutorialGame,
	legalActions,
	tutorialActor,
	viewForPlayer,
	type MatchState,
	type TutorialCommand,
} from "../src/index.js";
import { mulberry32 } from "./bot-harness.js";

/** 玩家在 do 步骤里真正发出的命令（加注取「½ 底池」那个数，和网页按钮一样）。 */
function playerCommand(state: MatchState, expect: TutorialCommand): TutorialCommand {
	if (expect.type !== "raise") return expect;
	const seat = state.players.findIndex((player) => player.id === TUTORIAL_SELF);
	const legal = legalActions(state, seat)!;
	const pot = state.players.reduce((sum, player) => sum + player.handBet, 0);
	const to = Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, Math.round(state.hand.currentBet + (pot + legal.toCall) * 0.5)));
	return { type: "raise", to };
}

/** 照剧本走到 stopAt（不含）为止，返回每一步之前的局面。 */
function runScript(stopAt?: string) {
	let state = createTutorialGame("新玩家");
	const before: Record<string, MatchState> = {};
	for (const step of TUTORIAL_STEPS) {
		if (step.id === stopAt) break;
		before[step.id] = state;
		if (step.anchor) expect(anchorVisible(state, step.anchor, TUTORIAL_SELF), `${step.id} 的锚点 ${step.anchor} 看得见`).toBe(true);
		if (step.kind === "do") {
			expect(tutorialActor(state), `${step.id} 轮到你`).toBe(TUTORIAL_SELF);
			state = applyTutorial(state, TUTORIAL_SELF, playerCommand(state, step.expect), { scripted: true });
		} else if (step.kind === "watch") {
			for (const move of step.moves) {
				const actor = tutorialActor(state);
				expect(actor, `${step.id} 有人行动`).not.toBeNull();
				expect(actor, `${step.id} 不是你`).not.toBe(TUTORIAL_SELF);
				state = applyTutorial(state, actor!, move, { scripted: true });
			}
		}
	}
	return { state, before };
}

describe("新手教程剧本", () => {
	it("从头走到尾：每个 do / watch 都合法，每个锚点那时都看得见", () => {
		const { state } = runScript();
		expect(state.phase).toBe("handOver");
		expect(state.players.filter((player) => player.place === null).map((player) => player.id)).toEqual([TUTORIAL_SELF, TUTORIAL_RIVALS[0].id]);
		expect(state.players[2]!.place).toBe(3);
	});

	it("关键几幕一定发生", () => {
		const { before } = runScript();
		// 开局：你是庄位，咕噜一号小盲，咕噜二号大盲，轮到你先说话。
		const start = before.goal!;
		expect([start.hand.dealerSeat, start.hand.smallBlindSeat, start.hand.bigBlindSeat]).toEqual([0, 1, 2]);
		expect(tutorialActor(start)).toBe(TUTORIAL_SELF);
		// 转牌后你是两对，摊牌时两对赢一对 9。
		expect(before.turn!.hand.board.map((card) => card.id)).toEqual(["D13", "H8", "C4", "H12"]);
		const showdown = before.showdown!.hand.result!;
		expect(showdown.uncontested).toBe(false);
		expect(showdown.pots[0]!.winnerIds).toEqual([TUTORIAL_SELF]);
		expect(showdown.revealed[TUTORIAL_SELF]!.handName).toMatch(/两对/);
		expect(showdown.revealed[TUTORIAL_RIVALS[0].id]!.handName).toMatch(/一对 9/);
		// 第 2 手你是大盲，拿到 7-2；咕噜一号不用亮牌直接赢。
		const second = before.fold!;
		expect(second.hand.number).toBe(2);
		expect(second.hand.bigBlindSeat).toBe(0);
		expect(second.players[0]!.holeCards.map((card) => card.rank).sort()).toEqual([2, 7]);
		expect(before["deal3"]!.hand.result!.uncontested).toBe(true);
		expect(before["deal3"]!.hand.result!.pots[0]!.winnerIds).toEqual([TUTORIAL_RIVALS[0].id]);
		// 第 3 手：咕噜二号全下，你一对 A 全下，他出局，你多出来的筹码退回。
		const allin = before.allin!;
		expect(allin.hand.number).toBe(3);
		expect(allin.hand.smallBlindSeat).toBe(0);
		expect(allin.players[2]!.allIn).toBe(true);
		const out = before.out!.hand.result!;
		expect(out.eliminatedIds).toEqual([TUTORIAL_RIVALS[1].id]);
		expect(out.pots.some((pot) => pot.eligibleIds.length === 1 && pot.winnerIds[0] === TUTORIAL_SELF)).toBe(true);
		expect(before.out!.players[0]!.chips).toBeGreaterThan(2000);
	});

	it("剧本本身：id 不重复，finale 只有一个且在最后，每句话都不空", () => {
		const ids = TUTORIAL_STEPS.map((step) => step.id);
		expect(new Set(ids).size).toBe(ids.length);
		const finales = TUTORIAL_STEPS.filter((step) => step.kind === "info" && step.finale);
		expect(finales).toHaveLength(1);
		expect(TUTORIAL_STEPS.at(-1)).toBe(finales[0]);
		for (const step of TUTORIAL_STEPS) expect(step.say.length).toBeGreaterThan(4);
	});

	it("剧本走到哪一步，加注数额不同也不影响后面", () => {
		// 玩家在「加注」那步选最小加注，后面照样走得通。
		let state = createTutorialGame("新玩家");
		for (const step of TUTORIAL_STEPS) {
			if (step.kind === "do") {
				const seat = state.players.findIndex((player) => player.id === TUTORIAL_SELF);
				const command = step.expect.type === "raise" ? { type: "raise" as const, to: legalActions(state, seat)!.minRaiseTo } : step.expect;
				state = applyTutorial(state, TUTORIAL_SELF, command, { scripted: true });
			} else if (step.kind === "watch") {
				for (const move of step.moves) state = applyTutorial(state, tutorialActor(state)!, move, { scripted: true });
			}
		}
		expect(state.players[2]!.place).toBe(3);
	});

	it("剧本后面的手不再摆牌；接练习局交给人机，一百多局都能打完", () => {
		const { state: end } = runScript();
		const next = applyTutorial(end, TUTORIAL_DEALER, { type: "nextHand" }, { scripted: true, random: mulberry32(1) });
		expect(next.hand.number).toBe(4);
		let stuck = 0;
		const games = [end, ...Array.from({ length: 120 }, (_, index) => createPracticeGame("新玩家", mulberry32(index + 5)))];
		games.forEach((start, index) => {
			const random = mulberry32(100 + index);
			let state = start;
			let steps = 0;
			while (state.phase !== "finished" && steps < 20_000) {
				const actor = tutorialActor(state)!;
				const command: TutorialCommand = actor === TUTORIAL_DEALER
					? { type: "nextHand" }
					: botCommand(viewForPlayer(state, actor), actor, { random, samples: 80 })!;
				state = applyTutorial(state, actor, command, { scripted: false, random });
				steps += 1;
			}
			if (state.phase !== "finished") stuck += 1;
		});
		expect(stuck).toBe(0);
	}, 60_000);
});
