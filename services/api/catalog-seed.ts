import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { ApiConfig } from "./config";
import { withTransaction } from "./db";
import { games as officialGames } from "../../apps/web/src/platform/catalog";
import { sha256 } from "./artifact-files";

export async function seedOfficialCatalog(pool:Pool,config:ApiConfig) {
  return withTransaction(pool,async client=>{
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`${config.environmentId}:official-catalog`]);
    let author=(await client.query("SELECT id FROM users WHERE environment_id=$1 AND terms_version='official-system' ORDER BY created_at LIMIT 1",[config.environmentId])).rows[0];
    if(!author){
      author={id:randomUUID()};
      await client.query("INSERT INTO users(id,environment_id,nickname,terms_version)VALUES($1,$2,'GameHub 官方','official-system')",[author.id,config.environmentId]);
    }
    const result=[];
    for(const game of officialGames){
      const existing=(await client.query("SELECT id FROM games WHERE environment_id=$1 AND official_key=$2",[config.environmentId,game.id])).rows[0];
      if(existing){
        await client.query(`UPDATE game_versions SET check_evidence=check_evidence || $2::jsonb
          WHERE game_id=$1 AND source='official'`,[existing.id,{runtimeMigrated:true,runtime:"platform-authoritative-host-game",ugcSandboxVerified:false}]);
        result.push({id:existing.id,officialKey:game.id,created:false});continue;
      }
      const id=randomUUID(),versionId=randomUUID();
      const manifest={schemaVersion:1,entry:"dist/index.html",title:game.title,description:game.subtitle,instructions:game.rules.join("\n"),
        cover:"",mode:game.minPlayers===1?"single":"multiplayer",minPlayers:game.minPlayers,maxPlayers:game.maxPlayers,
        devices:["desktop","mobile"],input:["mouse","touch"],sdkVersion:1,permissions:[],editable:false,
        assetLicenses:["平台官方游戏；衍生模板授权另行核定"]};
      await client.query("INSERT INTO games(id,environment_id,owner_id,official_key,title,description,category,status)VALUES($1,$2,$3,$4,$5,$6,$7,'published')",
        [id,config.environmentId,author.id,game.id,game.title,game.subtitle,game.category]);
      await client.query(`INSERT INTO game_versions(id,game_id,number,manifest,files,source,content_digest,check_status,check_evidence,review_status)
        VALUES($1,$2,1,$3,'{}','official',$4,'passed',$5,'approved')`,
        [versionId,id,manifest,sha256(JSON.stringify(manifest)),{trustedOfficial:true,runtimeMigrated:true,runtime:"platform-authoritative-host-game",ugcSandboxVerified:false}]);
      await client.query("INSERT INTO projects(id,game_id,owner_id,base_version_id)VALUES($1,$2,$3,$4)",[randomUUID(),id,author.id,versionId]);
      await client.query("INSERT INTO publication_heads(environment_id,scope,game_id,version_id)VALUES($1,'internal_catalog',$2,$3)",[config.environmentId,id,versionId]);
      await client.query("UPDATE games SET current_version_id=$2 WHERE id=$1",[id,versionId]);
      result.push({id,officialKey:game.id,created:true});
    }
    return result;
  });
}
