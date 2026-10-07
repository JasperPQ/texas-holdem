import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  bestHand,
  describeHand,
  legalActions,
  rankLabel,
  type ActionRecord,
  type Card,
  type LobbyRoomSnapshot,
  type MatchState,
  type MatchView,
  type PlayerView,
  type PokerAction,
} from "@poker/game";
import GameRules from "./GameRules.js";
import { usePixel } from "./pixel.js";
import { socket } from "./socket.js";
import "./poker.css";

const SUIT_SYMBOLS: Record<Card["suit"], string> = { S: "♠", H: "♥", D: "♦", C: "♣" };
const SUIT_NAMES: Record<Card["suit"], string> = { S: "黑桃", H: "红桃", D: "方块", C: "梅花" };

/** 不同人数下各座位在桌边的位置（第一个总是自己，在正下方）。 */
const LAYOUTS: Record<number, string[]> = {
  2: ["bottom", "top"],
  3: ["bottom", "top-left", "top-right"],
  4: ["bottom", "left", "top", "right"],
  5: ["bottom", "left", "top-left", "top-right", "right"],
  6: ["bottom", "bottom-left", "top-left", "top", "top-right", "bottom-right"],
};

/** 动作名称；金额由旁边的筹码显示，这里不重复。 */
const ACTION_NAMES: Record<ActionRecord["type"], string> = {
  smallBlind: "小盲",
  bigBlind: "大盲",
  fold: "弃牌",
  check: "过牌",
  call: "跟注",
  bet: "下注",
  raise: "加注",
  allIn: "全下",
};

const CARD_IMAGE_BASE = `${import.meta.env.BASE_URL}cards/`;
/** 像素版牌面（掼蛋仓库 art/cards.py 画的 PNG，两个游戏共用），文件名和 SVG 一一对应。 */
const PIXEL_CARD_BASE = `${import.meta.env.BASE_URL}cards-pixel/`;

/** 牌面图片文件名，例如黑桃 A 为 Sa.svg、红桃 10 为 H10.svg。 */
export function cardImage(card: Card, pixel = false): string {
  const rank = ({ 11: "j", 12: "q", 13: "k", 14: "a" } as Record<number, string>)[card.rank] ?? String(card.rank);
  return pixel ? `${PIXEL_CARD_BASE}${card.suit}${rank}.png` : `${CARD_IMAGE_BASE}${card.suit}${rank}.svg`;
}

/** 提前加载整副牌面（当前画面风格的那一套），避免发牌时图片一张张冒出来。 */
export function preloadCardImages(pixel = false): void {
  for (const suit of ["S", "H", "D", "C"] as const) {
    for (let rank = 2; rank <= 14; rank += 1) new Image().src = cardImage({ id: "", suit, rank }, pixel);
  }
}

/**
 * 一张牌。原始版本是 SVG 牌面加放大的角标；像素版换成像素牌面图（角标已经画在图里，不再叠加），
 * 背面朝上的牌由样式表画像素牌背。
 */
export function PlayingCard({ card, size = "medium", faceDown = false, dim = false }: {
  card?: Card;
  size?: "small" | "medium" | "large";
  faceDown?: boolean;
  dim?: boolean;
}) {
  const pixel = usePixel();
  if (!card || faceDown) return <span className={`pk-card pk-card-${size} pk-card-back`} aria-label="背面朝上的牌" />;
  if (pixel) {
    return (
      <span className={`pk-card pk-card-${size}${dim ? " dim" : ""}`} role="img" aria-label={`${SUIT_NAMES[card.suit]}${rankLabel(card.rank)}`}>
        <img src={cardImage(card, true)} alt="" draggable={false} />
      </span>
    );
  }
  return (
    <span className={`pk-card pk-card-${size}${dim ? " dim" : ""}`} role="img" aria-label={`${SUIT_NAMES[card.suit]}${rankLabel(card.rank)}`}>
      <img src={cardImage(card)} alt="" draggable={false} />
      <span className={`pk-index${card.suit === "H" || card.suit === "D" ? " red" : ""}`} aria-hidden="true">
        <b>{rankLabel(card.rank)}</b><i>{SUIT_SYMBOLS[card.suit]}</i>
      </span>
    </span>
  );
}

