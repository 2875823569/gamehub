import { loadConfig } from "../services/api/config";
import { createPool } from "../services/api/db";
import { previewReset,resetEnvironment,resumeEnvironment } from "./platform-operations-store";

const config=loadConfig(),pool=createPool(config);
try {
  const command=process.argv[2]??"preview";
  if(command==="preview")console.log(JSON.stringify(await previewReset(pool,config),null,2));
  else if(command==="execute"||command==="resume"){
    const generation=Number(process.argv[3]),confirmation=process.argv[4],operator=process.argv[5];
    if(!confirmation||!operator)throw new Error("需要参数：世代、带引号的精确确认文本、操作者");
    const input={generation,confirmation,operator};
    console.log(JSON.stringify(await (command==="execute"?resetEnvironment(pool,config,input):resumeEnvironment(pool,config,input)),null,2));
  }else throw new Error("支持 preview、execute、resume");
} catch(error) {
  console.error(error instanceof Error && !("code" in error)?error.message:"操作失败，环境或世代不匹配；未进行部分重置");
  process.exitCode=1;
} finally { await pool.end(); }
