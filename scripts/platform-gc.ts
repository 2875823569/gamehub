import { loadConfig } from "../services/api/config";
import { createPool } from "../services/api/db";
import { collectArtifactOrphans } from "../services/api/artifact-gc";
const config=loadConfig(),pool=createPool(config);
try{
  const apply=process.argv.includes("--apply"),index=process.argv.indexOf("--environment");
  console.log(JSON.stringify(await collectArtifactOrphans(pool,config,{apply,confirmEnvironment:index<0?undefined:process.argv[index+1]}),null,2));
}catch(error){console.error(error instanceof Error?error.message:"资源清理失败");process.exitCode=1;}
finally{await pool.end();}
