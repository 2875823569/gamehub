import { createHash,randomUUID } from "node:crypto";
import { createReadStream,constants } from "node:fs";
import { mkdir,lstat,realpath,readdir,copyFile,readFile,writeFile } from "node:fs/promises";
import { resolve,join,basename,dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig,type ApiConfig } from "../services/api/config";
import { objectDirectory,withObjectLock } from "../services/api/artifact-files";

const projectRoot=fileURLToPath(new URL("../",import.meta.url));
const backupRoot=join(projectRoot,"work","platform-backups");
const hashName=/^[0-9a-f]{64}$/;
interface Manifest {
  format:1;schema:string;environmentId:string;createdAt:string;
  objects:{name:string;sha256:string;bytes:number}[];
}
export function assertLocalBackup(config:ApiConfig) {
  const url=new URL(config.databaseUrl);
  if(config.mode!=="development"||!["localhost","127.0.0.1"].includes(url.hostname)||
    url.port!=="55432"||url.pathname!=="/gamehub_dev"||url.username!=="gamehub")
    throw new Error("备份工具仅接受本项目 development/loopback 数据库");
  if(resolve(process.cwd())!==resolve(projectRoot))throw new Error("请在 GameHub 项目根目录运行");
}
async function ordinaryDirectory(path:string) {
  const info=await lstat(path);
  if(!info.isDirectory()||info.isSymbolicLink()||resolve(await realpath(path))!==resolve(path))
    throw new Error("目录必须是当前项目内的普通目录，不允许符号链接或重定向");
}
async function digestFile(path:string) {
  const info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink())throw new Error("对象必须为普通文件");
  const hash=createHash("sha256");for await(const chunk of createReadStream(path))hash.update(chunk);
  return {sha256:hash.digest("hex"),bytes:info.size};
}
async function backupDirectory() {
  await mkdir(backupRoot,{recursive:true});await ordinaryDirectory(backupRoot);return backupRoot;
}
export async function backupPrivateObjects(config:ApiConfig) {
  assertLocalBackup(config);const started=Date.now();
  await backupDirectory();
  const destination=join(backupRoot,`gamehub-objects-${randomUUID()}`);
  await mkdir(destination);await ordinaryDirectory(destination);
  const content=join(destination,"objects");await mkdir(content);
  const manifest:Manifest={format:1,schema:config.databaseSchema,environmentId:config.environmentId,
    createdAt:new Date().toISOString(),objects:[]};
  await withObjectLock(config,async()=>{
    const source=objectDirectory(config);await ordinaryDirectory(source);
    for(const name of (await readdir(source)).sort()){
      if(name===".writer-lock")continue;
      if(!hashName.test(name))throw new Error("对象目录含未知文件，停止备份");
      const original=await digestFile(join(source,name));
      if(original.sha256!==name)throw new Error("源对象摘要不匹配，停止备份");
      await copyFile(join(source,name),join(content,name),constants.COPYFILE_EXCL);
      const copied=await digestFile(join(content,name));
      if(copied.sha256!==name||copied.bytes!==original.bytes)throw new Error("备份对象验证失败");
      manifest.objects.push({name,...copied});
    }
  });
  const serialized=JSON.stringify(manifest,null,2)+"\n",manifestSha256=createHash("sha256").update(serialized).digest("hex");
  await writeFile(join(destination,"manifest.json"),serialized,{flag:"wx",mode:0o600});
  await writeFile(join(destination,"manifest.sha256"),manifestSha256+"\n",{flag:"wx",mode:0o600});
  return {path:destination,schema:manifest.schema,environmentId:manifest.environmentId,objects:manifest.objects.length,
    bytes:manifest.objects.reduce((total,item)=>total+item.bytes,0),manifestSha256,elapsedMs:Date.now()-started,scope:"current-namespace-private-objects"};
}
export async function restorePrivateObjectsDrill(config:ApiConfig,directory:string) {
  assertLocalBackup(config);const started=Date.now(),source=resolve(directory);
  if(dirname(source)!==resolve(backupRoot)||!/^gamehub-objects-[0-9a-f-]{36}$/.test(basename(source)))throw new Error("仅恢复本工具生成的对象备份");
  await ordinaryDirectory(source);await ordinaryDirectory(join(source,"objects"));
  const manifestPath=join(source,"manifest.json");await digestFile(manifestPath);
  await digestFile(join(source,"manifest.sha256"));
  const serialized=await readFile(manifestPath,"utf8");
  if(createHash("sha256").update(serialized).digest("hex")!==(await readFile(join(source,"manifest.sha256"),"utf8")).trim())
    throw new Error("清单摘要不匹配");
  const manifest=JSON.parse(serialized) as Manifest;
  if(manifest.format!==1||manifest.schema!==config.databaseSchema||manifest.environmentId!==config.environmentId||!Array.isArray(manifest.objects))
    throw new Error("对象备份命名空间不匹配");
  const names=new Set<string>();
  for(const entry of manifest.objects){
    if(!entry||!hashName.test(entry.name)||entry.sha256!==entry.name||!Number.isSafeInteger(entry.bytes)||entry.bytes<0||names.has(entry.name))
      throw new Error("对象清单含无效或重复记录");
    names.add(entry.name);
  }
  const actual=await readdir(join(source,"objects"));
  if(actual.length!==names.size||actual.some(name=>!names.has(name)))throw new Error("备份对象与清单不一致");
  await backupDirectory();
  const destination=join(backupRoot,`gamehub-object-drill-${randomUUID()}`);await mkdir(destination);await ordinaryDirectory(destination);
  for(const entry of manifest.objects){
    const original=await digestFile(join(source,"objects",entry.name));
    if(original.sha256!==entry.sha256||original.bytes!==entry.bytes)throw new Error("备份对象损坏");
    await copyFile(join(source,"objects",entry.name),join(destination,entry.name),constants.COPYFILE_EXCL);
    const copied=await digestFile(join(destination,entry.name));
    if(copied.sha256!==entry.sha256||copied.bytes!==entry.bytes)throw new Error("恢复对象校验失败");
  }
  return {restored:true,objects:manifest.objects.length,path:destination,retainedForInspection:true,
    sourceNamespaceUntouched:true,elapsedMs:Date.now()-started};
}
if(resolve(process.argv[1]??"")===fileURLToPath(import.meta.url)){
  try{
    const config=loadConfig(),command=process.argv[2]??"backup";
    if(command==="backup")console.log(JSON.stringify(await backupPrivateObjects(config),null,2));
    else if(command==="drill"&&process.argv[3])console.log(JSON.stringify(await restorePrivateObjectsDrill(config,process.argv[3]),null,2));
    else throw new Error("支持 backup 或 drill <本工具生成的备份目录>");
  }catch(error){console.error(error instanceof Error?error.message:"对象备份失败");process.exitCode=1;}
}
