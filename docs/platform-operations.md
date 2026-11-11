# 本地平台运维与验证

本文覆盖开发环境的数据库备份、隔离恢复演练、测试环境世代切换及模拟任务执行。没有开通生产资源，也不宣称已经满足生产 RPO/RTO。

## 迁移账号与运行账号分离

```powershell
node --env-file=.env --import tsx scripts/platform-runtime-role.ts
node --env-file=.env --env-file=.env.runtime --import tsx services/api/server.ts
```

配置脚本只允许本项目 Compose 容器对应的 `development/localhost:55432/gamehub_dev`，校验数据库及 schema 归属，按 schema 派生独立 `gamehub_runtime_<摘要>` 角色。随机密码只写 Git 已忽略的 `.env.runtime`，不输出到终端，不修改当前 `.env`。该文件仅包含运行连接地址与 schema，其他配置继续从 `.env` 加载。不要把该文件提交、共享或粘贴到报告中；Windows 部署还应按运行服务账号限制文件 ACL。

运行角色拥有 CONNECT、schema USAGE 以及当前迁移中业务表所需的 SELECT/INSERT/UPDATE/DELETE。审计、点数流水、支付事件和冻结终态表只授予 SELECT/INSERT；迁移历史只读。角色不是表 owner，不具有 SUPERUSER、CREATEDB、CREATEROLE、REPLICATION 或 BYPASSRLS，不加入任何其他角色，也不授予 TRUNCATE、schema CREATE 或临时表权限。为避免 PUBLIC 权限绕过，本项目 schema 的 PUBLIC CREATE 和本项目数据库的 PUBLIC TEMPORARY 会撤销；迁移 owner 的固有权限保留。

迁移、初始化和运维继续使用原 `.env` owner 连接，运行 API、资源服务及 worker 时加载 `.env.runtime` 覆盖连接地址。运行角色不负责自动迁移；新增业务表迁移后，用 owner 再执行配置脚本补授现有业务表权限，同时会轮换运行密码，需要重启使用旧连接的服务。脚本不向其他项目角色或其他数据库授予权限，也不会操作已有不带本工具归属标记的同名角色。

`tests/api/runtime-role.test.ts` 在随机 schema 验证真实业务读写成功，并验证 CREATE/DROP/ALTER/TRUNCATE、临时表、篡改迁移历史、篡改审计/流水、创建角色及数据库全部被 PostgreSQL 拒绝。当前主 `.env` 和已运行进程不会自动切换，因此“已具备运行角色配置能力”不等于所有当前进程已使用最小权限账号。内测环境仍应由相应数据库 owner 以同样权限模型配置，不能直接复用本地凭据。

2026-11-10 已实际为本地 `public` schema 配置 `gamehub_runtime_efa1f375d76194fa`，授予 57 张业务表的上述权限，并生成 `.env.runtime`。使用该文件的实际连接已完成 API 装配和环境校验，确认角色没有 SUPERUSER、CREATEDB 和 CREATEROLE。随机 schema 权限测试 1/1 通过；测试角色及 schema 已清理。`.env.runtime` 已由现有 `.env*` 忽略规则覆盖。

## 模拟 AI 执行器

完成迁移和环境初始化后，在新终端运行：

```powershell
node --env-file=.env --import tsx scripts/platform-worker.ts
```

仅处理一轮：

```powershell
node --env-file=.env --import tsx scripts/platform-worker.ts --once
```

执行器使用数据库租约，环境最多两项同时运行、单账号最多一项运行；账号最多三项排队。租约过期后允许其他执行器重新领取，旧执行标识不能结算。排队 30 分钟、执行 15 分钟为当前初始上限；重试累计最多三次领取。

当前提供方只有 `mock`。创建/修改会产出明确标识的固定点击计数器，需求文本只作为转义的记录展示，不能把它当作实现任意需求的真实 AI。产物只做静态包检查，`browserVerified=false`；发布仍需作者预览和后台审核。新建价格为 10 测试点数、修改为 6 测试点数，真实兑换率未制定。

