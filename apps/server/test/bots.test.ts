import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { io as createClient, type Socket } from "socket.io-client";
import {
  legalActions,
  type AckResponse,
  type ClientToServerEvents,
  type LobbyRoomSnapshot,
  type MatchState,
  type MatchView,
  type PokerAction,
  type PublicRoomSummary,
  type ServerToClientEvents,
  type Settings,
} from "@poker/game";

type TestSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const clients = new Set<TestSocket>();
const latest = new Map<TestSocket, LobbyRoomSnapshot>();
let serverUrl = "";
let httpServer: typeof import("../src/index.js").httpServer;
let serverIo: typeof import("../src/index.js").io;
let nameSeq = 0;

/** 筹码少、盲注大，几手就能打完一场。 */
const SHORT: Settings = { startingChips: 200, smallBlind: 10, bigBlind: 20, blindIncreaseMinutes: 0, actionSeconds: 30 };

function connect(): Promise<TestSocket> {
  return new Promise((resolve, reject) => {
    const client: TestSocket = createClient(serverUrl, { transports: ["websocket"], reconnection: false });
    clients.add(client);
    client.on("room:updated", (room) => latest.set(client, room));
    client.once("connect", () => resolve(client));
    client.once("connect_error", reject);
  });
}

function nick(prefix: string): string {
  nameSeq += 1;
  return `${prefix}${nameSeq}`;
}

function call<T>(send: (ack: (response: AckResponse<T>) => void) => void): Promise<AckResponse<T>> {
  return new Promise((resolve) => send(resolve));
}

async function create(client: TestSocket, name: string, settings: Settings = SHORT): Promise<LobbyRoomSnapshot> {
  const response = await call<LobbyRoomSnapshot>((ack) => client.emit("room:create", { name }, ack));
  if (!response.ok) throw new Error(response.error);
  const updated = await call<LobbyRoomSnapshot>((ack) => client.emit("room:settings", settings, ack));
  if (!updated.ok) throw new Error(updated.error);
  return updated.data;
}

const addBot = (client: TestSocket) => call<void>((ack) => client.emit("room:add-bot", ack));
const start = (client: TestSocket) => call<LobbyRoomSnapshot>((ack) => client.emit("room:start", ack));
const join = (client: TestSocket, name: string, code: string) => call<LobbyRoomSnapshot>((ack) => client.emit("room:join", { name, code }, ack));

function lobby(client: TestSocket): Promise<PublicRoomSummary[]> {
  return new Promise((resolve) => client.emit("lobby:get", (response) => resolve(response.ok ? response.data : [])));
}

function updateWhere(client: TestSocket, test: (room: LobbyRoomSnapshot) => boolean, timeoutMs = 20_000): Promise<LobbyRoomSnapshot> {
  return new Promise((resolve, reject) => {
    const current = latest.get(client);
    if (current && test(current)) {
      resolve(current);
      return;
    }
    const timer = setTimeout(() => {
      client.off("room:updated", handler);
      reject(new Error("等不到想要的房间状态"));
    }, timeoutMs);
    const handler = (room: LobbyRoomSnapshot) => {
      if (!test(room)) return;
      clearTimeout(timer);
      client.off("room:updated", handler);
      resolve(room);
    };
    client.on("room:updated", handler);
  });
}

/** 某位玩家（按名字）在这场比赛里主动行动的次数。 */
function actions(room: LobbyRoomSnapshot | undefined, name: string): number {
  return room?.match?.players.find((player) => player.name === name)?.stats.actions ?? 0;
}

function myTurn(match: MatchView | undefined): boolean {
  return Boolean(match && match.phase === "playing" && match.mySeat !== null && match.hand.turn === match.mySeat);
}

/** 真人：能过就过，否则跟注（筹码不够就全下）。 */
function humanMove(match: MatchView): PokerAction {
  const legal = legalActions(match as unknown as MatchState, match.mySeat!)!;
  if (legal.canCheck) return { type: "check" };
  return match.players[match.mySeat!]!.chips > legal.toCall ? { type: "call" } : { type: "allIn" };
}

/** 轮到这个真人时自动行动；返回停止函数。 */
function autoplay(client: TestSocket): () => void {
  let sentFor = "";
  const handler = (room: LobbyRoomSnapshot) => {
    const match = room.match;
    if (!myTurn(match)) return;
    const key = `${match!.hand.number}:${match!.hand.street}:${match!.players.map((player) => player.handBet).join(",")}`;
    if (sentFor === key) return;
    sentFor = key;
    client.emit("game:action", humanMove(match!), () => {});
  };
  client.on("room:updated", handler);
  const current = latest.get(client);
  if (current) handler(current);
  return () => client.off("room:updated", handler);
}

