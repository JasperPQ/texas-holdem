/**
 * 新手教程的剧本（德州扑克）。
 *
 * 教程在浏览器里直接跑规则引擎，不连服务器：三人桌（你 + 咕噜一号 + 咕噜二号），前三手牌的底牌和公共牌
 * 按 SCRIPT_HANDS 摆好，两个咕噜按剧本行动，所以「两对赢一对」「7-2 弃牌」「一对 A 全下淘汰咕噜二号」
 * 这几幕一定发生。剧本走完接练习局：只剩你和咕噜一号，对手交给人机，发牌换成普通随机。
 *
 * 一手牌打完以后（handOver）要「发下一手」：线上由服务器计时，教程里当成一个由「荷官」做的命令 nextHand。
 */
import type { Card } from "./cards.js";
import { DEFAULT_SETTINGS, applyAction, createMatch, legalActions, startNextHand, type MatchState, type PokerAction, type Settings } from "./holdem.js";

/** 咕噜嘎的表情。 */
export type TutorialFace = "base" | "happy" | "surprised" | "think";

/** 教程里的命令：玩家的行动，或者「发下一手」（荷官做）。 */
export type TutorialCommand = PokerAction | { type: "nextHand" };

interface StepBase {
	readonly id: string;
	/** 侧栏「新手教程」进度里这一课叫什么；没有就不单独列。 */
	readonly lesson?: string;
	/** 主句（24px），一句话说清这一步。 */
	readonly say: string;
	/** 补充说明（12px）。 */
	readonly note?: string;
	/** 触屏设备上换成这句说明。 */
	readonly noteTouch?: string;
	/**
	 * 高亮哪个元素：网页里 data-tutorial 的值。
	 * dealer、blinds、my-cards、my-hand、board、pot、result、hand-ranks、fold、check、call、raise、seat:<座位>。
	 */
	readonly anchor?: string;
	readonly face?: TutorialFace;
}

export type TutorialStep =
	/** 讲解：玩家点「下一步」继续。finale 是最后一步（接练习局或结束）。 */
	| (StepBase & { readonly kind: "info"; readonly finale?: boolean })
	/** 等玩家做这一步；做别的会被拦下。加注 / 下注只看类型，不看数额。 */
	| (StepBase & { readonly kind: "do"; readonly expect: TutorialCommand })
	/** 对手（或荷官）按剧本自动走这几步，牌桌不压暗。 */
	| (StepBase & { readonly kind: "watch"; readonly moves: readonly TutorialCommand[] });

export const TUTORIAL_SELF = "tutorial-self";
export const TUTORIAL_RIVALS = [
	{ id: "tutorial-bot-1", name: "咕噜一号" },
	{ id: "tutorial-bot-2", name: "咕噜二号" },
] as const;
/** 「发下一手」由它来做（不是座位上的人）。 */
export const TUTORIAL_DEALER = "tutorial-dealer";

export const TUTORIAL_SETTINGS: Settings = { ...DEFAULT_SETTINGS, actionSeconds: 0, blindIncreaseMinutes: 0 };

const CALL: PokerAction = { type: "call" };
const CHECK: PokerAction = { type: "check" };
const FOLD: PokerAction = { type: "fold" };
const NEXT: TutorialCommand = { type: "nextHand" };

