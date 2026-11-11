import test from "node:test";
import assert from "node:assert/strict";
import { zipSync } from "fflate";
import { decodeStaticZip, validateManifest } from "../../services/api/artifact-files";
import { sampleFiles,sampleManifest,sampleZip } from "./catalog-fixture";

test("PKG-01/02: strict ZIP parser accepts static files and rejects traversal, conflicts, bombs and CRC corruption",()=>{
  const parsed=decodeStaticZip(sampleZip());
  assert.equal(parsed["dist/index.html"].toString(),sampleFiles()["dist/index.html"].toString());
  const unsafeFiles:Record<string,Uint8Array>[]=[
    {"../outside.js":Buffer.from("x")},
    {"C:/outside.js":Buffer.from("x")},
    {"dist/A.js":Buffer.from("x"),"dist/a.js":Buffer.from("x")},
    {".env":Buffer.from("TOKEN=bad")},
    {"dist/archive.zip":Buffer.from("PK")},
    {"dist/CON.js":Buffer.from("x")},
  ];
  for(const files of unsafeFiles){
    assert.throws(()=>decodeStaticZip(Buffer.from(zipSync(files,{level:0}))),{code:"PACKAGE_UNSUPPORTED"});
  }
  const bomb=Buffer.from(zipSync({"dist/bomb.txt":Buffer.from("a".repeat(200000))},{level:9}));
  assert.throws(()=>decodeStaticZip(bomb),{code:"PACKAGE_UNSUPPORTED"});
  const corrupt=sampleZip(),signature=Buffer.from([0x50,0x4b,0x01,0x02]);
  const central=corrupt.indexOf(signature);
  corrupt.writeUInt32LE((corrupt.readUInt32LE(central+16)+1)>>>0,central+16);
  assert.throws(()=>decodeStaticZip(corrupt),{code:"PACKAGE_UNSUPPORTED"});
  const symlink=sampleZip(),offset=symlink.indexOf(signature);
  symlink.writeUInt32LE((0xa1ff<<16)>>>0,offset+38);
  assert.throws(()=>decodeStaticZip(symlink),{code:"PACKAGE_UNSUPPORTED"});
});
test("PKG-03: server rules, unsupported permissions and forged platform metadata are rejected",()=>{
  const paths=new Set(["game.json","dist/index.html"]);
  assert.equal(validateManifest(sampleManifest,paths).mode,"single");
  for(const manifest of [
    {...sampleManifest,mode:"multiplayer",maxPlayers:2},
    {...sampleManifest,serverEntry:"server/main.js"},
    {...sampleManifest,permissions:["camera"]},
    {...sampleManifest,ownerId:"forged"},
    {...sampleManifest,editable:true},
    {...sampleManifest,entry:"../index.html"},
  ])assert.throws(()=>validateManifest(manifest,paths),{code:"PACKAGE_UNSUPPORTED"});
});
