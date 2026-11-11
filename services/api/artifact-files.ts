import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rmdir, utimes,readdir,lstat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { runArchiveCodec } from "./artifact-codec";
import type { ApiConfig } from "./config";
import { ApiError } from "./errors";
import type { GameManifest, StoredGameFile } from "../../packages/contracts/catalog";
import { assertPhysicalCapacity } from "./artifact-quota";

export const MAX_ARCHIVE = 100 * 1024 * 1024;
const MAX_FILE = 50 * 1024 * 1024, MAX_TOTAL = 300 * 1024 * 1024;
const mimes: Record<string, string> = {
  html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8",
  json: "application/json", txt: "text/plain; charset=utf-8", ts: "text/plain; charset=utf-8", tsx: "text/plain; charset=utf-8", svg: "image/svg+xml",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", woff2: "font/woff2", mp3: "audio/mpeg", ogg: "audio/ogg",
};
export const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
function unsupported(message: string): never { throw new ApiError(422, "PACKAGE_UNSUPPORTED", message); }
export function safeGamePath(path: string): string {
  if (!path || path.length > 240 || path.includes("\\") || /[\x00-\x1f:?#%]/.test(path) ||
      path.startsWith("/") || path.split("/").some(part => !part || part === "." || part === ".." ||
        /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part))) unsupported("游戏文件路径不受支持");
  if (path.split("/").some(part => part.toLowerCase() === "node_modules" || part.startsWith(".env") || part.startsWith("."))) {
    unsupported("游戏包不能包含隐藏配置或依赖缓存");
  }
  return path;
}
function mimeFor(path: string, bytes: Buffer): string {
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  const mime = mimes[extension];
  if (!mime) unsupported(`不支持的文件类型：${path}`);
  if (bytes.subarray(0, 2).toString() === "MZ" || bytes.subarray(0, 4).equals(Buffer.from([0x7f, 69, 76, 70]))) unsupported("禁止系统可执行文件");
  if (["html", "css", "js", "json", "txt", "ts", "tsx", "svg"].includes(extension)) {
    try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { unsupported(`文本必须是 UTF-8：${path}`); }
    if (bytes.includes(0)) unsupported(`文本包含无效字节：${path}`);
  }
  if (extension === "png" && !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) unsupported("PNG 内容与文件类型不符");
  if (["jpg","jpeg"].includes(extension) && !(bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)) unsupported("JPEG 内容与文件类型不符");
  if (extension === "gif" && !/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) unsupported("GIF 内容与文件类型不符");
  if (extension === "webp" && !(bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP")) unsupported("WebP 内容与文件类型不符");
  return mime;
}
export function validateManifest(value: unknown, paths: Set<string>): GameManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) unsupported("缺少有效 game.json");
  const m = value as Record<string, unknown>;
  const allowed = new Set(["schemaVersion","entry","title","description","instructions","cover","mode","minPlayers","maxPlayers",
    "devices","input","sdkVersion","permissions","editable","assetLicenses","saveSchemaVersion","templateId","sourceEntry","serverEntry"]);
  if (Object.keys(m).some(key => !allowed.has(key))) unsupported("清单包含不受支持或平台管理的字段");
  for (const key of ["entry","title","description","instructions","cover"]) {
    if (typeof m[key] !== "string" || (m[key] as string).length > (key === "title" ? 100 : 4000)) unsupported(`清单字段无效：${key}`);
  }
  if (!(m.title as string).trim() || m.schemaVersion !== 1 || m.sdkVersion !== 1) unsupported("不支持的清单或 SDK 版本");
  if (m.mode !== "single" || m.serverEntry !== undefined || [...paths].some(path => path.startsWith("server/"))) {
    unsupported("多人用户规则尚未通过强隔离验证，当前只接收静态单人包");
  }
  if (m.minPlayers !== 1 || m.maxPlayers !== 1) unsupported("单人游戏人数必须为 1");
  if (!Array.isArray(m.devices) || !m.devices.length || m.devices.some(v => !["desktop","mobile"].includes(v))) unsupported("设备声明无效");
  if (!Array.isArray(m.input) || !m.input.length || m.input.some(v => !["mouse","keyboard","touch"].includes(v))) unsupported("输入方式无效");
  if (!Array.isArray(m.permissions) || m.permissions.some(v => !["save","fullscreen"].includes(v))) unsupported("申请了未开放能力");
  if (typeof m.editable !== "boolean" || !Array.isArray(m.assetLicenses) || !m.assetLicenses.length ||
      m.assetLicenses.some(v => typeof v !== "string" || !v || v.length > 1000)) unsupported("请提供编辑能力及素材授权声明");
  if (m.saveSchemaVersion !== undefined && (!Number.isInteger(m.saveSchemaVersion) || Number(m.saveSchemaVersion) < 1 || Number(m.saveSchemaVersion)>2147483647)) unsupported("存档版本无效");
  if (m.permissions.includes("save") && m.saveSchemaVersion === undefined) unsupported("保存进度需要声明存档结构版本");
  const entry = safeGamePath(m.entry as string);
  if (!entry.startsWith("dist/") || !entry.endsWith(".html") || !paths.has(entry)) unsupported("入口必须是存在的 dist/ HTML 文件");
  if (m.cover && !paths.has(safeGamePath(m.cover as string))) unsupported("封面文件不存在");
  if (m.editable && (typeof m.sourceEntry !== "string" || !paths.has(safeGamePath(m.sourceEntry)))) unsupported("可编辑工程必须含有效源码入口");
  if (m.templateId !== undefined && (typeof m.templateId !== "string" || m.templateId.length > 100)) unsupported("模板编号无效");
  return m as unknown as GameManifest;
}

