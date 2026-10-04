import type { Card } from "./cards.js";
import type { HandState, MatchState, PlayerState } from "./holdem.js";

export interface PlayerView extends Omit<PlayerState, "holeCards"> {
	/** 自己的底牌，或摊牌时亮出的底牌；其他情况下为空。 */
	holeCards: Card[];
	/** 这一手是否拿到了底牌（用于显示牌背）。 */
	hasCards: boolean;
}

export interface MatchView extends Omit<MatchState, "players" | "hand"> {
	mySeat: number | null;
	players: PlayerView[];
	hand: Omit<HandState, "deck">;
}

/** 只给某位玩家看的视图：去掉牌堆，隐藏其他人的底牌（摊牌亮出的除外）。 */
export function viewForPlayer(state: MatchState, playerId: string): MatchView {
	const { deck: _deck, ...hand } = state.hand;
	const revealed = state.hand.result?.revealed ?? {};
	const mySeat = state.players.findIndex((player) => player.id === playerId);
	return structuredClone({
		...state,
		mySeat: mySeat < 0 ? null : mySeat,
		hand,
		players: state.players.map((player) => ({
			...player,
			hasCards: player.holeCards.length > 0,
			holeCards: player.id === playerId || revealed[player.id] ? player.holeCards : [],
		})),
	});
}
