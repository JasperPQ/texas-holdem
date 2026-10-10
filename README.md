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

## 人机和托管

- 等待大厅里房主点空座位上的「加人机」，人机叫咕噜一号～五号（「人机」标签、普通难度），一个人加满人机也能开局。连续 2 次超时转托管（人机代打，点「取消托管」或自己操作一次就收回）；掉线的人轮到时等 3 秒由人机代打，原昵称回来交还。这条覆盖 RULES.md 原来「超时自动过牌/弃牌、掉线一直等」的写法，见 RULES.md「超时、托管与掉线」。
- 策略在 `packages/game/src/bot.ts`：`botAdvice(视角, 座位) → { action, reason, equity }`、`botCommand`。输入必须是 `viewForPlayer` 之后的视角（带牌堆直接抛错）。蒙特卡洛估摊牌胜率（单挑 1600 次、多人 1000–1300 次，用位运算快速估值），对比底池赔率决定弃/跟/加；对手这一轮加过注的按起手牌强度（陈氏公式百分位）收紧他的范围，越爱加注的对手收得越松；跟注押上大半筹码时多要一点把握；没人下注时偶尔小注诈唬（提示模式不诈唬，对手几乎不弃牌时也不诈唬）。≤10 个大盲翻牌前只全下或弃牌。`stats`（每人行动/加注/弃牌次数）是牌桌上人人看得到的公开信息。
- 每步约 0.6 ms。强度：`npx tsx ~/projects/qa-reports/tools/bots/sim-texas-holdem.ts 300`（在本仓库目录跑；公共代码在 `packages/game/test/bot-harness.ts`）。
- 服务器：`BOT_DELAY_SCALE`（人机停顿倍数，测试 0）、`OFFLINE_GRACE_MS`（默认 3000）。真人都出局后人机打快一些。开发时 `ACTION_TIME_UNIT_MS=50 BOT_DELAY_SCALE=0.3 HAND_PAUSE_MS=1500 npm run dev` 测得快，网页截图脚本 `~/projects/qa-reports/tools/bots/bots-ui-poker.mjs`。

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
