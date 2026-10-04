import { describe, expect, it } from "vitest";
import { bestHand, compareHands, describeHand, type Card } from "../src/index.js";

/** "As" 黑桃 A、"Td" 方块 10、"9h" 红桃 9。 */
function cards(text: string): Card[] {
	return text.split(" ").map((spec) => {
		const rank = ({ T: 10, J: 11, Q: 12, K: 13, A: 14 } as Record<string, number>)[spec[0]!] ?? Number(spec[0]);
		const suit = spec[1]!.toUpperCase() as Card["suit"];
		return { id: spec, rank, suit };
	});
}

const name = (text: string) => describeHand(bestHand(cards(text)));
const compare = (left: string, right: string) => Math.sign(compareHands(bestHand(cards(left)), bestHand(cards(right))));

describe("hand ranking", () => {
	it("recognises every category from seven cards", () => {
		expect(name("As Ks Qs Js Ts 2d 3c")).toBe("皇家同花顺");
		expect(name("9h 8h 7h 6h 5h Ad Ac")).toBe("同花顺 9 高");
		expect(name("7s 7h 7d 7c Kd 2c 3s")).toBe("四条 7");
		expect(name("Qs Qh Qd 7c 7d 2c 3s")).toBe("葫芦 Q 带 7");
		expect(name("As 9s 7s 4s 2s Kd Qc")).toBe("同花 A 高");
		expect(name("9d 8c 7h 6s 5d Ac Kc")).toBe("顺子 9 高");
		expect(name("5s 5h 5d Ac Kd 9c 2s")).toBe("三条 5");
		expect(name("Js Jh 4d 4c Ad 9c 2s")).toBe("两对 J 和 4");
		expect(name("Ts Th Ad 8c 6d 4c 2s")).toBe("一对 10");
		expect(name("As Jh 9d 7c 5d 3c 2s")).toBe("高牌 A");
	});

	it("treats A-2-3-4-5 as the lowest straight", () => {
		expect(name("As 2d 3h 4c 5s Kd 9h")).toBe("顺子 5 高");
		expect(compare("As 2d 3h 4c 5s Kd 9h", "2s 3d 4h 5c 6s Kd 9h")).toBe(-1);
		expect(compare("Ts Jd Qh Kc As 2d 3h", "9s Td Jh Qc Ks 2d 3h")).toBe(1);
	});

	it("compares kickers, second pairs and full houses correctly", () => {
		expect(compare("Ks Kh Ad 7c 5d 3c 2s", "Kd Kc Qd 7h 5h 3d 2d")).toBe(1);
		expect(compare("Js Jh 4d 4c Ad 9c 2s", "Jd Jc 4h 4s Kd 9h 2h")).toBe(1);
		expect(compare("Js Jh 5d 5c 2d 9c 3s", "Jd Jc 4h 4s Ad 9h 2h")).toBe(1);
		expect(compare("8s 8h 8d 2c 2d 9c 3s", "7d 7c 7h As Ad 9h 2h")).toBe(1);
		expect(compare("As Ks 9s 4s 2s 3d 5c", "Ad Kd 9d 4d 3d 6c 7h")).toBe(-1);
	});

	it("prefers a straight flush over a plain flush in the same seven cards", () => {
		const value = bestHand(cards("2h 3h 4h 5h 6h Ah Kh"));
		expect(describeHand(value)).toBe("同花顺 6 高");
		expect(value.cards.map((card) => card.rank)).toEqual([6, 5, 4, 3, 2]);
	});

	it("ties when the board plays for both players", () => {
		expect(compare("2c 3d As Ks Qs Js Ts", "4c 5d As Ks Qs Js Ts")).toBe(0);
		expect(compare("2c 3d 9s 9h 9d 9c Ks", "4c Qd 9s 9h 9d 9c Ks")).toBe(0);
	});
});
