import { parentPort,workerData } from "node:worker_threads";
import { tsImport } from "tsx/esm/api";
import { zipSync } from "fflate";

// Only the platform parser is loaded; archive source/scripts are never imported or evaluated.
try{
  if(workerData.operation==="decode"){
    const { decodeStaticZip }=await tsImport("./artifact-files.ts",import.meta.url);
    parentPort.postMessage({ok:true,value:decodeStaticZip(Buffer.from(workerData.input))});
  }else if(workerData.operation==="encode"){
    parentPort.postMessage({ok:true,value:zipSync(workerData.input,{level:1})});
  }else throw new Error("Invalid codec operation");
}catch(error){
  parentPort.postMessage({ok:false,message:error?.code==="PACKAGE_UNSUPPORTED"?error.message:"ZIP 处理失败"});
}
