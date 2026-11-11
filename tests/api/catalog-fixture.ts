import { zipSync } from "fflate";
import type { GameManifest } from "../../packages/contracts/catalog";
export const sampleManifest:GameManifest={
  schemaVersion:1,entry:"dist/index.html",title:"静态测试游戏",description:"测试包",instructions:"点击按钮",
  cover:"",mode:"single",minPlayers:1,maxPlayers:1,devices:["desktop","mobile"],input:["mouse","touch"],
  sdkVersion:1,permissions:["save"],editable:false,assetLicenses:["测试原创"],saveSchemaVersion:1,
};
export const sampleFiles=()=>({
  "game.json":Buffer.from(JSON.stringify(sampleManifest)),
  "dist/index.html":Buffer.from('<!doctype html><html><body><button id="go">开始</button><script>document.getElementById("go").onclick=()=>document.body.dataset.played="yes";</script></body></html>'),
});
export const sampleZip=()=>Buffer.from(zipSync(sampleFiles(),{level:0}));