/** 根据服务器给的剩余毫秒数在本地倒计时。 */
function useCountdown(remainingMs: number | undefined, resetKey: string): number | null {
  const [deadline, setDeadline] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setDeadline(remainingMs === undefined ? null : Date.now() + remainingMs);
    setNow(Date.now());
  }, [remainingMs, resetKey]);
  useEffect(() => {
    if (deadline === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [deadline]);
  return deadline === null ? null : Math.max(0, deadline - now);
}

function Seat({ player, seat, match, position, member, remainingMs, isMe }: {
  player: PlayerView;
  seat: number;
  match: MatchView;
  position: string;
  member: LobbyRoomSnapshot["members"][number] | undefined;
  remainingMs: number | null;
  isMe: boolean;
}) {
  const hand = match.hand;
  const action = hand.actions[seat];
  const revealed = hand.result?.revealed[player.id];
  const won = hand.result?.pots.some((pot) => pot.winnerIds.includes(player.id)) ?? false;
  const active = match.phase === "playing" && hand.turn === seat;
  const out = player.place !== null && player.place > 1;
  const limitMs = match.settings.actionSeconds * 1_000;
  const classes = [
    "pk-seat",
    `pk-pos-${position}`,
    active ? "active" : "",
    player.folded ? "folded" : "",
    out ? "out" : "",
    won && match.phase !== "playing" ? "winner" : "",
    member?.connected === false ? "offline" : "",
  ].filter(Boolean).join(" ");

  return (
    <div className={classes}>
      {!isMe && player.hasCards && !out && (
        <div className="pk-seat-cards">
          {revealed
            ? revealed.cards.map((card) => <PlayingCard card={card} size="small" key={card.id} />)
            : player.folded ? null : [0, 1].map((index) => <PlayingCard size="small" faceDown key={index} />)}
        </div>
      )}
      <div className="pk-plate">
        {hand.dealerSeat === seat && match.phase !== "finished" && <span className="pk-dealer" title="庄位">D</span>}
        <strong>{player.name}{isMe ? "（你）" : ""}</strong>
        <span className="pk-chips">{out ? `第 ${player.place} 名` : player.chips}</span>
        {member?.connected === false && <span className="pk-tag">离线</span>}
        {player.allIn && !out && <span className="pk-tag allin">全下</span>}
      </div>
      {revealed && <span className="pk-hand-name">{revealed.handName}</span>}
      {!revealed && action && <span className={`pk-action ${action.type}`}>{ACTION_NAMES[action.type]}</span>}
      {active && remainingMs !== null && limitMs > 0 && (
        <span className="pk-timer"><i style={{ width: `${Math.min(100, (remainingMs / limitMs) * 100)}%` }} /></span>
      )}
      {player.streetBet > 0 && <span className="pk-bet">{player.streetBet}</span>}
    </div>
  );
}

/** 比赛结束后的继续投票。 */
function RematchPanel({ room, match, onRematch }: {
  room: LobbyRoomSnapshot;
  match: MatchView;
  onRematch: (accept: boolean) => void;
}) {
  const rematch = room.rematch;
  const remaining = useCountdown(rematch?.remainingMs, String(Boolean(rematch)));
  const accepted = new Set(rematch?.acceptedIds ?? []);
  const myVote = accepted.has(socket.id ?? "");
  const ranking = [...match.players].sort((left, right) => (left.place ?? 99) - (right.place ?? 99));
  return (
    <div className="pk-modal-backdrop">
      <section className="pk-panel" role="dialog" aria-modal="true" aria-labelledby="pk-final-title">
        <h2 id="pk-final-title">{match.players.find((player) => player.id === match.winnerId)?.name ?? "—"} 赢得比赛</h2>
        <ol className="pk-ranking">
          {ranking.map((player) => (
            <li key={player.id}><span>第 {player.place} 名</span>{player.name}{player.id === socket.id ? "（你）" : ""}</li>
          ))}
        </ol>
        {rematch && (
          <>
            <p className="pk-panel-note">再来一局？{Math.ceil((remaining ?? 0) / 1000)} 秒内未确认视为退出。</p>
            <div className="pk-votes">
              {room.members.map((member) => (
                <span className={accepted.has(member.id) ? "yes" : ""} key={member.id}>{member.name}{accepted.has(member.id) ? " ✓" : ""}</span>
              ))}
            </div>
            <div className="pk-panel-actions">
              <button type="button" className="quiet-button" onClick={() => onRematch(false)}>退出房间</button>
              <button type="button" className="primary-button" disabled={myVote} onClick={() => onRematch(true)}>{myVote ? "等待其他玩家" : "再来一局"}</button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function PokerTable({
  room,
  busy,
  error,
  notice,
  brand,
  connection,
  styleToggle,
  chat,
  onAction,
  onRematch,
  onDissolve,
}: {
  room: LobbyRoomSnapshot;
  busy: boolean;
  error: string;
  notice: string;
  brand: ReactNode;
  connection: ReactNode;
  /** 顶栏的画面切换按钮（像素版 ⇄ 原始版本）。 */
  styleToggle: ReactNode;
  chat: ReactNode;
  onAction: (action: PokerAction) => void;
  onRematch: (accept: boolean) => void;
  onDissolve: () => void;
}) {
  const pixel = usePixel();
  useEffect(() => preloadCardImages(pixel), [pixel]);
  const match = room.match!;
  const hand = match.hand;
  const mySeat = match.mySeat ?? 0;
  const me = match.players[mySeat]!;
  const count = match.players.length;
  const layout = LAYOUTS[count] ?? LAYOUTS[6]!;
  const turnKey = `${hand.number}-${hand.street}-${hand.turn}`;
  const remainingMs = useCountdown(room.turnRemainingMs, turnKey);
  const legal = useMemo(() => legalActions(match as unknown as MatchState, mySeat), [match, mySeat]);
  const [raiseTo, setRaiseTo] = useState(0);
  useEffect(() => {
    if (legal) setRaiseTo(legal.minRaiseTo);
  }, [turnKey, legal?.minRaiseTo]);

  const pot = match.players.reduce((total, player) => total + player.handBet, 0);
  const isHost = room.members.find((member) => member.id === socket.id)?.isHost ?? false;
  const myBest = me.holeCards.length === 2 && hand.board.length >= 3 ? describeHand(bestHand([...me.holeCards, ...hand.board])) : "";
  const nameOf = (id: string) => match.players.find((player) => player.id === id)?.name ?? "玩家";
  const activeName = hand.turn !== null ? match.players[hand.turn]?.name : "";
  const myTurn = match.phase === "playing" && hand.turn === mySeat;

  const turnText = match.phase === "finished" ? "比赛结束"
    : match.phase === "handOver" ? "这一手结束"
    : myTurn ? "轮到你行动"
    : `等待 ${activeName}`;

  // 加注快捷金额：按底池比例，夹在可加注范围内。
  const clamp = (value: number) => (legal ? Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, Math.round(value))) : value);
  const potRaise = (fraction: number) => clamp(hand.currentBet + (pot + (legal?.toCall ?? 0)) * fraction);
  const raiseVerb = hand.currentBet === 0 ? "下注" : "加注到";

  const nextLevelInMs = match.settings.blindIncreaseMinutes > 0
    ? match.startedAt + (hand.level + 1) * match.settings.blindIncreaseMinutes * 60_000 - Date.now()
    : null;

  return (
    <div className="pk-screen">
      <header className="pk-topbar">
        {brand}
        <span className="pk-chip-label" title="房间码">{room.code}</span>
        <span className="pk-blinds" title="当前盲注">
          盲注 <b>{hand.smallBlind}/{hand.bigBlind}</b>
          {nextLevelInMs !== null && <small>{nextLevelInMs > 0 ? ` · 约 ${Math.ceil(nextLevelInMs / 60_000)} 分钟后翻倍` : " · 下一手翻倍"}</small>}
        </span>
        <span className="pk-hand-number">第 {hand.number} 手</span>
        <span className={myTurn ? "turn-indicator my-turn" : "turn-indicator"}><span className="turn-dot" />{turnText}</span>
        <span className="pk-feedback" role="status">{error ? <span className="pk-error">{error}</span> : notice}</span>
        <GameRules />
        {isHost && <button type="button" className="pk-dissolve" onClick={onDissolve}>解散房间</button>}
        {styleToggle}
        {connection}
      </header>

      <section className="pk-table-area" aria-label="牌桌">
        <div className="pk-felt">
          <div className="pk-center">
            <div className="pk-board">
              {[0, 1, 2, 3, 4].map((index) => (
                hand.board[index]
                  ? <PlayingCard card={hand.board[index]} size="large" key={index} />
                  : <span className="pk-card pk-card-large pk-slot" key={index} />
              ))}
            </div>
            {hand.result ? (
              <div className="pk-result">
                {hand.result.pots.map((result, index) => {
                  const handName = hand.result!.revealed[result.winnerIds[0]!]?.handName;
                  const refund = !hand.result!.uncontested && result.eligibleIds.length === 1;
                  return (
                    <p key={index}>
                      {hand.result!.pots.length > 1 && <span>{index === 0 ? "主池" : `边池 ${index}`}</span>}
                      {result.winnerIds.map(nameOf).join("、")} {refund ? "收回" : "赢得"} <b>{result.amount}</b>
                      {hand.result!.uncontested ? "（其他人弃牌）" : !refund && handName ? `（${handName}）` : ""}
                    </p>
                  );
                })}
                {hand.result.eliminatedIds.length > 0 && <p className="pk-out-note">{hand.result.eliminatedIds.map(nameOf).join("、")} 筹码输光，出局</p>}
              </div>
            ) : (
              <div className="pk-pot">底池 <b>{pot}</b></div>
            )}
          </div>
          {match.players.map((player, seat) => (
            <Seat
              key={player.id}
              player={player}
              seat={seat}
              match={match}
              position={layout[(seat - mySeat + count) % count]!}
              member={room.members.find((member) => member.id === player.id)}
              remainingMs={remainingMs}
              isMe={seat === mySeat}
            />
          ))}
        </div>
      </section>

      <section className={`pk-me${myTurn ? " active" : ""}`} aria-label="你的手牌和行动">
        <div className="pk-me-cards">
          {me.holeCards.length > 0
            ? me.holeCards.map((card) => <PlayingCard card={card} size="large" dim={me.folded} key={card.id} />)
            : <span className="pk-me-empty">{me.place !== null ? `你已出局（第 ${me.place} 名），可以继续观战` : "等待下一手"}</span>}
        </div>
        <div className="pk-me-info">
          <span>筹码 <b>{me.chips}</b></span>
          {myBest && !me.folded && <span>当前牌型 <b>{myBest}</b></span>}
          {me.folded && match.phase === "playing" && <span>你已弃牌</span>}
        </div>
        <div className="pk-actions">
          {myTurn && legal ? (
            <>
              {remainingMs !== null && match.settings.actionSeconds > 0 && <span className="pk-countdown">{Math.ceil(remainingMs / 1000)} 秒</span>}
              <button type="button" className="pk-action-button fold" disabled={busy} onClick={() => onAction({ type: "fold" })}>弃牌</button>
              {legal.canCheck
                ? <button type="button" className="pk-action-button" disabled={busy} onClick={() => onAction({ type: "check" })}>过牌</button>
                : <button type="button" className="pk-action-button" disabled={busy} onClick={() => onAction({ type: "call" })}>
                    {me.chips <= legal.toCall ? `全下跟注 ${me.chips}` : `跟注 ${legal.toCall}`}
                  </button>}
              {legal.canRaise && (
                <div className="pk-raise">
                  <div className="pk-raise-presets">
                    <button type="button" onClick={() => setRaiseTo(legal.minRaiseTo)}>最小</button>
                    <button type="button" onClick={() => setRaiseTo(potRaise(0.5))}>½ 底池</button>
                    <button type="button" onClick={() => setRaiseTo(potRaise(1))}>底池</button>
                    <button type="button" onClick={() => setRaiseTo(legal.maxRaiseTo)}>全下</button>
                  </div>
                  <input
                    type="range"
                    min={legal.minRaiseTo}
                    max={legal.maxRaiseTo}
                    step={1}
                    value={raiseTo}
                    onChange={(event) => setRaiseTo(Number(event.target.value))}
                    aria-label="加注金额"
                  />
                  <input
                    className="pk-raise-input"
                    type="number"
                    min={legal.minRaiseTo}
                    max={legal.maxRaiseTo}
                    value={raiseTo}
                    onChange={(event) => setRaiseTo(Number(event.target.value))}
                    aria-label="加注到"
                  />
                  <button
                    type="button"
                    className="pk-action-button raise"
                    disabled={busy || raiseTo < legal.minRaiseTo || raiseTo > legal.maxRaiseTo}
                    onClick={() => onAction(raiseTo === legal.maxRaiseTo ? { type: "allIn" } : { type: "raise", to: raiseTo })}
                  >
                    {raiseTo === legal.maxRaiseTo ? `全下 ${raiseTo}` : `${raiseVerb} ${raiseTo}`}
                  </button>
                </div>
              )}
              {!legal.canRaise && legal.canAllIn && me.chips > legal.toCall && (
                <button type="button" className="pk-action-button raise" disabled={busy} onClick={() => onAction({ type: "allIn" })}>全下 {legal.maxRaiseTo}</button>
              )}
            </>
          ) : (
            <span className="pk-waiting">
              {match.phase === "handOver" ? "下一手马上开始…" : match.phase === "finished" ? "比赛结束" : me.place !== null ? "观战中" : activeName ? `等待 ${activeName} 行动` : ""}
            </span>
          )}
        </div>
      </section>

      <div className="pk-chat">{chat}</div>

      {match.phase === "finished" && <RematchPanel room={room} match={match} onRematch={onRematch} />}
    </div>
  );
}

export default PokerTable;
