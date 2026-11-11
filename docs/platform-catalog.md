# 作品、文件任务、审核与单人资源运行

本记录对应 `doc/13-测试与验收计划.md` 的 T03/T04/T08 相关实现。验证环境为 Windows、本机 PostgreSQL、Node.js，日期 2026-11-10。只证明本机受控内测链路，不表示公开上线、任意用户代码构建或强沙箱验收通过。

## 已实现的链路

- 作者创建作品和工程；上传 ZIP 的大小与 SHA-256 必须匹配预授权；服务端只能读取私有对象目录。
- 文件扫描、导出采用 PostgreSQL 队列、租约、epoch 与环境 generation；完成提交前再次核验。环境重置、租约转移后的迟到结果不能标记成功。
- ZIP 的平台解析器在独立 worker thread 中运行，有 30 秒超时和 V8 堆预算。它只处理数据，禁止执行包内构建命令、服务端规则和依赖安装。worker thread **不是** gVisor/虚拟机级隔离。
- 静态包路径、重复名称、大小写冲突、符号链接、CRC、压缩比、展开总量、扩展名、UTF-8 和清单字段检查通过后，形成不可变文件摘要与候选版本。
- 作者预览后送审；审核员领取任务、以自己的管理员会话预览、确认并作出决定。事务内重验管理员会话、角色和作者发布限制。通过审核可发布到 `internal_catalog`，不产生公开目录。
- 发布指针与版本分离，旧游玩会话固定原版本。主动下架阻止新开局；强制限制同时撤销现有单人会话，每次资源请求重新校验。
- 草稿以 `workspaceRevision` 乐观锁保存，恢复快照产生新修订；AI 候选写入不会更新工作基线。
- 云档按账号、作品、`saveSchemaVersion` 隔离，使用 revision 控制并发；删除留下修订墓碑，明确导入不能覆盖现有云档。结构版本变化保留旧档，读取返回 `otherSchemaVersions`，不会自动迁移旧内容。
- 导出由短期、本人、当前测试访问会话绑定的下载授权读取，令牌放请求头；不把源码、ZIP 或令牌放公共静态目录。
- 作品/版本支持归档、软删除和 30 天恢复。发布、审核、游玩、未完成导出/AI 任务及工作基线引用会阻止对应删除；恢复不会自动上架。
- 后台审核结果、发布和限制状态写入事务 outbox，由统一通知 worker 幂等投递。

## 本机样例

```powershell
node --env-file=.env --import tsx scripts/platform-sample.ts
```

输出 `work/platform/samples/single-counter.zip`。源文件为 `examples/single-counter/game.json` 和 `examples/single-counter/dist/index.html`，生成时把配置的主站来源写入样例 SDK 握手白名单。上传前确保 `ALLOWED_ORIGINS` 与访问主站的实际地址一致。

样例通过独立资源域加载，使用 MessageChannel 的 `ready`、`loadProgress`、`saveProgress`，支持点击计数和保存。它标明 `editable: false`，不冒充包含可编辑工程源码。使用两个不同账号分别作为作者与审核员完成“上传 → 预览 → 送审 → 审核预览 → 发布 → 游玩/保存”。

迁移 `0008_play_account_sessions.sql` 为账号游玩/预览绑定具体登录会话，并保守撤销迁移前无法确定归属登录的旧账号运行授权。游客官方房间不要求账号会话。升级后请重新打开旧预览。`0010_artifact_quotas.sql` 增加上传接收租约和存储预留释放记录；升级上传 API 前须完成迁移。

官方目录：

```powershell
npm run catalog:seed
```

12 款官方作品使用可信的 `HostGame` 服务端房间实现。seed 幂等；已有官方检查记录更新为 `runtimeMigrated: true`、`runtime: platform-authoritative-host-game`、`ugcSandboxVerified: false`。这不代表 12 款全部人工玩法验收已完成。

## 页面与接口

`platform-creator-tools.ts` 导出 `renderCreatorTools(container, game, onChange)`，工作台可以显示：

- 草稿 JSON 编辑、当前 revision、历史快照恢复。
- 设置工作基线、撤回审核、批准版本发布、下架、归档、删除及恢复。
- 当前账号文件任务、刷新终态、下载 ZIP、重新导出、继续已完整上传文件的检查，以及把已通过上传用于新的作品版本。

草稿不是完整的浏览器源码编辑器。元数据变更后自动生成复审候选的编辑流程也未提供；不能通过直接修改已发布标题/封面绕过版本审核。

资源接口由 `services/assets/app.ts` 独立进程提供，`/play/:sessionId/:resourceToken/dist/...` 仅接受当前授权。带 `no-store`、`no-referrer`、`nosniff`、CSP `sandbox allow-scripts`，禁网络连接、表单、子框架和插件。账号或管理员会话撤销后，即使测试访问仍有效，原资源授权也失效。管理角色撤销同时使对应审核预览失效。

