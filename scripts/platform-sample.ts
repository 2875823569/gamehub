import { readFile,mkdir,writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { zipSync } from "fflate";
import { loadConfig } from "../services/api/config";
import { decodeStaticZip } from "../services/api/artifact-files";
const config=loadConfig();
const manifest=await readFile(new URL("../examples/single-counter/game.json",import.meta.url));
const html=(await readFile(new URL("../examples/single-counter/dist/index.html",import.meta.url),"utf8"))
  .replace(/\/\*GAMEHUB_ORIGINS\*\/\[[^\]]+\]/,`/*GAMEHUB_ORIGINS*/${JSON.stringify(config.allowedOrigins)}`);
const bytes=Buffer.from(zipSync({"game.json":manifest,"dist/index.html":Buffer.from(html)},{level:1}));
decodeStaticZip(bytes);
const directory=resolve("work/platform/samples");await mkdir(directory,{recursive:true});
const path=resolve(directory,"single-counter.zip");await writeFile(path,bytes);
console.log(JSON.stringify({path,bytes:bytes.length,mode:"single",sdkVersion:1}));
