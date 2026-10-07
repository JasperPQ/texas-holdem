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

## 画面风格：像素版（默认）和原始版本

首页、等待大厅、牌桌默认是像素风，顶栏「切换原版 / 切换像素版」随时切换，只影响自己看到的画面，记在浏览器的 `gm-board-style` 里（和宝石商人、掼蛋、游戏中心共用同一个选择）。

- 原始样式 `styles.css`、`poker.css` 一字未改；像素皮肤 `app-pixel.css`（首页和等待大厅，和宝石商人同一套）和 `poker-pixel.css`（牌桌）用 `?inline` 导入，只在像素版时放进页面。
- 牌在两种画面下标记不同（`pixel.ts` 的 `PixelContext`）：原版是 `public/cards/` 的 SVG 加放大角标；像素版是 `public/cards-pixel/` 的 PNG。
- 像素牌面、牌桌、筹码、庄家按钮由掼蛋仓库的 `art/cards.py` 生成（两个游戏共用一副牌），见那边的 README。

## 服务器上的启动方式

pm2 按仓库根目录的 `ecosystem.config.cjs` 直接启动一个 `node --import tsx` 进程跑服务端（不经过 `npm start`），每个游戏省下约 50 MB 内存（实测，原来被几层包装进程占掉的部分）。端口和密钥存在 pm2 里，不进仓库；`deploy.sh` 照旧 `pm2 restart`。改了 `ecosystem.config.cjs` 之后，要在服务器上带着原来的环境变量 `pm2 delete` 再 `pm2 start ecosystem.config.cjs` 一次。