export const TUTORIAL_STEPS: readonly TutorialStep[] = [
	{ id: "goal", kind: "info", lesson: "目标", face: "happy", say: "德州扑克：赢走别人的筹码，最后一个还有筹码的人获胜。", note: "每人 1000 筹码起步。我带你打三手牌，你照着做就行。" },
	// 第 1 手：你是庄位，咕噜一号小盲，咕噜二号大盲。
	{ id: "dealer", kind: "info", lesson: "庄位和盲注", anchor: "dealer", say: "D 是庄位，每打完一手往左轮一位。", note: "庄位左边两位先强制下注：小盲 10、大盲 20，叫「盲注」，保证每手都有东西可赢。" },
	{ id: "blinds", kind: "info", anchor: "seat:2", say: "咕噜一号下了小盲 10，咕噜二号下了大盲 20。", note: "下注的筹码摆在每个人面前，这一轮结束后收进底池。" },
	{ id: "hole", kind: "info", lesson: "底牌和公共牌", anchor: "my-cards", say: "这两张是你的底牌，只有你自己看得见。", note: "别人的底牌在你这里是背面朝上。" },
	{ id: "board", kind: "info", anchor: "board", say: "桌子中间会陆续发 5 张公共牌，大家共用。", note: "最后用 2 张底牌加 5 张公共牌里最好的 5 张，比谁的牌型大。" },
	{ id: "call", kind: "do", lesson: "跟注", anchor: "call", expect: CALL, say: "第一轮从大盲左边的人开始说话，现在轮到你：点「跟注」。", note: "跟注：把自己的下注补到和场上最高的一样多，这里是 20。" },
	{ id: "pre-rest", kind: "watch", moves: [CALL, CHECK], say: "咕噜一号补齐跟注；咕噜二号的大盲已经够了，可以过牌。" },
	{ id: "flop", kind: "info", lesson: "翻牌", anchor: "board", say: "翻牌：一次发 3 张公共牌，开始第二轮下注。", note: "你有一对 K，牌桌下方的「当前牌型」会一直帮你写出来。" },
	{ id: "flop-checks", kind: "watch", moves: [CHECK, CHECK], say: "翻牌以后从庄位左边开始说话：两个咕噜都过牌。" },
	{ id: "check", kind: "do", lesson: "过牌", anchor: "check", expect: CHECK, say: "没人下注时可以「过牌」：不花筹码，把机会让给下一位。" },
	{ id: "turn", kind: "info", lesson: "转牌", anchor: "my-hand", face: "happy", say: "转牌：第 4 张公共牌。你凑成了两对 K 和 Q！" },
	{ id: "turn-bet", kind: "watch", moves: [{ type: "raise", to: 40 }, FOLD], say: "咕噜一号下注 40，咕噜二号弃牌。", note: "弃牌：放弃这手牌，已经下的筹码拿不回来。" },
	{
		id: "raise", kind: "do", lesson: "加注", anchor: "raise", expect: { type: "raise", to: 0 }, face: "happy",
		say: "牌很好，加注！点「½ 底池」，再点「加注到」。",
		note: "加注至少要比上一次加得多；也可以拖动条或者直接输入数额。",
	},
	{ id: "turn-call", kind: "watch", moves: [CALL], say: "咕噜一号跟注。" },
	{ id: "river", kind: "info", lesson: "河牌", anchor: "board", say: "河牌：最后一张公共牌，最后一轮下注。" },
	{ id: "river-check", kind: "watch", moves: [CHECK], say: "咕噜一号过牌。" },
	{ id: "bet", kind: "do", lesson: "下注", anchor: "raise", expect: { type: "raise", to: 0 }, say: "没人下注时主动出钱叫「下注」：点「½ 底池」，再点「下注」。" },
	{ id: "river-call", kind: "watch", moves: [CALL], say: "咕噜一号跟注，下注结束，摊牌！" },
	{ id: "showdown", kind: "info", lesson: "摊牌比大小", anchor: "result", face: "happy", say: "摊牌：没弃牌的人亮出底牌，牌型大的赢走底池。", note: "你的两对 K 和 Q 赢了咕噜一号的一对 9。" },
	{ id: "ranks", kind: "info", lesson: "牌型大小", anchor: "hand-ranks", face: "think", say: "牌型从大到小看右边这张表：同花顺最大，高牌最小。", note: "同牌型再比点数；五张一样大就平分底池。花色不分大小，A 在顺子里可以当 1。" },
	// 第 2 手：庄位轮到咕噜一号，咕噜二号小盲，你是大盲。
	{ id: "deal2", kind: "watch", moves: [NEXT], say: "下一手：庄位往左轮一位，这次你是大盲。" },
	{ id: "pre2", kind: "watch", moves: [{ type: "raise", to: 60 }, CALL], say: "咕噜一号加注到 60，咕噜二号跟注。" },
	{ id: "fold", kind: "do", lesson: "弃牌", anchor: "fold", expect: FOLD, face: "think", say: "你拿到 7 和 2，是最差的起手牌之一：点「弃牌」。", note: "你的大盲 20 留在底池里。牌不好就早点放弃，省下筹码。" },
	{ id: "rest2", kind: "watch", moves: [CHECK, { type: "raise", to: 80 }, FOLD], say: "两个咕噜接着打：咕噜一号下注，咕噜二号弃牌。", note: "只剩一个人没弃牌时，他直接赢下底池，不用亮牌。" },
	// 第 3 手：庄位轮到咕噜二号，你是小盲，咕噜一号大盲。
	{ id: "deal3", kind: "watch", moves: [NEXT], say: "再下一手：这次你是小盲。" },
	{ id: "shove", kind: "watch", moves: [{ type: "allIn" }], face: "surprised", say: "咕噜二号全下：把剩下的筹码全推了进去！" },
	{
		id: "allin", kind: "do", lesson: "全下", anchor: "raise", expect: { type: "allIn" }, face: "happy",
		say: "你拿到一对 A，最大的起手牌：点「全下」，再点右边的按钮。",
		note: "全下：一次押上全部筹码。没人跟的多出来那部分会退还给你。",
	},
	{ id: "fold3", kind: "watch", moves: [FOLD], say: "咕噜一号弃牌。没人能再下注了，公共牌直接发完。" },
	{ id: "out", kind: "info", lesson: "出局", anchor: "result", face: "surprised", say: "咕噜二号筹码输光，出局了！", note: "你比他多推的那部分没人跟，退回给你。出局的人留在桌边观战。" },
	{ id: "sidepot", kind: "info", lesson: "边池", face: "think", say: "几个人筹码不一样多都全下时，多出来的下注另开「边池」。", note: "每个底池只在为它出过筹码的人之间比：筹码少的人就算赢了，也只拿他跟得起的那份。" },
	{ id: "timer", kind: "info", lesson: "限时和托管", face: "think", say: "和真人打有行动限时：超时能过牌就过牌，否则弃牌。", note: "连续两次超时转「托管」，由人机替你打，点「取消托管」收回；掉线时也由人机代打，用原昵称回来就交还。" },
	{ id: "end", kind: "info", lesson: "结束", finale: true, face: "happy", say: "只剩一个人有筹码时比赛结束，他就是冠军。", note: "现在只剩你和咕噜一号。接着打完这局，拿不准就点「提示」。" },
];

