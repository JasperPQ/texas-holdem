import { createHmac } from "node:crypto";
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { io as createClient, type Socket } from "socket.io-client";
import type {
  AckResponse,
  ClientToServerEvents,
  IceServerConfig,
  LobbyRoomSnapshot,
  PokerAction,
  PublicRoomSummary,
  ServerToClientEvents,
  Settings,
} from "@poker/game";

type TestSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const clients = new Set<TestSocket>();
let serverUrl = "";
let httpServer: typeof import("../src/index.js").httpServer;
let serverIo: typeof import("../src/index.js").io;
let testHooks: typeof import("../src/index.js").testHooks;
const adminToken = "test-admin-token";
const timeUnitMs = 10; // 行动限时 30「秒」= 300 毫秒
const handPauseMs = 150;
const rematchMs = 400;
const envKeys = ["ROOM_ABANDON_MS", "REMATCH_TIMEOUT_MS", "ADMIN_TOKEN", "HAND_PAUSE_MS", "ACTION_TIME_UNIT_MS", "TURN_HOST", "TURN_SECRET"] as const;
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

function connectClient(): Promise<TestSocket> {
  return new Promise((resolve, reject) => {
    const client: TestSocket = createClient(serverUrl, { transports: ["websocket"], reconnection: false });
    clients.add(client);
    client.once("connect", () => resolve(client));
    client.once("connect_error", reject);
  });
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const emitAck = <T,>(client: TestSocket, event: string, ...args: unknown[]) =>
  new Promise<AckResponse<T>>((resolve) => (client.emit as (...rest: unknown[]) => void)(event, ...args, resolve));
const create = (client: TestSocket, name: string) => emitAck<LobbyRoomSnapshot>(client, "room:create", { name });
const join = (client: TestSocket, name: string, code: string) => emitAck<LobbyRoomSnapshot>(client, "room:join", { name, code });
const act = (client: TestSocket, action: PokerAction) => emitAck<LobbyRoomSnapshot>(client, "game:action", action);
const closedReason = (client: TestSocket) => new Promise<string>((resolve) => client.once("room:closed", ({ reason }) => resolve(reason)));

function unwrap<T>(response: AckResponse<T>): T {
  if (!response.ok) throw new Error(response.error);
  return response.data;
}

function waitFor(client: TestSocket, check: (room: LobbyRoomSnapshot) => boolean): Promise<LobbyRoomSnapshot> {
  return new Promise((resolve) => {
    const handler = (room: LobbyRoomSnapshot) => {
      if (!check(room)) return;
      client.off("room:updated", handler);
      resolve(room);
    };
    client.on("room:updated", handler);
  });
}

/** 建一桌并开局；latest 记录每位玩家最新收到的快照。 */
async function startedTable(prefix: string, count: number, settings?: Partial<Settings>) {
  const host = await connectClient();
  const created = unwrap(await create(host, `${prefix}0`));
  const players = [host];
  for (let index = 1; index < count; index += 1) {
    const client = await connectClient();
    unwrap(await join(client, `${prefix}${index}`, created.code));
    players.push(client);
  }
  if (settings) unwrap(await emitAck(host, "room:settings", { ...created.settings, ...settings }));
  const latest: LobbyRoomSnapshot[] = [];
  players.forEach((client, index) => client.on("room:updated", (room) => { latest[index] = room; }));
  unwrap(await emitAck(host, "room:start"));
  await delay(50);
  return { code: created.code, players, latest };
}

describe("Texas Hold'em room server", () => {
  beforeAll(async () => {
    Object.assign(process.env, {
      ROOM_ABANDON_MS: "300",
      REMATCH_TIMEOUT_MS: String(rematchMs),
      ADMIN_TOKEN: adminToken,
      HAND_PAUSE_MS: String(handPauseMs),
      ACTION_TIME_UNIT_MS: String(timeUnitMs),
      TURN_HOST: "turn.example.com",
      TURN_SECRET: "turn-secret",
    });
    const serverModule = await import("../src/index.js");
    httpServer = serverModule.httpServer;
    serverIo = serverModule.io;
    testHooks = serverModule.testHooks;
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, resolve);
    });
    serverUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const client of clients) client.disconnect();
    await new Promise<void>((resolve) => serverIo.close(() => resolve()));
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  });

  it("seats up to six players, lets only the host change valid settings, and deals private hole cards", async () => {
    const host = await connectClient();
    const created = unwrap(await create(host, "Host"));
    expect(created.settings).toMatchObject({ startingChips: 1000, smallBlind: 10, bigBlind: 20, actionSeconds: 30 });
    const guests: TestSocket[] = [];
    for (let index = 1; index < 6; index += 1) {
      const guest = await connectClient();
      unwrap(await join(guest, `Guest ${index}`, created.code));
      guests.push(guest);
    }
    expect((await join(await connectClient(), "Seventh", created.code)).ok).toBe(false);

    const settings: Settings = { startingChips: 2000, smallBlind: 25, bigBlind: 50, blindIncreaseMinutes: 15, actionSeconds: 0 };
    expect((await emitAck(guests[0]!, "room:settings", settings)).ok).toBe(false);
    expect((await emitAck(host, "room:settings", { ...settings, bigBlind: 500 })).ok).toBe(false);
    expect(unwrap(await emitAck<LobbyRoomSnapshot>(host, "room:settings", settings)).settings).toEqual(settings);

    const guestView = waitFor(guests[2]!, (room) => room.status === "playing");
    const started = unwrap(await emitAck<LobbyRoomSnapshot>(host, "room:start"));
    expect(started.match?.players.reduce((total, player) => total + player.chips, 0)).toBe(12_000 - 75);
    expect(started.turnRemainingMs).toBeUndefined();
    const view = await guestView;
    const me = view.match!.mySeat!;
    view.match!.players.forEach((player, seat) => {
      expect(player.hasCards).toBe(true);
      expect(player.holeCards).toHaveLength(seat === me ? 2 : 0);
    });
    expect((await emitAck(host, "room:settings", settings)).ok).toBe(false);
  });

  it("accepts actions only in turn and auto-folds a player who runs out of time", async () => {
    const { players, latest } = await startedTable("Clock", 3);
    const match = latest[0]!.match!;
    expect(latest[0]!.turnRemainingMs).toBeGreaterThan(0);
    const turn = match.hand.turn!;
    expect((await act(players[(turn + 1) % 3]!, { type: "call" })).ok).toBe(false);
    // 不操作：30 秒（测试中 300 毫秒）后自动弃牌，轮到下一位。
    const folded = await waitFor(players[0]!, (room) => room.match?.hand.actions[turn]?.type === "fold");
    expect(folded.match?.players[turn]?.folded).toBe(true);
    expect(folded.match?.hand.turn).toBe((turn + 1) % 3);
  });

  it("deals the next hand by itself after a short pause", async () => {
    const { players, latest } = await startedTable("Pause", 2);
    const turn = latest[0]!.match!.hand.turn!;
    const nextHand = waitFor(players[0]!, (room) => room.match?.hand.number === 2);
    const result = unwrap(await act(players[turn]!, { type: "fold" }));
    expect(result.match?.phase).toBe("handOver");
    expect(result.match?.hand.result?.uncontested).toBe(true);
    expect((await nextHand).match?.phase).toBe("playing");
  });

  it("returns a disconnected player to their seat with their cards", async () => {
    const { code, players, latest } = await startedTable("Back", 3, { actionSeconds: 0 });
    const before = latest[1]!.match!;
    players[1]!.disconnect();
    await delay(50);
    const rejoined = unwrap(await join(await connectClient(), "Back1", code));
    expect(rejoined.match?.mySeat).toBe(1);
    expect(rejoined.match?.players[1]?.holeCards).toEqual(before.players[1]?.holeCards);
  });

  it("starts a new tournament when everyone agrees and sends decliners away", async () => {
    const again = await startedTable("Again", 2);
    testHooks.finishMatch(again.code);
    const restarted = waitFor(again.players[0]!, (room) => !room.rematch && room.match?.phase === "playing");
    for (const client of again.players) unwrap(await emitAck(client, "room:rematch", true));
    expect((await restarted).match?.players.every((player) => player.place === null)).toBe(true);

    const quit = await startedTable("Quit", 3);
    testHooks.finishMatch(quit.code);
    const declined = closedReason(quit.players[2]!);
    const lobby = waitFor(quit.players[0]!, (room) => room.status === "waiting");
    await emitAck(quit.players[0]!, "room:rematch", true);
    await emitAck(quit.players[2]!, "room:rematch", false);
    expect(await declined).toContain("不继续");
    expect((await lobby).members.map((member) => member.name)).toEqual(["Quit0", "Quit1"]);
  });

  it("lets the host kick and dissolve, and lets an admin dissolve any table", async () => {
    const host = await connectClient();
    const created = unwrap(await create(host, "Boss"));
    const guest = await connectClient();
    const guestId = unwrap(await join(guest, "Kick Me", created.code)).members.find((member) => member.name === "Kick Me")!.id;
    const kicked = closedReason(guest);
    expect((await emitAck(host, "room:kick", guestId)).ok).toBe(true);
    expect(await kicked).toContain("房主");
    expect((await emitAck(host, "room:dissolve")).ok).toBe(true);

    const { players } = await startedTable("Admin", 2);
    const visitor = await connectClient();
    const lobby = unwrap(await emitAck<PublicRoomSummary[]>(visitor, "lobby:get"));
    const target = lobby.find((room) => room.players.some((player) => player.name === "Admin0"))!;
    expect(target.players[0]?.chips).toEqual(expect.any(Number));
    expect((await emitAck(visitor, "admin:dissolve", { roomId: target.id, token: "nope" })).ok).toBe(false);
    const closed = closedReason(players[1]!);
    expect((await emitAck(await connectClient(), "admin:dissolve", { roomId: target.id, token: adminToken })).ok).toBe(true);
    expect(await closed).toContain("管理员");
  });

  it("issues TURN credentials and relays voice signals between room members", async () => {
    const host = await connectClient();
    const created = unwrap(await create(host, "Voice Host"));
    const guest = await connectClient();
    unwrap(await join(guest, "Voice Guest", created.code));
    const joined = unwrap(await emitAck<IceServerConfig[]>(host, "voice:join", { muted: false }));
    const turn = joined.find((server) => server.username)!;
    expect(turn.credential).toBe(createHmac("sha1", "turn-secret").update(turn.username!).digest("base64"));
    await emitAck(guest, "voice:join", { muted: true });
    const received = new Promise((resolve) => guest.once("voice:signal", resolve));
    host.emit("voice:signal", { to: guest.id!, data: { description: { type: "offer", sdp: "v=0" } } });
    expect(await received).toEqual({ from: host.id, data: { description: { type: "offer", sdp: "v=0" } } });
  });
});
