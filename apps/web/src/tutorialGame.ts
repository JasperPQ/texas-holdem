/**
 * 德州扑克和教程有关的部分（共用的 tutorial/ 文件夹之外，每款游戏自己写的）：
 * 游戏 id、「提示」怎么说、「第一次遇到」小贴士什么时候出。
 */
import { botAdvice, legalActions, type MatchState, type MatchView } from "@poker/game";

/** 本机记录（gm-tutorial-<id>、gm-tips-<id>）用的游戏 id。 */
export const GAME_ID = "poker";

export interface Hint {
  readonly say: string;
  readonly note?: string;
  /** 高亮哪个按钮（data-tutorial）；null 不指。 */
  readonly anchor: string | null;
}

/** 「提示」：让人机从你的位置算一步（界面拿到的本来就是你能看到的那份），配一句原因。 */
export function hintFor(match: MatchView, playerId: string): Hint {
  if (match.phase !== "playing") return { say: "这一手已经结束了。", anchor: null };
  const seat = match.players.findIndex((player) => player.id === playerId);
  if (match.hand.turn !== seat) return { say: "还没轮到你，等一下再问我。", anchor: null };
  let advice;
  try {
    advice = botAdvice(match, playerId, { hint: true });
  } catch {
    advice = null;
  }
  if (!advice) return { say: "我会能过牌就过牌。", anchor: "check" };
  const legal = legalActions(match as unknown as MatchState, seat);
  const { action, reason } = advice;
  switch (action.type) {
    case "fold":
      return { say: "我会弃牌。", note: reason, anchor: "fold" };
    case "check":
      return { say: "我会过牌。", note: reason, anchor: "check" };
    case "call":
      return { say: `我会跟注 ${legal?.toCall ?? ""}。`, note: reason, anchor: "call" };
    case "raise":
      return { say: match.hand.currentBet === 0 ? `我会下注 ${action.to}。` : `我会加注到 ${action.to}。`, note: reason, anchor: "raise" };
    case "allIn":
      return { say: "我会全下。", note: reason, anchor: legal?.canRaise ? "raise" : legal?.canCall ? "call" : "allin" };
    default:
      return { say: "我会过牌。", anchor: "check" };
  }
}

/** 「第一次遇到」小贴士的内容。 */
export const TIPS = {
  showdown: { title: "摊牌比牌型", text: "从大到小：同花顺、四条、葫芦、同花、顺子、三条、两对、一对、高牌。同牌型再比点数，一样大就平分。" },
  "side-pot": { title: "这一手有边池", text: "有人全下且筹码不一样多：多出来的下注另成边池，只在为它出过筹码的人之间比。" },
  refund: { title: "没人跟的筹码退回", text: "下注比别人能跟的多，多出来那部分没人跟，原样退回。" },
  uncontested: { title: "其他人都弃牌了", text: "只剩一个人没弃牌，他直接赢下底池，不用亮牌。" },
  "blinds-up": { title: "盲注翻倍了", text: "房主设了盲注上涨：每过一段时间从下一手起翻倍，筹码少的人要早点出手。" },
  "self-out": { title: "你出局了", text: "筹码输光就出局，可以留在桌边看完；比赛结束后可以选「再来一局」。" },
} as const;

/** 这一步该出哪些小贴士（按优先顺序；只出第一条没看过的）。 */
export function detectTips(match: MatchView, selfId: string): string[] {
  const ids: string[] = [];
  const result = match.hand.result;
  if (result) {
    const me = match.players.find((player) => player.id === selfId);
    if (me && me.place !== null && me.place > 1 && result.eliminatedIds.includes(selfId)) ids.push("self-out");
    const contested = result.pots.filter((pot) => pot.eligibleIds.length > 1);
    if (contested.length > 1) ids.push("side-pot");
    if (!result.uncontested && result.pots.some((pot) => pot.eligibleIds.length === 1)) ids.push("refund");
    if (result.uncontested) ids.push("uncontested");
    else ids.push("showdown");
  }
  if (match.hand.level > 0) ids.push("blinds-up");
  return ids;
}
