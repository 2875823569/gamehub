import { Worker } from "node:worker_threads";
import { ApiError } from "./errors";

/** Runs platform-owned ZIP codecs off the API event loop. This is not a UGC code sandbox. */
export function runArchiveCodec(operation:"decode",input:Buffer):Promise<Record<string,Buffer>>;
export function runArchiveCodec(operation:"encode",input:Record<string,Uint8Array>):Promise<Buffer>;
export async function runArchiveCodec(operation:"decode"|"encode",input:Buffer|Record<string,Uint8Array>):Promise<Buffer|Record<string,Buffer>>{
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL("./artifact-codec-worker.mjs",import.meta.url),{
      workerData:{operation,input},
      resourceLimits:{maxOldGenerationSizeMb:512,maxYoungGenerationSizeMb:32,stackSizeMb:4},
    });
    let settled=false;
    const finish=(error?:Error,value?:Buffer|Record<string,Buffer>)=>{
      if(settled)return;settled=true;clearTimeout(timer);void worker.terminate();
      if(error)reject(error);else resolve(value!);
    };
    const timer=setTimeout(()=>finish(new ApiError(422,"PACKAGE_UNSUPPORTED","ZIP 处理超时，请缩小游戏包")),30000);
    worker.once("message",(result:{ok:boolean;message?:string;value:Uint8Array|Record<string,Uint8Array>})=>{
      if(!result.ok)return finish(new ApiError(422,"PACKAGE_UNSUPPORTED",result.message??"ZIP 处理失败"));
      finish(undefined,operation==="encode"?Buffer.from(result.value as Uint8Array):
        Object.fromEntries(Object.entries(result.value).map(([path,bytes])=>[path,Buffer.from(bytes)])));
    });
    worker.once("error",()=>finish(new ApiError(422,"PACKAGE_UNSUPPORTED","ZIP 处理资源不足或解析失败")));
    worker.once("exit",code=>{if(!settled)finish(new ApiError(422,"PACKAGE_UNSUPPORTED",`ZIP 处理进程结束（${code}）`));});
  });
}