资源令牌在路径中是短期 bearer capability；资源服务关闭请求日志，主站页面不应把该路径放分析、反馈或第三方日志。它允许读取运行所需的静态文件，不允许读取 `game.json` 或源码目录。

文件任务恢复接口：

- `GET /api/v1/creator/artifact-jobs`、`GET /api/v1/creator/artifact-jobs/:id`
- `GET /api/v1/creator/uploads`、`GET /api/v1/creator/uploads/:id`
- `POST /api/v1/creator/uploads/:id/complete`
- `POST /api/v1/creator/versions/:id/exports`
- `POST /api/v1/creator/artifact-jobs/:id/download-grants`

列表只返回本人、当前环境和 generation 数据，最多最近 100 条；过期或失败导出可新建任务，失败上传需重新上传。

## 预设头像与作者主页

`0011_profile_avatars.sql` 为账号增加 `avatar_key`，默认 `dice`，数据库和 JSON Schema 都只允许八个预设值：`dice`、`fox`、`cat`、`panda`、`robot`、`rocket`、`planet`、`star`。显示映射集中在 `packages/contracts/profile.ts`，前端直接显示平台内置 emoji，不获取第三方头像地址，也不接受自定义图片或 SVG 上传。

`PATCH /api/v1/me/profile` 接收 `nickname`、`avatarKey` 中至少一项。原来的仅昵称请求继续兼容，省略字段保持原值；资料更新仍需账号身份、对应 CSRF 和事务内会话复核。登录、当前会话、`GET /me` 返回可选兼容字段 `avatarKey`。

`GET /api/v1/authors/:id` 要求有效测试访问，游客无需站内账号。响应只含作者 ID、昵称、预设头像和最多 100 个当前批准的内部目录作品；作品仅含 ID、标题、简介、分类、批准版本 ID。草稿、待审、下架、受限、归档、删除版本以及其他环境作者不可见，不返回手机号、会话、账号状态或钱包信息。这里的作者资料可见范围仍是受邀内测范围。

`platform-profile-tools.ts` 提供 `renderProfileTools(container,onChange)` 和 `renderAuthorPage(container,id)`。资料面板支持昵称和头像选择；作者页使用文本 DOM 展示作品并链接游戏详情，页面路由由主界面接入 `#/author/:id`。

针对性用例扩展在 `tests/api/identity.test.ts`：非法头像 key 与数据库约束拒绝、仅头像更新、旧昵称请求兼容、当前会话返回头像，以及游客作者主页的批准/限制/环境过滤与响应字段最小化。2026-11-10 定向执行该文件共 9 项通过，platform/web TypeScript 检查通过；本次没有重跑无关全量测试。

## 私有对象回收

```powershell
node --env-file=.env --import tsx scripts/platform-gc.ts
```

默认为 dry-run。执行删除时必须同时提供 `--apply --environment` 和配置中的完整环境 ID。脚本只处理 `work/platform/<databaseSchema>/<environmentId>/objects/` 内 64 位摘要命名的普通文件，拒绝越界和符号链接。

当前仅清理 24 小时以上无引用孤立对象，**保留全部历史版本文件**，包括已软删除超过 30 天的版本。这样间接的房间、争议、反馈和审计引用不会被遗漏。上传/导出有效期与活动任务同样受保护。对象写入和 GC 使用同一文件锁，复用对象会刷新时间，删除前再查引用。执行尝试提前写审计，成功记录已删除键；发生异常不会自动重试包含文件删除的事务。

正式的历史版本物理回收仍需明确争议、审核、反馈、审计和备份的保留时长，完成完整引用图验收。本机文件锁在进程异常退出后可能遗留 `.writer-lock`；会安全停止后续写入/回收，不会自行破锁。操作人员确认没有活跃进程后才能处理遗留锁。多节点共享对象存储适配器与存储告警尚未完成。

## 内测存储配额与上传并发

文档 08/12/13/24 未给出账号总存储与并发上传的确定数值，因此本机实现采用固定内测默认，定义于 `services/api/artifact-quota.ts`：

- 每账号 2 GiB、每环境 20 GiB 逻辑额度；同一环境跨 generation 保留的对象仍占额度。
- 每账号最多 2 个、每环境最多 20 个未完成上传，包含 pending、uploaded、checking，直到检查终态或过期。
- 每个上传预留 `ZIP 大小 + min(ZIP 大小 × 100, 300 MiB)`，覆盖原 ZIP 和允许的最大展开结果；100 MiB ZIP 因而预留 400 MiB。
- 保留的版本按账号内去重内容摘要计量，包括软删除历史版本。仍被上传预留覆盖的文件不再作为版本重复计量；AI 候选提交也检查新增文件额度。
- 物理对象目录另有 20 GiB / 100,000 个文件硬上限。写入前在与 GC 共用的锁内统计真实文件，包括提交失败的孤立对象，再批量检查、写入。仅有 SQL 额度不能绕过此物理上限。

