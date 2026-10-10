/**
 * 德州扑克的新手教程：在浏览器里按剧本打三手牌（packages/game/src/tutorial.ts），
 * 牌桌就是真正对局的 PokerTable，咕噜嘎的对话框叠在上面；剧本走完接练习局，对手交给人机。
 * 不连服务器，不占房间；首页、等候房间都能进来（从等候房间进来时，房主开局会自动回到牌桌，见 App.tsx）。
 */
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  DEFAULT_ROOM_ACCESS,
  TUTORIAL_DEALER,
  TUTORIAL_RIVALS,
  TUTORIAL_SELF,
  TUTORIAL_SETTINGS,
  TUTORIAL_STEPS,
  applyTutorial,
  botCommand,
  createPracticeGame,
  createTutorialGame,
  sameCommand,
  tutorialActor,
  viewForPlayer,
  type LobbyMember,
  type LobbyRoomSnapshot,
  type MatchState,
  type TutorialCommand,
  type TutorialStep,
} from "@poker/game";
import PokerTable from "./PokerTable.js";
import { Coach, isTouchDevice, StepPips, type CoachView } from "./tutorial/Coach.js";
import { writeTutorial } from "./tutorial/storage.js";
import { useTutorial } from "./tutorial/useTutorial.js";
import { GAME_ID } from "./tutorialGame.js";

const TUTORIAL_CODE = "GULU01";

export const HAND_RANKS = [
  ["同花顺", "同花色的五张连牌"],
  ["四条", "四张同点数"],
  ["葫芦", "三条 + 一对"],
  ["同花", "五张同花色"],
  ["顺子", "五张连牌"],
  ["三条", "三张同点数"],
  ["两对", "两个对子"],
  ["一对", "两张同点数"],
  ["高牌", "以上都不是"],
] as const;