任务成功后，版本写入与点数结算在同一个数据库事务。失败、取消、超时释放原批次冻结；免费修复最多两轮，无法完成可由有权限人员退还原消费点数。退点保留原批次来源，不把赠送变成付费点数。

任务与发布 outbox 由执行器幂等投递为站内通知。若执行器未运行，队列和事件仍在数据库中，不能声称通知已送达。

## 测试支付和预算

商品 `test-100` 只用于模拟，100 测试分对应 100 测试点数，不收真钱。用户创建订单后，只有独立后台会话的财务或超级管理员可确认模拟支付；服务端读取订单锁定金额并签署内部模拟通知。

重复事件不会重复入账，错误金额或签名被拒绝。当前模拟退款只支持完全未使用订单的全额退款；部分消费后的算法和真实渠道退款需要另行核定，接口会明确拒绝超出当前能力的操作。

真实提供方没有开放。成本预算服务以供应商币种的百万分之一记整数日/月额度，并与用户点数独立。超时未确认费用保留 `uncertain` 预留，不自动退回预算。超过预留的实际费用转人工核实，不静默增加用户费用。

## 数据库备份

```powershell
node --env-file=.env --import tsx scripts/platform-backup.ts backup
```

脚本只接受 `development`、本机 `127.0.0.1/localhost:55432`、数据库 `gamehub_dev` 和用户 `gamehub`。通过 Docker Compose 项目和服务标签识别 `gamehub-platform-dev` 的 PostgreSQL 容器，不操作其他项目。

备份保存到被 Git 忽略的 `work/platform-backups/gamehub-dev-<uuid>.dump`，同时保存 SHA-256 和范围说明。文件含账号、私有业务及账本，应按敏感数据保护；不要分享备份文件。

这份备份只含当前 `GAMEHUB_DATABASE_SCHEMA` 的数据库内容，不包含私有游戏对象文件和 `.env`。对象备份与带业务数据的联合恢复演练见下文；部署镜像、配置和密钥仍应另行安全保存，不复制密钥到公开报告。

## 隔离恢复演练

```powershell
node --env-file=.env --import tsx scripts/platform-backup.ts drill "上一步返回的完整备份路径"
```

仅接受备份目录内符合命名和摘要的文件，恢复到新建 `gamehub_restore_<uuid>` 数据库，验证迁移记录、核心表计数及账户、批次、流水一致性。恢复的 schema 必须与配置匹配。结束或失败时删除这个经过前缀校验的临时恢复库，不覆盖开发库。

演练报告记录用时和数据库验证结果；一次本地数据库演练不证明生产恢复目标，也不证明私有对象文件可用。

## 私有对象备份与恢复

```powershell
node --env-file=.env --import tsx scripts/platform-object-backup.ts backup
node --env-file=.env --import tsx scripts/platform-object-backup.ts drill "上一步返回的完整目录"
```

同样只允许本机 development 数据库配置，且必须在项目根目录运行。备份当前 schema/environment 的 `work/platform/<schema>/<environment>/objects`，在 `work/platform-backups/gamehub-objects-<uuid>` 新建目录。脚本获取对象写入锁后复制普通 SHA-256 命名对象，逐文件核对源摘要与复制摘要，生成包含 namespace、大小和摘要的 manifest 及 manifest 自身摘要。未知文件、符号链接、目录重定向或摘要错误会终止操作。

恢复只写新建随机 `gamehub-object-drill-<uuid>` 目录，不写回原对象目录；逐文件校验后保留副本供检查。不匹配的 namespace、清单多余文件、路径跳转和被篡改内容均拒绝。失败可能留下部分新目录，但不会修改源文件。

数据库备份与对象备份是两个独立动作。正式采集配套快照时应停止写入与对象回收，依次备份数据库和对象并执行引用检查；单独执行两个命令不宣称实现跨存储原子快照。当前本地对象备份与恢复能力已经实现，不依赖外部对象存储账号。

