import { loadConfig } from "../services/api/config";
import { createPool, withTransaction } from "../services/api/db";
import { migrate } from "../services/api/migrations";
import { AccessStore } from "../services/api/access-store";

const config = loadConfig();
const pool = createPool(config);
try {
  const command = process.argv[2];
  if (command === "migrate") {
    console.log(JSON.stringify({ applied: await migrate(pool) }));
  } else if (command === "init") {
    await withTransaction(pool, async client => {
      await client.query("INSERT INTO environments(id, mode) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING",
        [config.environmentId, config.mode]);
      const result = await client.query("SELECT mode FROM environments WHERE id=$1", [config.environmentId]);
      if (result.rows[0]?.mode !== config.mode) throw new Error("已有环境模式不同，禁止修改");
    });
    console.log(`已初始化环境 ${config.environmentId}（不会重置世代或测试数据）`);
  } else if (command === "invite") {
    const uses = Number(process.argv[3] ?? "1"), ttl = Number(process.argv[4] ?? "3600");
    const actor = process.argv[5];
    if (!actor) throw new Error("需要操作者标识：npm run access:invite -- 1 3600 operator");
    console.log(JSON.stringify(await new AccessStore(pool, config).issueInvitation(uses, ttl, actor), null, 2));
  } else if (command === "revoke") {
    const id = process.argv[3], actor = process.argv[4];
    if (!id || !/^[0-9a-f-]{36}$/i.test(id) || !actor) throw new Error("需要邀请 UUID 和操作者标识");
    console.log(JSON.stringify({ revoked: await new AccessStore(pool, config).revokeInvitation(id, actor) }));
  } else {
    throw new Error("支持 migrate、init、invite、revoke");
  }
} catch (error) {
  // Driver messages can include connection credentials or row values.
  if (error instanceof Error && !("code" in error)) console.error(error.message);
  else console.error("数据库操作失败，请检查连接、迁移和权限");
  process.exitCode = 1;
} finally {
  await pool.end();
}