const card = (spec: string): Card => {
	const rank = ({ T: 10, J: 11, Q: 12, K: 13, A: 14 } as Record<string, number>)[spec[0]!] ?? Number(spec[0]);
	const suit = spec[1]!.toUpperCase() as Card["suit"];
	return { id: `${suit}${rank}`, rank, suit };
};

/** 前三手的牌：holes 按座位（你、咕噜一号、咕噜二号），board 按翻牌、转牌、河牌的顺序。 */
export const SCRIPT_HANDS: Readonly<Record<number, { holes: readonly [string, string, string]; board: string }>> = {
	1: { holes: ["Ks Qs", "9c 9d", "7d 2c"], board: "Kd 8h 4c Qh 2s" },
	2: { holes: ["7c 2d", "Ah Jh", "Ts 9s"], board: "As 6d 3h Kc 5s" },
	3: { holes: ["Ad Ac", "8s 4d", "Kh Jc"], board: "Qd 7h 3s 9c 5h" },
};

/** 按剧本摆这一手的底牌和牌堆（引擎从牌堆末尾发公共牌）。不在剧本里的手原样返回。 */
export function rigHand(state: MatchState): MatchState {
	const script = SCRIPT_HANDS[state.hand.number];
	if (!script) return state;
	const next = structuredClone(state);
	next.players.forEach((player, seat) => {
		if (player.inHand) player.holeCards = script.holes[seat]!.split(" ").map(card);
	});
	const board = script.board.split(" ").map(card);
	const used = new Set([...script.holes.join(" ").split(" "), ...script.board.split(" ")].map((spec) => card(spec).id));
	const filler = next.hand.deck.filter((entry) => !used.has(entry.id));
	next.hand.deck = [...filler, ...[...board].reverse()];
	return next;
}

