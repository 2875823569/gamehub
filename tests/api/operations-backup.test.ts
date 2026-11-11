import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile,writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./fixtures";
import { putObject } from "../../services/api/artifact-files";
import { backupPrivateObjects,restorePrivateObjectsDrill } from "../../scripts/platform-object-backup";

test("private-object backup restores only its namespace and rejects modified bytes and outside paths",async t=>{
  const f=await fixture(t),config={...f.config,mode:"development" as const};
  const content=Buffer.from(`私有对象恢复测试 ${randomUUID()}`),digest=await putObject(config,content);
  const backup=await backupPrivateObjects(config);
  assert.equal(backup.objects,1);
  const restored=await restorePrivateObjectsDrill(config,backup.path);
  assert.equal(restored.objects,1);
  assert.deepEqual(await readFile(join(restored.path,digest)),content);
  await assert.rejects(()=>restorePrivateObjectsDrill({...config,environmentId:"other-env"},backup.path),/命名空间/);
  await assert.rejects(()=>restorePrivateObjectsDrill(config,join(backup.path,"..")),/仅恢复/);
  await writeFile(join(backup.path,"objects",digest),"tampered");
  await assert.rejects(()=>restorePrivateObjectsDrill(config,backup.path),/损坏/);
});

test("object backup refuses non-development targets before accessing storage",async t=>{
  const f=await fixture(t);
  await assert.rejects(()=>backupPrivateObjects(f.config),/loopback/);
  await assert.rejects(()=>backupPrivateObjects({...f.config,mode:"development",databaseUrl:"postgresql://gamehub@example.com:55432/gamehub_dev"}),/loopback/);
});
