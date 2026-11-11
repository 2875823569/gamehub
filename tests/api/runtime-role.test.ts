import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { fixture } from "./fixtures";
import { createPool } from "../../services/api/db";
import { provisionRuntimeRole,runtimeRoleName } from "../../scripts/platform-runtime-role";

test("local runtime role can perform business CRUD but cannot DDL, mutate migration history or escalate roles",async t=>{
  const f=await fixture(t),config={...f.config,mode:"development" as const};
  const provisioned=await provisionRuntimeRole(config,false),runtime=createPool(provisioned.runtimeConfig);
  t.after(async()=>{
    await runtime.end();
    const cleanup=new Pool({connectionString:config.databaseUrl,connectionTimeoutMillis:5000});
    try{
      const expected=runtimeRoleName(config.databaseSchema);
      assert.equal(provisioned.role,expected);
      await cleanup.query(`DROP OWNED BY "${expected}"`);
      await cleanup.query(`DROP ROLE "${expected}"`);
    }finally{await cleanup.end();}
  });
  const id=randomUUID();
  await runtime.query("INSERT INTO users(id,environment_id,nickname,terms_version) VALUES($1,$2,'运行角色验证','internal-v1')",[id,config.environmentId]);
  assert.equal((await runtime.query("SELECT nickname FROM users WHERE id=$1",[id])).rows[0].nickname,"运行角色验证");
  await runtime.query("UPDATE users SET nickname='更新成功' WHERE id=$1",[id]);
  assert.equal((await runtime.query("SELECT nickname FROM users WHERE id=$1",[id])).rows[0].nickname,"更新成功");
  await runtime.query("DELETE FROM users WHERE id=$1",[id]);
  assert.equal((await runtime.query("SELECT id FROM users WHERE id=$1",[id])).rowCount,0);
  const flags=(await runtime.query("SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
  assert.ok(Object.values(flags).every(value=>value===false));
  for(const sql of ["CREATE TABLE forbidden_table(id integer)","CREATE TEMP TABLE forbidden_temp(id integer)",
    "DROP TABLE users","ALTER TABLE users ADD forbidden integer","TRUNCATE users",
    "DELETE FROM schema_migrations","DELETE FROM audit_events","UPDATE point_transactions SET reason='tampered'",
    "CREATE ROLE forbidden_role","CREATE DATABASE forbidden_database"]){
    await assert.rejects(()=>runtime.query(sql),{code:"42501"},sql);
  }
  assert.ok((await runtime.query("SELECT version FROM schema_migrations")).rowCount);
});