上传意图在 PostgreSQL 环境级事务 advisory lock 下检查并预留；并发提交只能看见之前已经提交的预留。实际 PUT 在读取请求体前验证归属、大小和状态，并抢占该意图唯一接收租约；并发复用同一意图返回 409，不再同时接收两个大请求体。接收租约为 5 分钟，服务的请求超时仍为 15 秒；正常完成或错误会释放租约，异常进程终止后可等租约到期重试。ZIP 单次 100 MiB 上限保持不变。

从未开始接收内容的过期意图可在下一次预留事务中释放。尝试过写入的上传，即使扫描失败或引用提交失败，也保守保留额度；过期满 24 小时、没有有效接收租约或活动扫描任务，并且受控 GC 已处理孤立对象后，才释放上传预留。历史版本文件额度不会因此清除。超额返回 429 `RATE_LIMITED` 和具体原因；管理员应先 dry-run 检查，再执行指定环境 GC，不能删除已引用文件腾空间。

这些是本机内测保护，不是正式套餐权益、精确存储账单或多节点分布式配额实现。预留故意偏保守；物理硬上限包含孤立文件，防止“对象写入成功、数据库提交失败”持续占满宿主盘。宿主还应保留系统磁盘余量与独立运维告警。本轮测试验证了真实 PostgreSQL 并发预留、实际文件 GC 与接收租约，并校验硬上限边界计算；没有为测试实际写满 20 GiB 磁盘。

## 自动化证据

```powershell
node --import tsx --test tests/api/catalog.test.ts tests/api/artifact.test.ts tests/api/artifact-gc.test.ts tests/api/artifact-quota.test.ts tests/api/assets.test.ts
npx tsc -p tsconfig.platform.json --pretty false
npx tsc -p tsconfig.web.json --pretty false
```

本组 14 项测试使用真实 PostgreSQL 的独立 schema，不用 mock 跳过审核或权限，包括：

1. 静态 ZIP 合法样例与遍历、绝对路径、重复路径、压缩炸弹、CRC 和符号链接拒绝。
2. 服务端规则、多人数清单、未支持权限、伪造平台字段拒绝。
3. 上传、作者预览、审核员领取/预览/批准、发布、游玩、存档冲突、强制下架。
4. 六个并发草稿更新仅一个成功，AI 候选不改基线，恢复产生新 revision。
5. 源码/导出归属、短期授权过期、引用删除阻断、软删除恢复不上架。
6. 12 款官方目录幂等；游客可看目录、不能创作和读账号云档。
7. 事务内角色撤销竞态：先通过请求鉴权，再在事务锁处撤角色，审核领取仍失败。
8. 账号退出后既有预览失效；结构版本升级保留旧档；跨账号、超限、导入覆盖、旧 revision 拒绝。
9. GC dry-run、明确环境确认、历史版本保留、仅孤立对象删除及并发复用对象保护。
10. 独立资源服务器 token、CSP、无 Cookie/凭证继承、路径逃逸、访问撤销。
11. 12 个并发上传意图仅 2 个成功，环境总未完成上传不超过 20；未接收过内容的过期预留可释放。
12. 账号 2 GiB 和环境 20 GiB 的字节预留竞争不会超额；历史记录通过 SQL 构造，避免实际分配巨量磁盘。
13. 保持首个 PUT 写入锁期间，复用同一上传意图的第二个 PUT 在接收请求体前被拒绝。
14. 实际删除过期孤立上传后释放预留，未提交对象的物理容量与文件数量边界拒绝。

不包含：真实浏览器恶意样例的完整 PKG-04/05 攻击矩阵、100 在线/20 房间容量验收、多节点故障恢复、全部官方游戏人工回归、生产对象存储权限和灾备演练。浏览器工作台与样例 SDK 的端到端验证由主任务单独记录。

## 仍需配合或后续工程

- 不可信服务端规则、任意构建和 UGC 多人游戏保持拒绝；需要实际可用的强隔离基础设施及逃逸、断网、资源耗尽验收后再开放。
- 当前自动检查只有静态包检查，`browserVerified: false`；人工审核须真实打开预览，不能把“创建预览会话”视为浏览器运行测试通过。自动化真实浏览器检查流水线仍待实现。
- 完整源码编辑器、AI 对源码工程的真实修改和依赖构建尚未实现。
- 单人存档的历史结构内容保留，但跨结构映射/升级规则需游戏作者定义；当前不做猜测性自动迁移。
- 正式多节点对象存储、私有签名下载、恶意包扫描服务、可配置套餐配额/告警、历史产物保留策略及灾备仍需部署条件和进一步工程。
- 正式上线仍受平台公开资格、内容审核制度、隐私/条款等总门槛限制；本模块只写内部发布指针。
