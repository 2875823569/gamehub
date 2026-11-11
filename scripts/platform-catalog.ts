import { loadConfig } from "../services/api/config";
import { createPool } from "../services/api/db";
import { seedOfficialCatalog } from "../services/api/catalog-seed";

const config=loadConfig(),pool=createPool(config);
try{console.log(JSON.stringify(await seedOfficialCatalog(pool,config),null,2));}
catch{console.error("官方目录导入失败，请检查迁移与环境配置");process.exitCode=1;}
finally{await pool.end();}