function players(selfName: string) {
	return [{ id: TUTORIAL_SELF, name: selfName }, ...TUTORIAL_RIVALS.map((rival) => ({ ...rival }))];
}

/** 教程开局：你是庄位，按剧本发牌。 */
export function createTutorialGame(selfName: string): MatchState {
	// 第一手的庄位用随机数挑：第一个数给 0，就是 0 号座位（你）。
	let first = true;
	const random = () => (first ? ((first = false), 0) : Math.random());
	return rigHand(createMatch(players(selfName), TUTORIAL_SETTINGS, 0, random));
}

/** 「再练一局」：三人桌重新开始，正常洗牌。 */
export function createPracticeGame(selfName: string, random: () => number = Math.random): MatchState {
	return createMatch(players(selfName), TUTORIAL_SETTINGS, 0, random);
}

/** 现在轮到谁：座位上的人，一手打完时是「荷官」，比赛结束返回 null。 */
export function tutorialActor(state: MatchState): string | null {
	if (state.phase === "playing") return state.hand.turn === null ? null : state.players[state.hand.turn]!.id;
	if (state.phase === "handOver") return TUTORIAL_DEALER;
	return null;
}

/** 教程里走一步。scripted 为真时，新发的一手按剧本摆牌。 */
export function applyTutorial(state: MatchState, playerId: string, command: TutorialCommand, options: { scripted: boolean; random?: () => number }): MatchState {
	if (command.type === "nextHand") {
		if (playerId !== TUTORIAL_DEALER || state.phase !== "handOver") throw new Error("现在不能发下一手。");
		const next = startNextHand(state, 0, options.random ?? Math.random);
		return options.scripted ? rigHand(next) : next;
	}
	return applyAction(state, playerId, command);
}

/** 两条命令算不算同一步：加注 / 下注只看类型，不看数额。 */
export function sameCommand(a: TutorialCommand, b: TutorialCommand): boolean {
	return a.type === b.type;
}

/** 这个锚点在这个局面下（从 viewer 的座位看）应该看得见。剧本单测用。 */
export function anchorVisible(state: MatchState, anchor: string, viewer: string): boolean {
	const seat = state.players.findIndex((player) => player.id === viewer);
	const me = state.players[seat];
	const legal = seat >= 0 ? legalActions(state, seat) : null;
	switch (anchor) {
		case "dealer":
			return state.phase !== "finished";
		case "board":
		case "hand-ranks":
			return true;
		case "pot":
			return state.hand.result === null;
		case "result":
			return state.hand.result !== null;
		case "my-cards":
			return Boolean(me && me.holeCards.length === 2);
		case "my-hand":
			return Boolean(me && me.holeCards.length === 2 && !me.folded && state.hand.board.length >= 3);
		case "fold":
			return Boolean(legal);
		case "check":
			return Boolean(legal?.canCheck);
		case "call":
			return Boolean(legal?.canCall && me && me.chips > legal.toCall);
		case "raise":
			return Boolean(legal?.canRaise);
		default:
			if (anchor.startsWith("seat:")) return Boolean(state.players[Number(anchor.slice(5))]);
			return false;
	}
}
