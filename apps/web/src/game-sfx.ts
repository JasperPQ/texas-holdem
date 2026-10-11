import { useEffect, useRef } from "react";
import type { MatchView } from "@poker/game";
import { sfx, synth } from "./gm-sound.js";

/**
 * 德州扑克的动作音效。声音都走共用的 gm-sound.tsx（♪ 面板「音效」那一路），这里负责「刚发生了什么 → 响哪个」：
 *
 * - 新的一手：洗牌 + 发底牌；翻牌三张一张张翻开，转牌、河牌各翻一张（全下后一口气发完也是一张张翻）
 * - 过牌：敲两下桌面；跟注 / 下注 / 加注：筹码落下，金额越大枚数越多；弃牌：牌擦过桌面往里一推
 * - 全下（招牌）：一大摞筹码推进去 + 一声低沉的「咚」
 * - 摊牌：亮牌；赢下底池（招牌）：筹码哗啦啦滑过来，自己赢的响亮、别人赢的减半
 * - 有人输光出局：下滑的一声；比赛结束：终局输赢；轮到你、回合交出、超时、最后 5 秒倒计时用共用提示音
 *
 * 自己的动作 mine=true，别人的减半；观战时都算别人的。第一次拿到局面（进房间、重连、观战）不出声，
 * 一下跳了好几步（重连补齐）只响最后的结果。
 */

/** 开发时把响过的声音名字记在 window.__sfxLog（别人的动作带「@他」），给自测脚本看。 */
function log(name: string, mine = true) {
  if (import.meta.env.DEV) {
    const w = window as unknown as { __sfxLog?: string[] };
    (w.__sfxLog ??= []).push(mine ? name : `${name}@他`);
  }
}

const { tone, noise, level, jitter } = synth;
const later = (ms: number, fn: () => void) => window.setTimeout(fn, ms);

/** 一枚陶瓷筹码落在另一枚上：清脆的两个泛音 + 一下撞击。 */
function chipClick(at: number, v: number) {
  const p = jitter(0.08);
  noise({ at, duration: 0.025, volume: v * 0.45, filter: "highpass", freq: 3200 });
  tone(2600 * p, { at, duration: 0.07, volume: v * 0.3 });
  tone(3900 * p, { at: at + 0.003, duration: 0.05, volume: v * 0.16 });
}

/** 下注金额 → 筹码枚数：一个大盲 1 枚，翻倍多一枚，最多 7 枚。 */
function chipCount(amount: number, bigBlind: number) {
  if (amount <= 0) return 1;
  return Math.max(1, Math.min(7, 1 + Math.floor(Math.log2(Math.max(1, amount / Math.max(1, bigBlind))))));
}

export const pokerSfx = {
  deal(players: number) {
    log("deal");
    sfx.shuffle();
    later(380, () => sfx.deal(Math.min(12, players * 2)));
  },
  board(count: number) {
    log(`board×${count}`);
    for (let i = 0; i < count; i += 1) later(i * 170, () => sfx.flip(true));
  },
  check(mine: boolean) {
    log("check", mine);
    const v = level(mine);
    // 指节敲两下桌面
    for (const at of [0, 0.11]) {
      noise({ at, duration: 0.04, volume: 0.3 * v, filter: "lowpass", freq: 700 });
      tone(150 * jitter(), { at, duration: 0.06, volume: 0.2 * v, type: "triangle" });
    }
  },
  bet(kind: "call" | "raise", amount: number, bigBlind: number, mine: boolean) {
    log(kind, mine);
    const v = level(mine);
    const n = chipCount(amount, bigBlind);
    for (let i = 0; i < n; i += 1) chipClick(i * 0.065, v);
    if (kind === "raise") tone(330, { at: n * 0.065, duration: 0.12, volume: 0.08 * v, type: "triangle", glideTo: 440 });
  },
  fold(mine: boolean) {
    log("fold", mine);
    const v = level(mine);
    noise({ duration: 0.16, volume: 0.22 * v, freq: 2400, freqTo: 900, q: 0.7 });
    noise({ at: 0.12, duration: 0.05, volume: 0.1 * v, filter: "lowpass", freq: 600 });
  },
  /** 招牌：一大摞筹码推进底池。 */
  allIn(mine: boolean) {
    log("allIn", mine);
    const v = level(mine);
    noise({ duration: 0.45, volume: 0.22 * v, freq: 900, freqTo: 2800, q: 0.6 });
    for (let i = 0; i < 12; i += 1) chipClick(0.05 + i * 0.035 + Math.random() * 0.02, v * (0.6 + (i % 3) * 0.15));
    tone(98, { at: 0.42, duration: 0.45, volume: 0.32 * v, glideTo: 55 });
    noise({ at: 0.42, duration: 0.3, volume: 0.25 * v, filter: "lowpass", freq: 500, freqTo: 120 });
    tone(196, { at: 0.5, duration: 0.5, volume: 0.1 * v, type: "triangle" });
  },
  showdown() {
    log("showdown");
    sfx.reveal(true);
    later(160, () => sfx.flip(true));
  },
  /** 招牌：底池的筹码哗啦啦滑到赢家面前。 */
  winPot(amount: number, bigBlind: number, mine: boolean) {
    log("winPot", mine);
    const v = level(mine);
    noise({ duration: 0.4, volume: 0.2 * v, freq: 2600, freqTo: 700, q: 0.5 });
    const n = Math.min(10, 2 + chipCount(amount, bigBlind));
    for (let i = 0; i < n; i += 1) chipClick(0.3 + i * 0.05 + Math.random() * 0.02, v * 0.85);
    if (mine) [784, 988, 1319].forEach((f, i) => tone(f, { at: 0.35 + n * 0.05 + i * 0.08, duration: 0.2, volume: 0.1, type: "triangle" }));
  },
  out(mine: boolean) {
    log("eliminated", mine);
    sfx.bust(mine);
  },
};