export default function TutorialMode({ name, brand, themeToggle, waitingRoom, onExit }: {
  /** 首页填过的昵称；没填叫「新玩家」。 */
  name: string;
  brand: ReactNode;
  themeToggle: ReactNode;
  /** 从等候房间点进来的：那个房间的房间码。 */
  waitingRoom?: string | undefined;
  onExit: () => void;
}) {
  const selfName = name.trim().length >= 2 ? name.trim() : "新玩家";
  // 剧本的三手牌按剧本摆；「再练一局」之后正常洗牌。
  const scripted = useRef(true);

  const tutorial = useTutorial<MatchState, TutorialCommand, TutorialStep>({
    steps: TUTORIAL_STEPS,
    self: TUTORIAL_SELF,
    start: () => createTutorialGame(selfName),
    restart: () => {
      scripted.current = false;
      return createPracticeGame(selfName);
    },
    apply: (state, playerId, command) => applyTutorial(state, playerId, command, { scripted: scripted.current }),
    same: sameCommand,
    actor: tutorialActor,
    bot: (state, playerId) => (playerId === TUTORIAL_DEALER ? { type: "nextHand" } : botCommand(viewForPlayer(state, playerId), playerId)),
    // 一手打完先看几秒结果再发下一手；人机像真人一样想一下。
    botDelay: (state) => (state.phase === "handOver" ? 4000 : 1100),
    watchDelay: (command) => (command.type === "nextHand" ? 1800 : 1500),
  });
  const { game, step, index, practice, flash } = tutorial;

  // 走到最后一步就算学完（之后首页不再邀请）
  useEffect(() => {
    if (practice || (step?.kind === "info" && step.finale)) writeTutorial(GAME_ID, "done");
  }, [practice, step?.id]);

  function leave() {
    writeTutorial(GAME_ID, "skipped");
    onExit();
  }

  const members = useMemo<LobbyMember[]>(() => [
    { id: TUTORIAL_SELF, name: selfName, isHost: false, connected: true },
    ...TUTORIAL_RIVALS.map((rival) => ({ id: rival.id, name: rival.name, isHost: false, connected: true, bot: true })),
  ], [selfName]);
  const room = useMemo<LobbyRoomSnapshot>(() => ({
    code: TUTORIAL_CODE,
    spectators: [],
    access: DEFAULT_ROOM_ACCESS,
    status: "playing",
    members,
    chat: [],
    settings: TUTORIAL_SETTINGS,
    voice: [],
    match: viewForPlayer(game, TUTORIAL_SELF),
  }), [game, members]);

  let view: CoachView | null = null;
  if (step) {
    const note = isTouchDevice() && step.noteTouch ? step.noteTouch : step.note;
    const finale = step.kind === "info" && step.finale === true;
    view = {
      key: step.id,
      say: step.say,
      ...(note ? { note } : {}),
      ...(flash ? { flash } : {}),
      anchor: step.anchor ?? null,
      focus: step.kind !== "watch",
      face: flash ? "surprised" : step.face ?? "base",
      footer: (
        <>
          <StepPips index={index} total={TUTORIAL_STEPS.length} />
          {!finale && <button className="tut-link" type="button" onClick={leave}>跳过教程</button>}
        </>
      ),
      actions: step.kind !== "info" ? null : finale ? (
        <>
          <button className="quiet-button" type="button" onClick={onExit}>结束教程</button>
          <button className="primary-button tut-main" type="button" onClick={tutorial.startPractice}>和咕噜一号打完这局</button>
        </>
      ) : (
        <button className="primary-button tut-main" type="button" onClick={tutorial.next}>下一步 ▶</button>
      ),
    };
  }

  return (
    <div className={practice ? "tut-practice" : "tut-script"} style={{ display: "contents" }}>
      <PokerTable
        room={room}
        busy={false}
        error=""
        notice=""
        brand={brand}
        connection={
          <>
            <span className="connection-status online"><span className="connection-dot" />{practice ? "练习局" : "新手教程"}</span>
            <button className="quiet-button tut-exit" type="button" onClick={practice ? onExit : leave}>退出教程</button>
          </>
        }
        themeToggle={themeToggle}
        chat={<Checklist index={index} practice={practice} waitingRoom={waitingRoom} />}
        onAction={tutorial.onCommand}
        onRematch={() => undefined}
        onDissolve={() => undefined}
        onAuto={() => undefined}
        watchId={TUTORIAL_SELF}
        onWatch={() => undefined}
        onLeave={onExit}
        selfMemberId={TUTORIAL_SELF}
        mode={practice ? "practice" : "tutorial"}
        finalActions={
          <>
            <button className="quiet-button" type="button" onClick={onExit}>结束教程</button>
            <button className="primary-button" type="button" onClick={tutorial.newPractice}>再练一局</button>
          </>
        }
      />
      {view && <Coach view={view} />}
    </div>
  );
}

/** 侧栏（真实对局里是聊天）：牌型大小表一直在；剧本进行中列出这次学哪几样，练习局只留一句话。 */
function Checklist({ index, practice, waitingRoom }: { index: number; practice: boolean; waitingRoom: string | undefined }) {
  const lessons = TUTORIAL_STEPS.map((step, at) => ({ step, at })).filter(({ step }) => step.lesson);
  const done = lessons.filter(({ at }) => at < index).length;
  return (
    <section className="room-chat tut-checklist" aria-label="新手教程进度">
      {practice ? (
        <>
          <h3>练习局 <small>教程学完了</small></h3>
          <p>拿不准就点「提示」（键盘 H），我告诉你我会怎么打。</p>
        </>
      ) : (
        <>
          <h3>新手教程 <small>{done}/{lessons.length}</small></h3>
          <ul>
            {lessons.map(({ step, at }) => {
              const state = at < index ? "done" : at === index ? "now" : "";
              return (
                <li key={step.id} className={state}>
                  <i aria-hidden="true">{state === "done" ? "✓" : state === "now" ? "▶" : "·"}</i>
                  {step.lesson}
                </li>
              );
            })}
          </ul>
        </>
      )}
      <div className="pk-ranks" data-tutorial="hand-ranks">
        <h3>牌型 <small>大 → 小</small></h3>
        <ol>
          {HAND_RANKS.map(([title, text]) => <li key={title}><b>{title}</b><span>{text}</span></li>)}
        </ol>
      </div>
      {waitingRoom && <p>你还在房间 {waitingRoom} 里，房主一开局就自动回到牌桌。</p>}
    </section>
  );
}
