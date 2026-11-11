# 玩伴 PLAYROOM

和朋友一起玩的网页游戏平台。现有 **12款游戏**，分为“行酒令”和“其他”两类，免注册，输入昵称、分享房间链接即可开始；每个人使用自己的手机或浏览器参与。

## 平台升级开发

新增受邀内测入口（默认 8788 端口），接入账号、动态目录、12 款官方权威房间、静态单人上传、版本审核、模拟 AI/支付、测试点数与反馈。使用 `npm run platform:start` 启动新平台；原有 8787/P2P 服务独立保留。真实外部服务及不可信服务端执行尚未开放。安装与操作见 [平台开发](docs/platform-development.md)，完整任务与剩余依赖见 [实施任务清单](doc/26-实施任务清单.md)。

## 2026-11-10 游戏分类与默契拆弹

大厅通过“行酒令”和“其他”两个按钮切换游戏，原有11款聚会游戏归入“行酒令”。“其他”新增原创合作解谜游戏**默契拆弹**：支持1～6人，单人可直接开始，多人各持部分线索，180秒内协作解决线路、密码和符号排序，共享三次失误机会。完整玩法见[默契拆弹规则](docs/games/defuse.md)。运行 `npm run test:defuse-integration` 可对本地房间服务验证单人通关、多人线索、重连和重开。

项目根目录：`C:\Users\snqu-180\Desktop\GameHub`

## 2026-11-09 十款新游戏

新增国王杯、我从来没有、真心话大冒险、谁最可能、你宁愿选哪个、搭巴士、数字炸弹、逢七过、分类接龙、别数到31。保留原吹牛骰子及其规则更新。

每款均由独立开发 agent 先整理规则文档再实现。来源、人数、计分、网站改编和超时口径见 [新游戏规则目录](docs/games/README.md)，实际验证与发布状态见 [本次验收记录](docs/games/verification.md)。这是一组常见热门游戏精选，不是有统一统计口径的热度排名。

每个房间固定一种游戏，支持房主开局、私人视图、倒计时、晚加入观战、刷新恢复、退出中止和再次开局。对局主持端保存牌堆与答案；投票收齐前不向其他普通玩家公开选择。P2P 模式下房主掌握完整数据。

## 2026-11-09 规则更新

支持上一局输家先喊、五颗互异的顺子整手计零、围骰／全围、叫 1（比 6 大）、斋／飞、劈／反劈。界面仅有一个「斋」模式按钮。劈会等待叫点者选择接受或反劈后再揭骰，结果显示 ×1／×2／×4 及每手有效贡献。完整口径见 [游戏规则](docs/game-rules.md)。

## 本地免费联机（cpolar）

已配置本机运行与 cpolar 免费隧道。桌面项目内双击 `启动本地联机.cmd` 即可开服，`查看联机地址.cmd` 显示最新地址，`停止本地联机.cmd` 结束服务。优先使用输出的 Public HTTPS 地址分享；电脑必须保持开机联网。不同网络的长连接和直连效果需要实际验证。

详细操作、免费域名变化说明及验证范围见 [本地联机说明](docs/local-hosting.md)。账号密钥只保存在被 Git 忽略的本地目录，不包含在源码备份中。

## 联机方式

默认使用房主主持的 P2P 模式：网页和入房协调通过本机 Node.js + cpolar 提供；游戏操作优先走 WebRTC 直连，失败时自动通过同一服务转发。房主浏览器保留完整对局，其他玩家只接收自己的视图；房主刷新可恢复，退出或断线超时会结束本局并移交房主。

房主需要保持页面在前台，本机服务和 cpolar 需要持续运行。直连不保证在所有网络成功。恢复快照异步备份到本机，不阻塞直连操作。详见 [P2P 联机说明](docs/p2p.md)。

## 目录