// Strict ZIP subset: central/local names must agree; no encryption, ZIP64, links, nested archives or arbitrary build hooks.
export function decodeStaticZip(bytes: Buffer): Record<string, Buffer> {
  if (!bytes.length || bytes.length > MAX_ARCHIVE) unsupported("压缩包大小超过限制");
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50 && at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) { end = at; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) unsupported("不是受支持的单卷 ZIP");
  const count = bytes.readUInt16LE(end + 10), centralSize = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  if (!count || count > 5000 || count !== bytes.readUInt16LE(end + 8) || start + centralSize !== end) unsupported("ZIP 文件清单无效或超限");
  const output: Record<string, Buffer> = Object.create(null), names = new Set<string>(), spans: [number,number][] = [];
  let at = start, total = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) unsupported("ZIP 目录损坏");
    const flags = bytes.readUInt16LE(at + 8), method = bytes.readUInt16LE(at + 10), crc = bytes.readUInt32LE(at + 16);
    const compressed = bytes.readUInt32LE(at + 20), size = bytes.readUInt32LE(at + 24), nameLength = bytes.readUInt16LE(at + 28);
    const extra = bytes.readUInt16LE(at + 30), comment = bytes.readUInt16LE(at + 32), offset = bytes.readUInt32LE(at + 42);
    const mode = bytes.readUInt32LE(at + 38) >>> 16;
    if (flags & 1 || ![0,8].includes(method) || compressed === 0xffffffff || size > MAX_FILE ||
        ![0,0x8000,0x4000].includes(mode & 0xf000) || bytes.readUInt16LE(at + 34) !== 0) unsupported("ZIP 含不允许的压缩方式、链接或超限文件");
    if (at + 46 + nameLength + extra + comment > end) unsupported("ZIP 目录越界");
    let rawName: string;
    try { rawName = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(at + 46, at + 46 + nameLength)); } catch { unsupported("ZIP 文件名必须是 UTF-8"); }
    at += 46 + nameLength + extra + comment;
    if (rawName!.endsWith("/")) { safeGamePath(rawName!.slice(0, -1)); continue; }
    const name = safeGamePath(rawName!);
    const normalized = name.normalize("NFKC").toLowerCase();
    if (names.has(normalized)) unsupported("ZIP 含重复或大小写冲突文件");
    names.add(normalized);
    if (offset + 30 > start || bytes.readUInt32LE(offset) !== 0x04034b50) unsupported("ZIP 本地文件头无效");
    const localNameLength = bytes.readUInt16LE(offset + 26), localExtra = bytes.readUInt16LE(offset + 28);
    const dataStart = offset + 30 + localNameLength + localExtra, dataEnd = dataStart + compressed;
    if (dataEnd > start || bytes.readUInt16LE(offset + 8) !== method ||
        bytes.subarray(offset + 30, offset + 30 + localNameLength).toString("utf8") !== name ||
        bytes.readUInt16LE(offset + 6) !== flags || spans.some(([a,b]) => offset < b && dataEnd > a)) unsupported("ZIP 文件边界或名称不一致");
    spans.push([offset, dataEnd]);
    if (size > Math.max(compressed, 1) * 100) unsupported("ZIP 解压倍率超过限制");
    let data: Buffer;
    try {
      data = method === 0 ? Buffer.from(bytes.subarray(dataStart, dataEnd)) :
        inflateRawSync(bytes.subarray(dataStart, dataEnd), { maxOutputLength: MAX_FILE });
    } catch { unsupported("ZIP 解压失败或超过限制"); }
    if (data!.length !== size || crc32(data!) !== crc) unsupported("ZIP 文件校验失败");
    total += data!.length;
    if (total > MAX_TOTAL || total > bytes.length * 100) unsupported("ZIP 解压总量超过限制");
    mimeFor(name, data!);
    output[name] = data!;
  }
  if (at !== end) unsupported("ZIP 目录长度不符");
  return output;
}
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function objectDirectory(config: Pick<ApiConfig,"databaseSchema"|"environmentId">): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(config.databaseSchema) || !/^[a-z][a-z0-9_-]{2,47}$/.test(config.environmentId)) throw new Error("Invalid storage namespace");
  return resolve("work/platform", config.databaseSchema, config.environmentId, "objects");
}
export async function putObject(config: ApiConfig, bytes: Buffer): Promise<string> {
  return (await putObjects(config,[bytes]))[0];
}
async function putObjects(config:ApiConfig,items:Buffer[]):Promise<string[]>{
  const digests=items.map(sha256),unique=new Map(items.map((bytes,index)=>[digests[index],bytes]));
  return withObjectLock(config,async()=>{
    const directory=objectDirectory(config),existing=new Set<string>();
    let usedBytes=0,usedObjects=0;
    // Count actual bytes, including files whose DB commit failed. The same writer lock covers GC.
    for(const name of await readdir(directory)){
      if(name===".writer-lock")continue;
      const info=await lstat(join(directory,name));
      if(!info.isFile() || info.isSymbolicLink())throw new ApiError(503,"INTERNAL_ERROR","对象目录含异常条目，请联系管理员检查");
      usedBytes+=info.size;usedObjects++;existing.add(name);
    }
    const pending=[...unique.entries()].filter(([digest])=>!existing.has(digest));
    assertPhysicalCapacity(usedBytes,usedObjects,pending.reduce((n,[,bytes])=>n+bytes.length,0),pending.length);
    for(const [digest,bytes] of unique){
      if(!existing.has(digest))await writeFile(join(directory,digest),bytes,{flag:"wx",mode:0o600});
      // Refresh reused objects before a new database reference is committed.
      await utimes(join(directory,digest),new Date(),new Date());
    }
    return digests;
  });
}
export async function withObjectLock<T>(config:ApiConfig,operation:()=>Promise<T>):Promise<T>{
  const directory=objectDirectory(config),lock=join(directory,".writer-lock");
  await mkdir(directory,{recursive:true});
  for(let attempt=0;;attempt++){
    try{await mkdir(lock);break;}catch(error){
      if(!(typeof error==="object" && error!==null && "code" in error && error.code==="EEXIST") || attempt>=500)throw error;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
  }
  try{return await operation();}finally{await rmdir(lock);}
}
export async function getObject(config: ApiConfig, digest: string): Promise<Buffer> {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid object digest");
  const bytes = await readFile(join(objectDirectory(config), digest));
  if (sha256(bytes) !== digest) throw new Error("Object digest mismatch");
  return bytes;
}
export interface PreparedCandidate { manifest: GameManifest; files: Record<string, StoredGameFile>; contentDigest: string }
export async function prepareStaticFiles(config: ApiConfig, files: Record<string,Buffer>, suppliedManifest?: GameManifest): Promise<PreparedCandidate> {
  if (!files["game.json"]) unsupported("游戏包缺少 game.json");
  let parsed: unknown;
  try { parsed = JSON.parse(files["game.json"].toString("utf8")); } catch { unsupported("game.json 不是有效 JSON"); }
  const manifest = validateManifest(parsed, new Set(Object.keys(files)));
  if (suppliedManifest && JSON.stringify(suppliedManifest) !== JSON.stringify(manifest)) unsupported("生成清单与文件不一致");
  const stored: Record<string,StoredGameFile> = {};
  const paths=Object.keys(files).sort();
  let total = 0;
  for (const path of paths) {
    safeGamePath(path);
    const data = files[path];
    total += data.length;
    if (data.length > MAX_FILE || total > MAX_TOTAL || Object.keys(files).length > 5000) unsupported("文件超出限制");
    stored[path] = { digest: sha256(data), size: data.length, mime: mimeFor(path, data) };
  }
  await putObjects(config,paths.map(path=>files[path]));
  return { manifest, files: stored, contentDigest: sha256(JSON.stringify({ manifest, files: stored })) };
}
export async function buildExport(config: ApiConfig, files: Record<string,StoredGameFile>): Promise<string> {
  const archive: Record<string,Uint8Array> = {};
  for (const [path, file] of Object.entries(files)) archive[safeGamePath(path)] = await getObject(config, file.digest);
  return putObject(config, await runArchiveCodec("encode",archive));
}
