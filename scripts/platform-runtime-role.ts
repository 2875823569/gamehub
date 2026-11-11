import { createHash,randomBytes,randomUUID } from "node:crypto";
import { readFile,writeFile,readdir,rename,lstat } from "node:fs/promises";
import { resolve,join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { loadConfig,type ApiConfig } from "../services/api/config";
import { verifyLocalDatabaseTarget } from "./platform-backup";

const projectRoot=fileURLToPath(new URL("../",import.meta.url));
const marker="# GameHub generated local runtime credentials";
const immutable=new Set(["audit_events","point_transactions","payment_events","point_freeze_results"]);
const quote=(name:string)=>`"${name.replaceAll('"','""')}"`;
export function runtimeRoleName(schema:string) {
  if(!/^[a-z][a-z0-9_]{0,62}$/.test(schema))throw new Error("无效 Schema");
  return `gamehub_runtime_${createHash("sha256").update(schema).digest("hex").slice(0,16)}`;
}
async function ownedBusinessTables() {
  const directory=join(projectRoot,"infra","migrations"),names=new Set<string>();
  for(const file of (await readdir(directory)).filter(name=>/^\d{4}_[a-z0-9_]+\.sql$/.test(name))){
    const sql=await readFile(join(directory,file),"utf8");
    for(const match of sql.matchAll(/\bCREATE TABLE\s+([a-z][a-z0-9_]*)\s*\(/g))names.add(match[1]);
  }
  return names;
}
/** Returned runtimeConfig contains a secret and must never be logged. */
export async function provisionRuntimeRole(config:ApiConfig,persistEnv=true) {
  await verifyLocalDatabaseTarget(config);
  if(resolve(process.cwd())!==resolve(projectRoot))throw new Error("请在 GameHub 根目录运行");
  const role=runtimeRoleName(config.databaseSchema),comment=`GameHub local runtime gamehub_dev/${config.databaseSchema}`;
  const envFile=join(projectRoot,".env.runtime");
  if(persistEnv){
    try{
      const info=await lstat(envFile);
      if(!info.isFile()||info.isSymbolicLink()||!(await readFile(envFile,"utf8")).startsWith(marker+"\n"))throw new Error("拒绝覆盖非本工具创建的 .env.runtime");
    }catch(error){if(!(error&&typeof error==="object"&&"code" in error&&error.code==="ENOENT"))throw error;}
  }
  const admin=new Pool({connectionString:config.databaseUrl,connectionTimeoutMillis:5000}),password=randomBytes(32).toString("hex");
  const allowed=await ownedBusinessTables();let grantedTables=0;
  const client=await admin.connect();
  try{
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('gamehub-runtime-role'),hashtext($1))",[config.databaseSchema]);
    const schema=(await client.query("SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname=$1",[config.databaseSchema])).rows[0];
    // PostgreSQL's public schema is owned by pg_database_owner on newer releases.
    if(!schema||!["gamehub","pg_database_owner"].includes(schema.owner))throw new Error("Schema 不属于本项目迁移账号");
    const database=(await client.query("SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=current_database()")).rows[0];
    if(database.owner!=="gamehub")throw new Error("数据库不属于本项目");
    const existing=(await client.query("SELECT oid,shobj_description(oid,'pg_authid') AS description FROM pg_roles WHERE rolname=$1",[role])).rows[0];
    if(existing&&existing.description!==comment)throw new Error("同名角色不属于本工具，停止操作");
    if(existing&&(await client.query("SELECT 1 FROM pg_auth_members WHERE member=$1",[existing.oid])).rowCount)throw new Error("运行角色存在额外角色成员关系，停止操作");
    await client.query("SET LOCAL password_encryption='scram-sha-256'");
    if(!existing)await client.query(`CREATE ROLE ${quote(role)}`);
    // Password is generated hex, never user input and never included in output.
    await client.query(`ALTER ROLE ${quote(role)} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 50 PASSWORD '${password}'`);
    await client.query(`COMMENT ON ROLE ${quote(role)} IS '${comment}'`);
    await client.query(`GRANT CONNECT ON DATABASE gamehub_dev TO ${quote(role)}`);
    await client.query("REVOKE TEMPORARY ON DATABASE gamehub_dev FROM PUBLIC");
    await client.query(`REVOKE CREATE,TEMPORARY ON DATABASE gamehub_dev FROM ${quote(role)}`);
    await client.query(`REVOKE CREATE ON SCHEMA ${quote(config.databaseSchema)} FROM PUBLIC`);
    await client.query(`REVOKE ALL ON SCHEMA ${quote(config.databaseSchema)} FROM ${quote(role)}`);
    await client.query(`GRANT USAGE ON SCHEMA ${quote(config.databaseSchema)} TO ${quote(role)}`);
    const tables=(await client.query(`SELECT c.relname,pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p')`,[config.databaseSchema])).rows;
    if(!tables.some(row=>row.relname==="schema_migrations"))throw new Error("请先使用迁移账号应用迁移");
    for(const table of tables){
      if(!allowed.has(table.relname)&&table.relname!=="schema_migrations")continue;
      if(table.owner!=="gamehub")throw new Error("发现非本项目拥有的同名业务表");
      const qualified=`${quote(config.databaseSchema)}.${quote(table.relname)}`;
      await client.query(`REVOKE ALL ON TABLE ${qualified} FROM ${quote(role)}`);
      if(table.relname==="schema_migrations"){await client.query(`GRANT SELECT ON TABLE ${qualified} TO ${quote(role)}`);continue;}
      const privileges=immutable.has(table.relname)?"SELECT,INSERT":"SELECT,INSERT,UPDATE,DELETE";
      await client.query(`GRANT ${privileges} ON TABLE ${qualified} TO ${quote(role)}`);grantedTables++;
    }
    const unsafe=(await client.query(`SELECT has_schema_privilege($1,$2,'CREATE') AS schema_create,
      has_database_privilege($1,'gamehub_dev','CREATE') AS database_create`,[role,config.databaseSchema])).rows[0];
    if(unsafe.schema_create||unsafe.database_create)throw new Error("PUBLIC 或既有授权使运行角色拥有 DDL 能力，停止配置");
    await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK");throw error;}
  finally{client.release();await admin.end();}
  const url=new URL(config.databaseUrl);url.username=role;url.password=password;
  const runtimeConfig={...config,databaseUrl:url.toString()};
  if(persistEnv){
    const temporary=join(projectRoot,`.env.runtime.${randomUUID()}.tmp`);
    await writeFile(temporary,`${marker}\n# Do not commit or share this file.\nGAMEHUB_DATABASE_URL=${url.toString()}\nGAMEHUB_DATABASE_SCHEMA=${config.databaseSchema}\n`,{flag:"wx",mode:0o600});
    await rename(temporary,envFile);
  }
  return {role,grantedTables,envFile:persistEnv?envFile:undefined,runtimeConfig};
}
if(resolve(process.argv[1]??"")===fileURLToPath(import.meta.url)){
  try{
    const {runtimeConfig:secret,...result}=await provisionRuntimeRole(loadConfig());
    void secret;console.log(JSON.stringify({...result,ownerConfigurationUnchanged:true,credentialsPrinted:false},null,2));
  }catch{console.error("运行角色配置失败；请确认本项目本机数据库、迁移权限及已有角色归属。未输出连接密码。");process.exitCode=1;}
}
