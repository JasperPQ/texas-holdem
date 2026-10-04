export type Suit = "S" | "H" | "D" | "C";

/** 点数 2–14（11=J、12=Q、13=K、14=A）。 */
export interface Card {
	readonly id: string;
	readonly rank: number;
	readonly suit: Suit;
}

export const SUITS: readonly Suit[] = ["S", "H", "D", "C"];
export const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] as const;

export function createDeck(): Card[] {
	return SUITS.flatMap((suit) => RANKS.map((rank) => ({ id: `${suit}${rank}`, rank, suit })));
}

export function shuffle<T>(items: readonly T[], random: () => number): T[] {
	const result = [...items];
	for (let index = result.length - 1; index > 0; index -= 1) {
		const swap = Math.floor(random() * (index + 1));
		[result[index], result[swap]] = [result[swap]!, result[index]!];
	}
	return result;
}

export function rankLabel(rank: number): string {
	return ({ 11: "J", 12: "Q", 13: "K", 14: "A" } as Record<number, string>)[rank] ?? String(rank);
}
