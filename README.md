# 德州扑克

和朋友在线打无限注德州扑克淘汰赛：2–6 人，同样筹码起步，打到最后一人获胜。规则见 [RULES.md](RULES.md)。

## 本地运行

```bash
npm install
npm run dev
```

浏览器打开 http://localhost:5176 。游戏服务在 3003 端口，开发时由 Vite 转发。

## 结构

- `packages/game`：纯规则引擎（牌型判断、下注与最小加注、全下不足加注不重新开放、边池与零头、淘汰与盲注上涨），以及前后端共用的协议类型。
- `apps/server`：Socket.IO 服务，负责房间、比赛设置、行动限时、手与手之间自动发牌、断线重连、继续投票、房主与管理员管理、语音信令；每位玩家只收到自己的底牌。
- `apps/web`：React 前端。

## 环境变量（线上）

- `WEB_ORIGINS`：允许的页面来源。
- `ADMIN_TOKEN`：管理员口令（首页 `?admin` 解散房间）。
- `TURN_HOST`、`TURN_SECRET`：语音中转服务器与密钥。
- 构建时 `BASE_PATH=/poker/` 让页面部署在子路径下。

## 测试

```bash
npm test
npm run typecheck
```
