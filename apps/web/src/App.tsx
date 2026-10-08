import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { LobbyRoomSnapshot, PokerAction, PublicRoomSummary, Settings } from "@poker/game";
import { useConfirm } from "./confirm.js";
import PokerTable, { cardImage } from "./PokerTable.js";
import GameRules from "./GameRules.js";
import OnlineRooms from "./OnlineRooms.js";
import RoomChat from "./RoomChat.js";
import { socket } from "./socket.js";
import { ThemeToggle, useTheme } from "./theme.js";
import { useVoice } from "./voice.js";

type EntryMode = "create" | "join";

const validRoomCode = /^[A-HJ-NP-Z2-9]{6}$/;

// 线上游戏中心在站点根路径；本地开发时跑在 5175 端口。
const CENTER_URL = import.meta.env.DEV ? `${window.location.protocol}//${window.location.hostname}:5175/` : "/";

function normalizeRoomCode(value: string): string {
  return value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, "").slice(0, 6);
}

function App() {
  const [mode, setMode] = useState<EntryMode>("create");
  const [name, setName] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [room, setRoom] = useState<LobbyRoomSnapshot | null>(null);
  const [connected, setConnected] = useState(socket.connected);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [lobbyRooms, setLobbyRooms] = useState<PublicRoomSummary[]>([]);
  const voice = useVoice(room);
  // 白天 / 夜间画面：首页、等待大厅、牌桌共用，顶栏按钮随时切换；和游戏中心、其他游戏共用同一个选择。
  const [theme, toggleTheme] = useTheme();
  const themeToggle = <ThemeToggle theme={theme} onToggle={toggleTheme} />;
  // 解散房间等确认用像素弹窗。
  const [confirm, confirmDialog] = useConfirm();

  // 在房间里时服务端不推送在线牌桌列表；回到首页时主动拉一次最新的。
  useEffect(() => {
    if (room || !socket.connected) return;
    socket.emit("lobby:get", (response) => {
      if (response.ok) setLobbyRooms(response.data);
    });
  }, [room === null]);

  useEffect(() => {
    const handleConnect = () => {
      setConnected(true);
      socket.emit("lobby:get", (response) => {
        if (response.ok) setLobbyRooms(response.data);
      });
    };
    const handleDisconnect = () => setConnected(false);
    const handleRoomUpdate = (snapshot: LobbyRoomSnapshot) => setRoom(snapshot);
    const handleRoomError = (message: string) => setError(message);
    const handleLobbyUpdate = (rooms: PublicRoomSummary[]) => setLobbyRooms(rooms);
    const handleRoomClosed = ({ reason }: { reason: string }) => {
      setRoom(null);
      setBusy(false);
      setError("");
      setNotice(reason);
    };

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("room:updated", handleRoomUpdate);
    socket.on("room:error", handleRoomError);
    socket.on("lobby:updated", handleLobbyUpdate);
    socket.on("room:closed", handleRoomClosed);
    socket.connect();

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("room:updated", handleRoomUpdate);
      socket.off("room:error", handleRoomError);
      socket.off("lobby:updated", handleLobbyUpdate);
      socket.off("room:closed", handleRoomClosed);
      socket.disconnect();
    };
  }, []);

  const canSubmit = useMemo(() => {
    if (!connected || busy || name.trim().length < 2 || name.trim().length > 18) return false;
    return mode === "create" || validRoomCode.test(roomCode);
  }, [busy, connected, mode, name, roomCode]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    setBusy(true);
    const nickname = name.trim();

    const complete = (response: { ok: true; data: LobbyRoomSnapshot } | { ok: false; error: string }) => {
      setBusy(false);
      if (!response.ok) {
        setError(response.error);
        return;
      }
      setRoom(response.data);
      setNotice(mode === "create"
        ? "房间已创建，可以邀请朋友加入。"
        : response.data.status === "playing" ? "已回到对局，继续游戏吧。" : "已加入房间。");
    };

    if (mode === "create") {
      socket.emit("room:create", { name: nickname }, complete);
    } else {
      socket.emit("room:join", { name: nickname, code: roomCode }, complete);
    }
  }

  function startGame() {
    setError("");
    setBusy(true);
    socket.emit("room:start", (response) => {
      setBusy(false);
      if (!response.ok) {
        setError(response.error);
        return;
      }
      setRoom(response.data);
      setNotice("对局已开始，祝你好运。" );
    });
  }

  function leaveRoom() {
    setBusy(true);
    socket.emit("room:leave", (response) => {
      setBusy(false);
      if (!response.ok) {
        setError(response.error);
        return;
      }
      setRoom(null);
      setError("");
      setNotice("已离开房间。" );
    });
  }

  function submitGameAction(action: PokerAction) {
    setBusy(true);
    setError("");
    setNotice("");
    socket.emit("game:action", action, (response) => {
      setBusy(false);
      if (!response.ok) {
        setError(response.error);
        return;
      }
      setRoom(response.data);
      setNotice("行动已同步。" );
    });
  }

  /** 房间管理类操作：只关心成败，界面更新由服务端广播。 */
  function roomCommand(send: (ack: (response: { ok: true; data: void } | { ok: false; error: string }) => void) => void) {
    setError("");
    send((response) => {
      if (!response.ok) setError(response.error);
    });
  }

  function updateSettings(settings: Settings) {
    setError("");
    socket.emit("room:settings", settings, (response) => {
      if (!response.ok) setError(response.error);
    });
  }

  const kickMember = (memberId: string) => roomCommand((ack) => socket.emit("room:kick", memberId, ack));
  const voteRematch = (accept: boolean) => roomCommand((ack) => socket.emit("room:rematch", accept, ack));
  async function dissolveRoom() {
    const ok = await confirm({
      title: "解散房间？",
      detail: "所有玩家都会被移出，当前对局也会结束。",
      confirmLabel: "解散",
    });
    if (ok) roomCommand((ack) => socket.emit("room:dissolve", ack));
  }

  async function copyRoomCode() {
    if (!room) return;
    try {
      await navigator.clipboard.writeText(room.code);
      setNotice("房间码已复制。" );
    } catch {
      setNotice("请手动复制房间码。" );
    }
  }

  if (room?.status === "playing" && room.match) {
    return (
      <main className="game-shell">
        <PokerTable
          room={room}
          busy={busy}
          error={error}
          notice={notice}
          brand={<Brand />}
          connection={<ConnectionStatus connected={connected} />}
          themeToggle={themeToggle}
          chat={<RoomChat room={room} voice={voice} />}
          onAction={submitGameAction}
          onRematch={voteRematch}
          onDissolve={dissolveRoom}
        />
        {confirmDialog}
      </main>
    );
  }

  if (room) {
    return (
      <main className="app-shell">
        <header className="topbar">
          <Brand />
          <div className="topbar-right">
            {themeToggle}
            <ConnectionStatus connected={connected} />
          </div>
        </header>
        <GameRules />
        <RoomView
          room={room}
          busy={busy}
          error={error}
          notice={notice}
          onCopyCode={copyRoomCode}
          onLeave={leaveRoom}
          onStart={startGame}
          onKick={kickMember}
          onDissolve={dissolveRoom}
          onSettings={updateSettings}
        />
        <RoomChat room={room} voice={voice} />
        <footer className="page-footer">围坐桌边，专注每一次选择。</footer>
        {confirmDialog}
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <Brand />
        <div className="topbar-right">
          <a className="center-link" href={CENTER_URL}>← 游戏中心</a>
          {themeToggle}
          <ConnectionStatus connected={connected} />
        </div>
      </header>

      <section className="welcome-grid">
        <div className="welcome-copy">
          <div className="eyebrow"><span className="eyebrow-line" /> 无限注淘汰赛 · 2—6 人</div>
          <h1>Texas Hold'em</h1>
          <p className="welcome-description">
            创建一张私人牌桌，或输入房间码加入朋友的比赛。所有人同样的筹码起步，打到最后一人获胜。
          </p>
          <div className="poker-showcase" aria-hidden="true">
            <img className="pixel-mini-card" src={cardImage({ id: "", suit: "S", rank: 14 })} alt="" />
            <img className="pixel-mini-card" src={cardImage({ id: "", suit: "H", rank: 13 })} alt="" />
            <span className="showcase-caption">两张底牌 · 五张公共牌</span>
          </div>
        </div>

        <section className="entry-card" aria-labelledby="entry-title">
          <div className="entry-card-heading">
            <div>
              <span className="section-kicker">准备开始</span>
              <h2 id="entry-title">进入牌桌</h2>
            </div>
            <span className="step-indicator">01 <i /> 02</span>
          </div>

          <div className="mode-switch" role="tablist" aria-label="选择房间操作">
            <button
              className={mode === "create" ? "mode-tab active" : "mode-tab"}
              type="button"
              role="tab"
              aria-selected={mode === "create"}
              onClick={() => { setMode("create"); setError(""); }}
            >
              创建房间
            </button>
            <button
              className={mode === "join" ? "mode-tab active" : "mode-tab"}
              type="button"
              role="tab"
              aria-selected={mode === "join"}
              onClick={() => { setMode("join"); setError(""); }}
            >
              加入房间
            </button>
          </div>

          <form className="entry-form" onSubmit={handleSubmit}>
            <label className="field-label" htmlFor="player-name">你的昵称</label>
            <input
              id="player-name"
              className="text-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="输入 2–18 个字符"
              minLength={2}
              maxLength={18}
              autoComplete="nickname"
              required
            />

            {mode === "create" ? (
              <>
                <p className="field-hint">最多 6 人，至少 2 人后房主即可开始；筹码和盲注在房间里设置。</p>
              </>
            ) : (
              <>
                <label className="field-label field-label-spaced" htmlFor="room-code">房间码</label>
                <input
                  id="room-code"
                  className="text-input room-code-input"
                  value={roomCode}
                  onChange={(event) => setRoomCode(normalizeRoomCode(event.target.value))}
                  placeholder="例如：7KQ2TX"
                  autoComplete="off"
                  maxLength={6}
                  required
                />
                <p className="field-hint">房间码为 6 位字母或数字，不含易混淆字符。掉线后用原昵称和房间码可回到进行中的对局。</p>
              </>
            )}

            {error && <p className="feedback feedback-error" role="alert">{error}</p>}
            {notice && <p className="feedback feedback-success" role="status">{notice}</p>}

            <button className="primary-button" type="submit" disabled={!canSubmit}>
              {busy ? <><span className="spinner" /> 正在连接</> : mode === "create" ? "创建私人房间" : "加入牌桌"}
              {!busy && <span aria-hidden="true">↗</span>}
            </button>
          </form>
          <div className="entry-footnote"><span className="lock-icon">◇</span> 私人房间 · 邀请制加入</div>
        </section>
      </section>

      <section className="how-it-works" aria-label="游戏流程">
        <div className="how-item"><span className="how-number">01</span><span>创建或加入</span></div>
        <span className="how-divider" />
        <div className="how-item"><span className="how-number">02</span><span>等待朋友就位</span></div>
        <span className="how-divider" />
        <div className="how-item"><span className="how-number">03</span><span>开始对局</span></div>
      </section>
      <OnlineRooms rooms={lobbyRooms} connected={connected} />
      <footer className="page-footer">围坐桌边，专注每一次选择。</footer>
    </main>
  );
}

