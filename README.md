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

## 画面：白天版和夜间版

只有像素风一种画面（原始版本已删掉），配色分夜间（深色，默认）和白天（白底）两种。顶栏「切换白天版 / 切换夜间版」随时切换，只影响自己看到的画面，记在浏览器的 `gm-pixel-theme` 里；gulugagame.com 上的大厅和各个游戏同源，共用这一个选择。

- 夜间配色就是 `app-pixel.css`（首页和等待大厅，和宝石商人同一套）和 `poker-pixel.css`（牌桌），叠在改版前的 `styles.css`、`poker.css` 上（这两份只当底子用）本身。白天版不单独写：`apps/web/day-theme.ts`（Vite 插件）在构建时把这些样式里和颜色有关的声明照抄一份，选择器前加 `:root[data-theme="day"]`，按 `apps/web/day-palette.ts` 的调色表换成白天的颜色。改夜间样式时白天版自动跟着变，只有新出现的深色需要在调色表里补一行。
- 机械换色不合适的地方在 `apps/web/src/theme-day.css` 里手写。
- `index.html` 里一小段脚本在样式生效前就给 `<html>` 加上 `data-theme="day"`，打开页面不会先闪一下深色；切换逻辑和按钮在 `src/theme.tsx`。
- 牌面是 `public/cards-pixel/` 的像素 PNG。像素牌面、牌桌、筹码、庄家按钮由掼蛋仓库的 `art/cards.py` 生成（两个游戏共用一副牌），见那边的 README。

## 服务器上的启动方式

pm2 按仓库根目录的 `ecosystem.config.cjs` 直接启动一个 `node --import tsx` 进程跑服务端（不经过 `npm start`），每个游戏省下约 50 MB 内存（实测，原来被几层包装进程占掉的部分）。端口和密钥存在 pm2 里，不进仓库；`deploy.sh` 照旧 `pm2 restart`。改了 `ecosystem.config.cjs` 之后，要在服务器上带着原来的环境变量 `pm2 delete` 再 `pm2 start ecosystem.config.cjs` 一次。