describe("人机", () => {
  beforeAll(async () => {
    // 人机立刻行动；行动限时 30「秒」= 300 毫秒；离线 200 毫秒后代打（服务端在导入时读这些变量）。
    Object.assign(process.env, {
      BOT_DELAY_SCALE: "0",
      ACTION_TIME_UNIT_MS: "10",
      HAND_PAUSE_MS: "20",
      OFFLINE_GRACE_MS: "200",
      ROOM_ABANDON_MS: "400",
      REMATCH_TIMEOUT_MS: "5000",
    });
    const serverModule = await import("../src/index.js");
    httpServer = serverModule.httpServer;
    serverIo = serverModule.io;
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, resolve);
    });
    serverUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const client of clients) client.disconnect();
    await new Promise<void>((resolve) => serverIo.close(() => resolve()));
  });

  it("只有房主能加人机；坐满后加不了；房主能移出人机；首页列表标出人机", async () => {
    const host = await connect();
    const hostName = nick("房主");
    const { code } = await create(host, hostName);
    const guest = await connect();
    expect((await join(guest, nick("客人"), code)).ok).toBe(true);

    expect((await addBot(guest)).ok).toBe(false);
    for (let seat = 2; seat < 6; seat += 1) expect((await addBot(host)).ok).toBe(true);
    const room = await updateWhere(host, (snapshot) => snapshot.members.length === 6);
    const bot = room.members.find((member) => member.bot)!;
    expect(bot).toMatchObject({ name: "咕噜一号", isHost: false, connected: true, bot: true });
    expect(room.members.filter((member) => member.bot).map((member) => member.name)).toEqual(["咕噜一号", "咕噜二号", "咕噜三号", "咕噜四号"]);
    expect((await addBot(host)).ok).toBe(false);

    const summary = (await lobby(host)).find((candidate) => candidate.players[0]?.name === hostName)!;
    expect(summary.players.find((player) => player.name === "咕噜一号")?.bot).toBe(true);
    expect(summary.players.find((player) => player.name === hostName)?.bot).toBeUndefined();

    expect((await call<void>((ack) => host.emit("room:kick", bot.id, ack))).ok).toBe(true);
    await updateWhere(host, (snapshot) => snapshot.members.length === 5 && !snapshot.members.some((member) => member.name === "咕噜一号"));
    // 移出后空出来的名字可以再用。
    expect((await addBot(host)).ok).toBe(true);
    await updateWhere(host, (snapshot) => snapshot.members.some((member) => member.name === "咕噜一号"));
  });

  it("一个人加满人机就能开局，人机把整场打完；人机自动同意再来一局", async () => {
    const host = await connect();
    await create(host, nick("独行"));
    for (let seat = 1; seat < 4; seat += 1) expect((await addBot(host)).ok).toBe(true);
    const names = (await updateWhere(host, (snapshot) => snapshot.members.length === 4)).members.map((member) => member.name);
    expect(names.slice(1)).toEqual(["咕噜一号", "咕噜二号", "咕噜三号"]);

    expect((await start(host)).ok).toBe(true);
    const stop = autoplay(host);
    const finished = await updateWhere(host, (snapshot) => snapshot.match?.phase === "finished", 60_000);
    stop();
    expect(finished.match!.winnerId).not.toBeNull();
    const bots = finished.members.filter((member) => member.bot).map((member) => member.id);
    expect([...finished.rematch!.acceptedIds].sort()).toEqual([...bots].sort());

    expect((await call<void>((ack) => host.emit("room:rematch", true, ack))).ok).toBe(true);
    const again = await updateWhere(host, (snapshot) => snapshot.match !== undefined && snapshot.match.phase !== "finished" && !snapshot.rematch);
    expect(again.match!.players).toHaveLength(4);
    expect(again.match!.players.every((player) => player.chips + player.handBet === 200)).toBe(true);
  }, 90_000);

  it("人机回合不显示倒计时，真人回合有", async () => {
    const host = await connect();
    await create(host, nick("看表"));
    expect((await addBot(host)).ok).toBe(true);
    expect((await start(host)).ok).toBe(true);
    const mine = await updateWhere(host, (snapshot) => myTurn(snapshot.match));
    expect(mine.turnRemainingMs).toBeGreaterThan(0);
    const stop = autoplay(host);
    const theirs = await updateWhere(host, (snapshot) => snapshot.match?.phase === "playing" && snapshot.match.hand.turn !== null && !myTurn(snapshot.match));
    expect(theirs.turnRemainingMs).toBeUndefined();
    stop();
  });

  it("等待中最后一个真人离开，只剩人机的房间直接关掉", async () => {
    const host = await connect();
    const hostName = nick("房主");
    await create(host, hostName);
    expect((await addBot(host)).ok).toBe(true);
    expect((await lobby(host)).some((candidate) => candidate.players[0]?.name === hostName)).toBe(true);
    expect((await call<void>((ack) => host.emit("room:leave", ack))).ok).toBe(true);
    expect((await lobby(host)).some((candidate) => candidate.players.some((player) => player.name === hostName))).toBe(false);
  });

  it("对局中唯一的真人掉线不回来，房间按弃局关掉（人机不算人）", async () => {
    const host = await connect();
    const hostName = nick("走人");
    await create(host, hostName);
    expect((await addBot(host)).ok).toBe(true);
    expect((await start(host)).ok).toBe(true);
    const watcher = await connect();
    host.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect((await lobby(watcher)).some((candidate) => candidate.players.some((player) => player.name === hostName))).toBe(false);
  });

  it("连续超时两次转托管，由人机代打；自己点「取消托管」后交还", async () => {
    const idle = await connect();
    const active = await connect();
    const idleName = nick("发呆");
    const { code } = await create(idle, idleName, { ...SHORT, startingChips: 2000 });
    expect((await join(active, nick("认真"), code)).ok).toBe(true);
    expect((await addBot(idle)).ok).toBe(true);
    expect((await start(idle)).ok).toBe(true);
    const stop = autoplay(active);

    const isAuto = (snapshot: LobbyRoomSnapshot) => snapshot.members.find((member) => member.id === idle.id)?.auto === true;
    await updateWhere(idle, isAuto);

    // 托管后轮到他时没有倒计时，人机替他行动（不再是超时）。
    const hisTurn = await updateWhere(idle, (snapshot) => isAuto(snapshot) && myTurn(snapshot.match));
    expect(hisTurn.turnRemainingMs).toBeUndefined();
    const before = actions(hisTurn, idleName);
    await updateWhere(idle, (snapshot) => actions(snapshot, idleName) > before);

    expect((await call<void>((ack) => idle.emit("room:auto", false, ack))).ok).toBe(true);
    await updateWhere(idle, (snapshot) => !isAuto(snapshot));
    // 交还后轮到他时又有倒计时。
    const back = await updateWhere(idle, (snapshot) => myTurn(snapshot.match) && !isAuto(snapshot));
    expect(back.turnRemainingMs).toBeGreaterThan(0);
    stop();
  }, 30_000);

  it("掉线的人轮到时由人机代打（不算超时），用原昵称回来后交还", async () => {
    const leaver = await connect();
    const stayer = await connect();
    const leaverName = nick("掉线");
    const { code } = await create(leaver, leaverName, { ...SHORT, startingChips: 2000 });
    expect((await join(stayer, nick("留下"), code)).ok).toBe(true);
    expect((await addBot(leaver)).ok).toBe(true);
    const started = await start(leaver);
    if (!started.ok) throw new Error(started.error);
    const stop = autoplay(stayer);
    await updateWhere(stayer, (snapshot) => snapshot.match?.phase === "playing");
    const before = actions(latest.get(stayer), leaverName);
    leaver.disconnect();

    // 他被人机代打了好几次，一直没有转托管（离线代打不算超时）。
    const played = await updateWhere(stayer, (snapshot) => actions(snapshot, leaverName) >= before + 3, 20_000);
    const seat = played.members.find((member) => member.name === leaverName)!;
    expect(seat).toMatchObject({ connected: false });
    expect(seat.auto).toBeUndefined();

    const back = await connect();
    const rejoined = await join(back, leaverName, code);
    if (!rejoined.ok) throw new Error(rejoined.error);
    expect(rejoined.data.members.find((member) => member.id === back.id)).toMatchObject({ name: leaverName, connected: true });
    expect(rejoined.data.match!.players[rejoined.data.match!.mySeat!]!.name).toBe(leaverName);
    // 回来后轮到他时由他自己操作（有倒计时）。
    const hisTurn = await updateWhere(back, (snapshot) => myTurn(snapshot.match), 20_000);
    expect(hisTurn.turnRemainingMs).toBeGreaterThan(0);
    stop();
  }, 40_000);
});