## 带业务数据和对象引用的联合演练

```powershell
node --env-file=.env --import tsx scripts/platform-backup-business-drill.ts
```

脚本仅新建随机 `backup_drill_<uuid>` schema，应用迁移并插入专用演练账号、私有草稿、版本、成功任务、模拟已付款订单、点数批次和流水。它不会在已有业务 schema 插入、删除或清空记录。随后导出该 schema、备份它独享的私有对象 namespace，并恢复到随机临时数据库和目录。恢复后逐表比较 14 张业务表全部记录的 SHA-256，核对账户/批次/流水，再检查数据库版本的每个文件引用是否能在恢复目录找到且摘要正确。

无论成功或失败，脚本最终清理自己新建且名称严格校验的 schema 和临时恢复数据库；对象演练源、备份、恢复副本及 JSON 报告保留在 `work/` 下。未执行产品账号销毁或数据清理政策。

## 测试世代切换

先查看影响：

```powershell
node --env-file=.env --import tsx scripts/platform-reset.ts preview
```

预览返回环境 ID、当前世代、活动任务、冻结点数、访问/账号/游玩会话及未决成本数量，并给出精确确认文本。执行时提供刚看到的世代、完整确认文本和操作者：

```powershell
node --env-file=.env --import tsx scripts/platform-reset.ts execute 1 "RESET gamehub-local GENERATION 1" local-operator
```

上例只有在当前确为该环境和世代时才有效，不能照抄到其他环境。重置事务锁定环境，停止准入、取消未完成 AI 任务并释放冻结，撤销邀请、账号和游玩会话，关闭当前环境房间，拒绝旧任务结果，最后递增世代。失败整体回滚，不留下半重置状态。

它是**世代切换，不是物理清库**。用户、作品、版本、账本、审计和供应商未决费用继续保留；原测试点数不会被迁移为正式权益。重置后保持暂停。

核对结果后恢复准入：

```powershell
node --env-file=.env --import tsx scripts/platform-reset.ts resume 2 "RESUME gamehub-local GENERATION 2" local-operator
```

恢复不复活旧邀请、旧账号会话或旧游戏连接；必须发放新邀请。物理资源回收是独立生命周期流程，不能把删除数据库或对象目录当作安全的重置操作。

## 验证状态

账本/任务/支付有真实 PostgreSQL 并发和故障测试，测试文件为 `tests/api/wallet.test.ts`。世代切换验证位于 `tests/api/operations.test.ts`。真实模型质量、真实支付回调、生产备份、跨节点故障和 RPO/RTO 尚需相应环境与外部服务完成验证。

2026-11-10 18:29（上海时间）已完成一次本地数据库备份和隔离恢复演练：备份大小 151,048 字节，SHA-256 为 `af3aded5a12858b70bfab360fadfb5e6d2a185441b549515002081f62827e00a`，恢复后包含六个迁移记录，临时恢复库已清理。此次恢复耗时约 1.35 秒；原开发库的用户、作品、账本流水和订单均为空，因此该结果仅证明空业务数据库的结构与恢复管道可用，不能证明带业务数据、对象文件或生产环境的完整恢复。

2026-11-10 18:40（上海时间）进一步完成带业务数据和私有对象的联合演练。报告为 `work/platform-backups/gamehub-business-drill-b3de9748-9e15-4420-9ab0-396c66d3ec17.json`：恢复 9 个迁移、1 个账号、1 个作品、1 个已付款测试订单和 3 条点数流水；14 张业务表摘要完全一致，3 个版本文件引用对应 2 个去重对象（1,719 字节），逐项摘要通过。数据库备份 198,637 字节，恢复约 1.37 秒，整个演练约 3.88 秒；对象备份约 15 毫秒、对象恢复约 10 毫秒。随机源 schema 和临时恢复数据库已清理，原有业务数据未改动。该本地小数据量结果仍不等于生产规模 RPO/RTO。