function cue(name: "yourTurn" | "turnPassed" | "timeout" | "gameOver", won = false) {
  log(name === "gameOver" ? (won ? "gameOver:win" : "gameOver:lose") : name);
  if (name === "gameOver") sfx.gameOver(won);
  else sfx[name]();
}

/** 自己点了行动按钮（用来分辨「超时被系统代做」）。 */
let sentAt = 0;
export function noteMyAction() {
  sentAt = Date.now();
}

/**
 * 对比前后两次牌桌快照推断刚发生的行动并播放音效。
 * auto：自己在托管中（人机替你出牌，不算超时）。
 */
export function useGameSfx(match: MatchView | undefined, myId: string, auto: boolean) {
  const previous = useRef<MatchView | undefined>(undefined);

  useEffect(() => {
    const prev = previous.current;
    previous.current = match;
    if (!prev || !match || prev === match) return;
    const hand = match.hand;
    const before = prev.hand;
    const meSeat = match.players.findIndex((p) => p.id === myId);
    const myTurnNext = match.phase === "playing" && hand.turn !== null && hand.turn === meSeat;

    // 新的一场（再来一局）或一下跳过好几手（重连）：只在新的一手开始时发牌
    if (match.startedAt !== prev.startedAt || hand.number > before.number + 1 || hand.number < before.number) {
      if (match.phase === "playing" && hand.board.length === 0) pokerSfx.deal(match.players.filter((p) => p.hasCards).length);
      if (myTurnNext) later(900, () => cue("yourTurn"));
      return;
    }

    let t = 0;
    // 新的一手：洗牌发底牌
    if (hand.number === before.number + 1) {
      pokerSfx.deal(match.players.filter((p) => p.hasCards).length);
      if (myTurnNext) later(1100, () => cue("yourTurn"));
      return;
    }

    // 同一手里：刚才行动的人（before.turn）做了什么
    const changed = match.players.filter((p, i) => {
      const q = prev.players[i]!;
      return p.handBet !== q.handBet || p.folded !== q.folded;
    }).length;
    const seat = before.turn;
    if (seat !== null && changed <= 1) {
      const p = match.players[seat]!;
      const q = prev.players[seat]!;
      const mine = p.id === myId;
      const put = p.handBet - q.handBet;
      if (p.folded && !q.folded) pokerSfx.fold(mine);
      else if (p.allIn && !q.allIn) pokerSfx.allIn(mine);
      else if (put > 0) pokerSfx.bet(hand.street === before.street && hand.currentBet > before.currentBet ? "raise" : "call", put, before.bigBlind, mine);
      else pokerSfx.check(mine);
      if (mine && !auto && Date.now() - sentAt > 4000) later(250, () => cue("timeout"));
      t = 300;
    }

    // 公共牌：翻牌 3 张、转牌 1 张、河牌 1 张；全下后一口气发完也一张张翻
    const newCards = hand.board.length - before.board.length;
    if (newCards > 0) {
      later(t, () => pokerSfx.board(newCards));
      t += newCards * 170 + 250;
    }

    // 这一手结束：摊牌亮牌，底池滑到赢家面前，输光的出局
    if (hand.result && !before.result) {
      const result = hand.result;
      if (!result.uncontested) {
        later(t, () => pokerSfx.showdown());
        t += 500;
      }
      const won = result.pots.filter((pot) => pot.winnerIds.length > 0 && (result.uncontested || pot.eligibleIds.length > 1 || result.pots.length === 1));
      const total = won.reduce((s, pot) => s + pot.amount, 0);
      const iWon = won.some((pot) => pot.winnerIds.includes(myId));
      later(t, () => pokerSfx.winPot(total, before.bigBlind, iWon));
      t += 900;
      if (result.eliminatedIds.length > 0) {
        const meOut = result.eliminatedIds.includes(myId);
        later(t, () => pokerSfx.out(meOut));
        t += 600;
      }
    }

    if (match.phase === "finished" && prev.phase !== "finished") {
      later(t + 300, () => cue("gameOver", match.winnerId === myId));
      return;
    }
    if (match.phase === "playing" && hand.turn !== before.turn) {
      if (myTurnNext) later(Math.max(500, t), () => cue("yourTurn"));
      else if (seat !== null && seat === meSeat && !hand.result) later(Math.max(450, t), () => cue("turnPassed"));
    }
  }, [match, myId]);
}