function Brand() {
  return (
    <a className="brand" href={import.meta.env.BASE_URL} aria-label="德州扑克首页">
      <span className="brand-mark brand-mark-poker" aria-hidden="true">♠</span>
      <span className="brand-name">德州扑克<span> TEXAS HOLD'EM</span></span>
    </a>
  );
}

function ConnectionStatus({ connected }: { connected: boolean }) {
  return (
    <div className={connected ? "connection-status online" : "connection-status"}>
      <span className="connection-dot" />
      {connected ? "服务已连接" : "连接中…"}
    </div>
  );
}

const CHIP_OPTIONS = [500, 1000, 2000, 5000, 10000];
const BLIND_OPTIONS: [number, number][] = [[5, 10], [10, 20], [25, 50], [50, 100], [100, 200], [250, 500]];
const INCREASE_OPTIONS: { value: Settings["blindIncreaseMinutes"]; label: string }[] = [
  { value: 0, label: "不涨" },
  { value: 10, label: "每 10 分钟翻倍" },
  { value: 15, label: "每 15 分钟翻倍" },
  { value: 20, label: "每 20 分钟翻倍" },
];
const TIMER_OPTIONS: { value: Settings["actionSeconds"]; label: string }[] = [
  { value: 30, label: "30 秒" },
  { value: 60, label: "1 分钟" },
  { value: 0, label: "不限时" },
];

