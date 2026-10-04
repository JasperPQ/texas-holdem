import { rankLabel, type Card } from "./cards.js";

export const HAND_CATEGORY_NAMES = ["高牌", "一对", "两对", "三条", "顺子", "同花", "葫芦", "四条", "同花顺"] as const;

/** category 越大越好；ranks 是同牌型时依次比较的点数。cards 为组成牌型的五张牌。 */
export interface HandValue {
	readonly category: number;
	readonly ranks: number[];
	readonly cards: Card[];
}

export function compareHands(left: HandValue, right: HandValue): number {
	if (left.category !== right.category) return left.category - right.category;
	for (let index = 0; index < Math.max(left.ranks.length, right.ranks.length); index += 1) {
		const difference = (left.ranks[index] ?? 0) - (right.ranks[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

/** 五张牌的最高顺子点数；A-2-3-4-5 记为 5；不是顺子返回 0。 */
function straightHigh(ranks: number[]): number {
	const unique = [...new Set(ranks)].sort((left, right) => right - left);
	if (unique.length !== 5) return 0;
	if (unique[0]! - unique[4]! === 4) return unique[0]!;
	if (unique.join(",") === "14,5,4,3,2") return 5;
	return 0;
}

export function evaluateFive(cards: Card[]): HandValue {
	const sorted = [...cards].sort((left, right) => right.rank - left.rank);
	const ranks = sorted.map((card) => card.rank);
	const flush = sorted.every((card) => card.suit === sorted[0]!.suit);
	const high = straightHigh(ranks);
	// 按「张数多、点数大」排序的分组，例如葫芦为 [三张, 两张]。
	const counts = new Map<number, number>();
	for (const rank of ranks) counts.set(rank, (counts.get(rank) ?? 0) + 1);
	const groups = [...counts].sort((left, right) => right[1] - left[1] || right[0] - left[0]);
	const groupRanks = groups.map(([rank]) => rank);
	const shape = groups.map(([, count]) => count).join("");
	const ordered = groupRanks.flatMap((rank) => sorted.filter((card) => card.rank === rank));
	const straightCards = high === 5 ? [...sorted.slice(1), sorted[0]!] : sorted;

	if (flush && high) return { category: 8, ranks: [high], cards: straightCards };
	if (shape === "41") return { category: 7, ranks: groupRanks, cards: ordered };
	if (shape === "32") return { category: 6, ranks: groupRanks, cards: ordered };
	if (flush) return { category: 5, ranks, cards: sorted };
	if (high) return { category: 4, ranks: [high], cards: straightCards };
	if (shape === "311") return { category: 3, ranks: groupRanks, cards: ordered };
	if (shape === "221") return { category: 2, ranks: groupRanks, cards: ordered };
	if (shape === "2111") return { category: 1, ranks: groupRanks, cards: ordered };
	return { category: 0, ranks, cards: sorted };
}

/** 从 5–7 张牌里挑出最大的五张。 */
export function bestHand(cards: readonly Card[]): HandValue {
	if (cards.length < 5) throw new Error("至少需要 5 张牌。");
	let best: HandValue | null = null;
	const pick = (start: number, chosen: Card[]) => {
		if (chosen.length === 5) {
			const value = evaluateFive(chosen);
			if (!best || compareHands(value, best) > 0) best = value;
			return;
		}
		for (let index = start; index <= cards.length - (5 - chosen.length); index += 1) {
			pick(index + 1, [...chosen, cards[index]!]);
		}
	};
	pick(0, []);
	return best!;
}

/** 牌型的中文描述，例如「一对 K」「葫芦 Q 带 7」「皇家同花顺」。 */
export function describeHand(value: HandValue): string {
	const [first = 0, second = 0] = value.ranks;
	switch (value.category) {
		case 8: return first === 14 ? "皇家同花顺" : `同花顺 ${rankLabel(first)} 高`;
		case 7: return `四条 ${rankLabel(first)}`;
		case 6: return `葫芦 ${rankLabel(first)} 带 ${rankLabel(second)}`;
		case 5: return `同花 ${rankLabel(first)} 高`;
		case 4: return `顺子 ${rankLabel(first)} 高`;
		case 3: return `三条 ${rankLabel(first)}`;
		case 2: return `两对 ${rankLabel(first)} 和 ${rankLabel(second)}`;
		case 1: return `一对 ${rankLabel(first)}`;
		default: return `高牌 ${rankLabel(first)}`;
	}
}