```text
GameHub/
  apps/web/                         网页平台
    src/platform/catalog.ts         游戏列表与入口元数据
    src/games/liars-dice/view.ts     吹牛骰子房间与对局界面
    src/main.ts                     大厅、邀请、会话
    src/peer-transport.ts           WebRTC 直连、转发兜底及房主恢复
    src/ui.ts                       共享骰子、头像、规则等界面元素
    src/style.css                   桌面与手机样式
    public/                         网页图标
  packages/
    games/liars-dice/rules.ts        独立的游戏规则和结算
    protocol.ts                     前后端消息和公开状态类型
  services/rooms/server.ts           独立 Node.js 房间、信令与转发服务
  packages/host-game.ts              房主和服务端共用的对局引擎
  tests/rules.test.ts                规则测试
  scripts/integration.mjs            真实 WebSocket 对局、重连、60 秒掉线测试
  scripts/capacity.mjs               六人容量、房主离开与房主移交测试
  docs/                             已确认规则与扩展说明
  dist/                             自动生成的网页构建产物
```

新游戏的规则放到 `packages/games/<game-id>/rules.ts`，元数据和简明玩法放到 `apps/web/src/games/<game-id>/meta.ts`，详细规则放到 `docs/games/<game-id>.md`。游戏实现 `packages/games/core.ts` 接口后，在服务端 `packages/games/registry.ts` 和前端平台目录注册。新增十款共享 `apps/web/src/games/party/` 的响应式界面；吹牛骰子保留独立界面。

## 启动

需要 Node.js 22.12+（本项目在 Node.js 24.21.0 验证）。

首次安装：

```powershell
cd C:\Users\snqu-180\Desktop\GameHub
npm ci
npm run build
npm run preview
```

浏览器打开 http://127.0.0.1:8787 。本地房间服务使用独立 Node.js 运行。

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
npm run test:party-integration
npm run test:rules-integration
npm run test:p2p
```

集成测试会创建专属测试房间，实际等待 60 秒掉线宽限期，全部完成约需 70 秒。
测试线上环境时，仅对你管理的部署设置：

```powershell
$env:GAMEHUB_TEST_URL = 'https://你的部署域名'
npm run test:integration
npm run test:capacity
```

测试涵盖：服务端私有骰子、身份校验、非法叫点、非当前玩家操作、房主权限、开骰结算、重玩、刷新重连、后来玩家等待下一局、主动离开、60 秒掉线判负、六人容量、房主移交、空房清理。

## 更新与数据

更新代码后，运行“停止本地联机.cmd”，再运行“启动本地联机.cmd”。启动脚本自动构建并启动 Node.js 与 cpolar。项目已移除 Cloudflare 部署配置及依赖。

- 房间身份及最新恢复快照保存在被 Git 忽略的 `work/rooms/`。不要公开分享该目录。
- 房主浏览器还将快照保存在当前标签页 sessionStorage；普通玩家不接收完整快照。
- 同一身份只允许一个活跃页面；刷新保留身份，关闭标签页后的恢复取决于浏览器。
- 断线保留60秒，主动退出立即中止当前参与的对局；房主离开后移交其他成员。
- 房主设备负责 P2P 对局的计时；切后台可能延后界面结算，恢复后按绝对截止时间检查操作。
- 接口保留 `network: "server"` 模式供服务端规则回归测试使用；网页默认创建 `network: "p2p"` 房间。
- 旧本地运行数据没有自动迁移，新版本需要创建新房间。历史运行数据保留用于恢复，不再读取。

## 第一版边界

当前提供小游戏平台与12款完整游戏，包括11款行酒令游戏及1款支持单人的合作解谜游戏。没有真人账号恢复、跨设备身份同步、语音聊天、陌生人观战大厅或长期历史战绩。
大规模公开推广前，需要按流量增加创建房间限流、滥用防护和监控；本版本已校验房间容量、消息大小、操作频率、昵称、同源请求和服务端操作权限。
# gamehub