/** 比赛设置：房主可改，其他人只读。 */
function SettingsPanel({ settings, editable, onChange }: { settings: Settings; editable: boolean; onChange: (settings: Settings) => void }) {
  const update = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });
  const blindKey = `${settings.smallBlind}/${settings.bigBlind}`;
  return (
    <div className="settings-panel">
      <div className="panel-label">比赛设置 <span>{editable ? "开局前可修改" : "由房主设置"}</span></div>
      <label className="settings-row">
        <span>初始筹码</span>
        <select value={settings.startingChips} disabled={!editable} onChange={(event) => update({ startingChips: Number(event.target.value) })}>
          {[...new Set([...CHIP_OPTIONS, settings.startingChips])].sort((a, b) => a - b).map((chips) => <option key={chips} value={chips}>{chips}</option>)}
        </select>
      </label>
      <label className="settings-row">
        <span>起始盲注</span>
        <select
          value={blindKey}
          disabled={!editable}
          onChange={(event) => {
            const [smallBlind, bigBlind] = event.target.value.split("/").map(Number);
            update({ smallBlind: smallBlind!, bigBlind: bigBlind! });
          }}
        >
          {BLIND_OPTIONS.map(([small, big]) => (
            <option key={`${small}/${big}`} value={`${small}/${big}`} disabled={big * 10 > settings.startingChips}>
              {small} / {big}{big * 10 > settings.startingChips ? "（筹码不足 10 个大盲）" : ""}
            </option>
          ))}
        </select>
      </label>
      <label className="settings-row">
        <span>盲注上涨</span>
        <select value={settings.blindIncreaseMinutes} disabled={!editable} onChange={(event) => update({ blindIncreaseMinutes: Number(event.target.value) as Settings["blindIncreaseMinutes"] })}>
          {INCREASE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      <div className="settings-row">
        <span>行动限时</span>
        <div className="settings-segments" role="group" aria-label="行动限时">
          {TIMER_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={settings.actionSeconds === option.value ? "selected" : ""}
              disabled={!editable}
              aria-pressed={settings.actionSeconds === option.value}
              onClick={() => update({ actionSeconds: option.value })}
            >{option.label}</button>
          ))}
        </div>
      </div>
      {settings.actionSeconds === 0 && <p className="settings-note">不限时：有人掉线会一直等他回来，房主可以解散房间。</p>}
    </div>
  );
}

