# 玩伴 PLAYROOM

和朋友一起玩的网页游戏平台。首款游戏为 **2～6 人吹牛骰子**，免注册，输入昵称、分享房间链接即可开始。

项目根目录：`C:\Users\snqu-180\Desktop\GameHub`

## 当前部署

预览地址：https://dice-night-gamehub.dented-sombrero.workers.dev

2026-11-06 已通过 Wrangler 临时预览账户部署，包含真实 Workers + SQLite Durable Objects 房间服务。
**这是临时预览，需要在 Cloudflare 提示的 60 分钟认领窗口内完成账户认领，才能转为自己的长期部署。认领链接仅在交付聊天中提供，不进入代码或源码压缩包。**

如果预览已过期，源码不受影响；用自己的 Cloudflare 账户登录后执行 `npm run deploy` 即可重新部署，最终域名以命令输出为准。
大陆网络的可用性取决于具体地区和运营商。当前未验证移动、联通、电信的独立直连体验。

## 目录

```text
GameHub/
  apps/web/                         网页平台
    src/platform/catalog.ts         游戏列表与入口元数据
    src/games/liars-dice/view.ts     吹牛骰子房间与对局界面
    src/main.ts                     大厅、邀请、会话、WebSocket 连接
    src/ui.ts                       共享骰子、头像、规则等界面元素
    src/style.css                   桌面与手机样式
    public/                         图标及安全响应头
  packages/
    games/liars-dice/rules.ts        独立的游戏规则和结算
    protocol.ts                     前后端消息和公开状态类型
  services/rooms/worker.ts           Workers API 与 Durable Object 房间
  tests/rules.test.ts                规则测试
  scripts/integration.mjs            真实 WebSocket 对局、重连、60 秒掉线测试
  scripts/capacity.mjs               六人容量、房主离开与房主移交测试
  docs/                             已确认规则与扩展说明
  dist/                             自动生成的网页构建产物
  wrangler.jsonc                    Cloudflare 部署配置
```

以后新游戏的规则放到 `packages/games/<game-id>/`，界面放到 `apps/web/src/games/<game-id>/`，并在平台目录注册入口。新游戏还需添加对应的服务端状态及消息处理；目前房间服务只实现吹牛骰子。

## 启动

需要 Node.js 22.12+（本项目在 Node.js 24.21.0 验证）。

首次安装：

```powershell
cd C:\Users\snqu-180\Desktop\GameHub
npm ci
npm run build
npm run preview
```

浏览器打开 http://127.0.0.1:8787 。这是真实本地房间服务，不是页面演示或假数据。

日常开发时，开两个终端：

```powershell
# 终端 1：服务端
npm run dev:server

# 终端 2：前端热更新，API 与 WebSocket 自动代理到 8787
npm run dev
```

开发地址以 Vite 输出为准。前端构建和生产预览分别使用 `npm run build`、`npm run preview`。
在同一台电脑测试多位玩家时，用不同浏览器标签页分别输入不同昵称；刷新原标签页可以恢复会话。

## 测试

```powershell
npm run check
npm test
# 先启动 npm run preview
npm run test:integration
npm run test:capacity
```

集成测试会创建专属测试房间，实际等待 60 秒掉线宽限期，全部完成约需 70 秒。
测试线上环境时，仅对你管理的部署设置：

```powershell
$env:GAMEHUB_TEST_URL = 'https://你的部署域名'
npm run test:integration
npm run test:capacity
```

测试涵盖：服务端私有骰子、身份校验、非法叫点、非当前玩家操作、房主权限、开骰结算、重玩、刷新重连、后来玩家等待下一局、主动离开、60 秒掉线判负、六人容量、房主移交、空房清理。

## 部署自己的账户

```powershell
npm run cf:login
npm run cf:whoami
npm run deploy
```

在浏览器中完成 Cloudflare 登录与 Wrangler 授权即可，不需要将密码或 API Token 发给任何人。
项目使用 SQLite Durable Objects，适配 Workers 免费方案；请求、计算时长和存储受免费额度约束。没有为项目购买域名或升级付费方案。
可在 Cloudflare 控制台给 Worker 添加自己的域名，但这不保证大陆网络连通性。

若已经认领临时预览，请在自己的账户里确认 Worker 所在账户与域名，再用正式账户登录维护。
请勿把 `.wrangler/`、`.dev.vars`、`.env` 或账户令牌提交到仓库。

## 数据与会话

- 每个房间独立由一个 Durable Object 管理，摇骰、叫点、轮次和结算均由服务端决定。
- 对局中客户端只收到自己的骰子，结算后才公开所有人的骰子。
- 昵称存放于浏览器 localStorage；随机房间身份凭据存放于当前标签页 sessionStorage。关闭标签页后的恢复能力由浏览器会话恢复行为决定，不等于账号体系。
- 对局状态和掉线截止时间持久化到 Durable Object 存储；支持 WebSocket 休眠，心跳使用自动回应。
- 同一个身份最多保留一个活跃连接；旧页面被替换后停止自动重连，避免两个页面互相抢连接。
- 所有人离开或掉线超时后，房间及其身份数据清理。
- 房间码是邀请凭据，知道房间码的人可以加入；没有陌生人匹配、账号密码、排行榜或管理员后台。

## 第一版边界

当前提供小游戏平台基础与一款完整的吹牛骰子。没有真人账号恢复、跨设备身份同步、语音聊天、观战大厅或长期历史战绩。
大规模公开推广前，需要按流量增加创建房间限流、滥用防护和监控；本版本已校验房间容量、消息大小、操作频率、昵称、同源请求和服务端操作权限。
