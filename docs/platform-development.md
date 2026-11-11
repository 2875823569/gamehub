# 内测平台开发与启动

新版入口包含测试邀请、账号、动态目录、官方权威房间、单人上传、创作工作台、审核、测试点数、模拟任务、反馈与后台。真实短信、AI、收款和用户上传的服务端规则仍关闭。功能状态及剩余项以 [任务清单](../doc/26-实施任务清单.md) 为准。

## 本机启动

需要 Node.js 24、Docker、Docker Compose。本项目使用独立 Compose 项目 `gamehub-platform-dev`、数据库 `gamehub_dev`、端口 `127.0.0.1:55432`，不操作其他项目容器。

```powershell
npm ci
npm run setup:local
npm run db:up
npm run db:migrate
npm run db:init
npm run catalog:seed
npm run db:runtime-role
npm run build
npm run platform:start
```

`setup:local` 仅在文件不存在时生成带随机密钥的 `.env`。`db:runtime-role` 创建本地最小权限运行角色并把随机凭据写入忽略的 `.env.runtime`。`platform:start` 启动 API、独立资源服务器、模拟任务 worker、文件任务 worker；存在 `.env.runtime` 时自动加载它。迁移和受控管理命令仍使用 `.env` 中的 owner，服务不会在启动时自动迁移。

本次本机 `.env` 的 `GAMEHUB_DATABASE_POOL_MAX` 为20，已完成对应短时容量样本；仓库默认和 `.env.example` 仍为10。新部署须结合服务进程数、数据库总连接预算及真实负载验证，不直接视为容量保证。

平台页面：`http://127.0.0.1:8788/`。游戏资源站点：`http://127.0.0.2:8790`，只通过授权 iframe 使用。两个地址使用不同主机，避免仅更换端口仍携带平台 Cookie。实际内测须配置 HTTPS 和不同可注册域名；同一站点的两个子域名也被配置校验拒绝。不要把资源站点代理回平台同源。

`Ctrl+C` 关闭本次启动的四个进程。`npm run db:down` 只停止本项目数据库容器和网络，保留数据卷。单独开发可使用 `dev:api`、`start:assets`、`worker:dev`、`artifacts:dev`，这些命令默认读取 owner 配置；需要验证权限时按运维文档显式叠加 `.env.runtime`。

旧 `npm start`、`dev:server`、桌面联机脚本继续运行原 8787/P2P 服务。它们没有新平台的内测准入，不可当作封闭内测入口发布。Vite 开发入口为 `/platform.html`，代理 `/api/v1` 至新 API，原 `/api` 仍指向旧服务。构建保留两个入口，8788 仅提供新平台页面。

## 邀请与初始账号

```powershell
# 最多兑换次数、有效秒数、操作者
npm run access:invite -- 5 86400 local-operator
npm run access:revoke -- <邀请UUID> local-operator

# 加入手机号测试白名单，不发送真实短信
npm run identity:admin -- allow-phone 13800000000 local-operator
```

把发放结果中一次显示的 `invitation` 填到平台入口。测试邀请和房间邀请不是同一凭据。游客可输入昵称游玩官方房间或已发布单人作品。

账号登录：页面输入白名单手机号，获取验证码后显示挑战编号。组织者在本机读取该次随机验证码，再交给本人完成登录：

```powershell
npm run identity:admin -- sms-code <挑战UUID>
```

验证码经加密保存，不通过 HTTP 返回；有冷却、次数及过期限制。首次注册须同意测试协议，登录后工作台等账号能力可用。可通过浏览器同源 `GET /api/v1/me` 或受控数据库查询获得自己的用户 UUID，再初始化后台角色：

```powershell
npm run identity:admin -- grant-role <用户UUID> super_admin local-operator
npm run identity:admin -- revoke-role <用户UUID> super_admin local-operator
```

后台必须再使用独立验证码登录。角色包括 super_admin、reviewer、finance、operations、support，各接口实际检查权限；普通登录、后台登录、支持登录、测试访问和游客身份分别管理。

## 验证一条作品链路

```powershell
npm run sample:zip
```

在创作中心创建作品，上传 `work/platform/samples/single-counter.zip`。文件 worker 检查后创建不可变版本；预览中可保存进度。送审后后台领取、预览、批准，作品进入内测目录。该样例不含可编辑源码，界面不会开放 AI 修改能力。

需要模拟创作时，管理员先发放测试点数；作者填写需求、获取固定报价并明确确认。worker 生成带模拟标记的固定计数器模板，验证任务、结算、候选版本及通知流程。它不会实现自然语言需求，不代表真实 AI 质量通过。

需求草稿自动保存，以 revision 防止覆盖其他页面更新；断网保留本机未同步副本，刷新后让作者选择恢复。历史草稿、版本基线、撤回、发布、下架、导出、恢复入口在工作台下方。只有作者明确选择时才能导入游客存档，已有云档不会被导入操作覆盖。

## 配置与安全边界

- 邀请、账号、运行会话和任务绑定环境与世代；受控重置保留账本证据并撤销旧授权。
- Cookie 为 HttpOnly、SameSite=Strict；内测使用 Secure 和 `__Host-` 前缀。写接口核对 Origin 与对应身份的 CSRF。
- 登录/兑换 IP 桶上限 60 次/分钟，其他业务 IP 桶 600 次/分钟；短信和动作还有各自限额。`trustProxy=false`，不能相信任意转发头；实际网关需按可信代理拓扑配置。
- API Schema 与 OpenAPI 来自实际路由。日志不打印 Cookie、手机号、邀请码或原始 SQL 异常。
- 当前对象适配器是单节点私有目录，有并发/空间配额、摘要校验和受控回收。文件 ZIP 解析在有时限的 worker thread 中，不执行用户构建脚本，也不把它称为强隔离沙箱。
- `GAMEHUB_REAL_PAYMENTS`、`GAMEHUB_REAL_AI`、`GAMEHUB_REAL_SMS` 仅接受关闭；打开会拒绝启动，不会隐式调用付费服务。

## 测试与运维

```powershell
npm run build
npm test
npm run test:api
npm run contracts:generate
npm run contracts:check
npm run platform:browser
npm run platform:doctor
npm run platform:capacity
npm run db:backup
npm run backup:business-drill
npm run artifact:gc
npm run test-access:reset
```

API/浏览器/容量测试使用随机 schema，结束时仅清理自己创建的 schema，保留原业务数据。测试默认访问本项目开发库，可通过 `GAMEHUB_TEST_DATABASE_URL` 指向专用测试库。测试需要建 schema 权限，不使用 `.env.runtime`，也不应指向正式库。

浏览器默认使用本机 Edge；CI 设置 `GAMEHUB_BROWSER=chromium` 并安装 Playwright Chromium。浏览器证据位于 `work/platform/browser`；压测报告位于 `work/platform/capacity.json`。测试模拟付款不会产生真实交易。

GC 默认 dry-run。备份、恢复演练、配额、角色和世代切换详见 [运维操作](./platform-operations.md)、[作品与文件](./platform-catalog.md)、[房间与性能](./platform-rooms.md)。当前主机没有 `runsc`，因此用户构建、多人用户规则及自动执行任意产物的质量流水线尚不能按方案验收。