function RoomView({
  room,
  busy,
  error,
  notice,
  onCopyCode,
  onLeave,
  onStart,
  onKick,
  onDissolve,
  onSettings,
}: {
  room: LobbyRoomSnapshot;
  busy: boolean;
  error: string;
  notice: string;
  onCopyCode: () => void;
  onLeave: () => void;
  onStart: () => void;
  onKick: (memberId: string) => void;
  onDissolve: () => void;
  onSettings: (settings: Settings) => void;
}) {
  const currentMember = room.members.find((member) => member.id === socket.id);
  const isHost = currentMember?.isHost ?? false;
  const openSeats = Math.max(0, 6 - room.members.length);

  return (
    <section className="room-layout">
      <div className="room-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-line" /> {room.status === "waiting" ? "等待大厅" : "对局已创建"}</div>
          <h1>{room.status === "waiting" ? "牌桌准备中。" : "好戏即将开始。"}</h1>
          <p>{room.status === "waiting" ? "把房间码分享给朋友，等大家就位后开始。" : "房间状态已同步，下一步将接入完整棋盘。"}</p>
        </div>
        <div className="room-heading-actions">
          {isHost && <button className="quiet-button danger" type="button" onClick={onDissolve} disabled={busy}>解散房间</button>}
          <button className="quiet-button" type="button" onClick={onLeave} disabled={busy || room.status === "playing"}>
            离开房间
          </button>
        </div>
      </div>

      {room.status === "waiting" ? (
        <div className="room-grid">
          <section className="room-panel room-code-panel">
            <div className="panel-label">房间码 <span>仅分享给朋友</span></div>
            <button className="room-code-display" type="button" onClick={onCopyCode} title="复制房间码">
              {room.code}<span aria-hidden="true">⧉</span>
            </button>
            <div className="room-code-caption">点击复制 · 6 位邀请代码</div>
            <SettingsPanel settings={room.settings} editable={isHost} onChange={onSettings} />
          </section>

          <section className="room-panel player-panel">
            <div className="panel-topline">
              <div className="panel-label">玩家 <span>{room.members.length} / 6</span></div>
              <span className="waiting-pill"><i /> 等待中</span>
            </div>
            <div className="player-list">
              {room.members.map((member, index) => (
                <div className="player-row" key={member.id}>
                  <div className={`player-avatar avatar-${index + 1}`}>{member.name.slice(0, 1).toUpperCase()}</div>
                  <div className="player-details">
                    <strong>{member.name}{member.id === socket.id ? <small>你</small> : null}</strong>
                    <span>{member.isHost ? "房主" : "已加入"}</span>
                  </div>
                  {member.isHost && <span className="host-badge">房主</span>}
                  {isHost && !member.isHost && (
                    <button className="kick-button" type="button" onClick={() => onKick(member.id)} title={`把 ${member.name} 移出房间`}>移出</button>
                  )}
                </div>
              ))}
              {Array.from({ length: openSeats }, (_, index) => (
                <div className="player-row open-seat" key={`open-${index}`}>
                  <div className="empty-avatar"><span>＋</span></div>
                  <div className="player-details"><strong>等待玩家加入</strong><span>分享房间码邀请朋友</span></div>
                </div>
              ))}
            </div>
            <div className="room-actions">
              {isHost ? (
                <button className="primary-button" type="button" onClick={onStart} disabled={busy || room.members.length < 2}>
                  {busy ? <><span className="spinner" /> 正在开始</> : "开始对局"}<span aria-hidden="true">↗</span>
                </button>
              ) : (
                <div className="host-wait-note"><span className="pulse-dot" /> 等待房主开始对局</div>
              )}
              {isHost && room.members.length < 2 && <p className="field-hint centered">还需要至少 1 位玩家加入。</p>}
            </div>
          </section>
        </div>
      ) : null}

      {error && <p className="feedback feedback-error room-feedback" role="alert">{error}</p>}
      {notice && <p className="feedback feedback-success room-feedback" role="status">{notice}</p>}
      <div className="room-secure-note"><span>◇</span> 房间为私人邀请制，不会出现在公开列表。</div>
    </section>
  );
}

export default App;
