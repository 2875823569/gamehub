import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const template = await readFile(new URL("../.env.example", import.meta.url), "utf8");
try {
  await writeFile(new URL("../.env", import.meta.url),
    template.replace(/^GAMEHUB_TOKEN_SECRET=$/m, `GAMEHUB_TOKEN_SECRET=${randomBytes(32).toString("hex")}`),
    { flag: "wx", mode: 0o600 });
  console.log("已生成本机 .env 和随机令牌密钥；未开通外部服务。");
} catch (error) {
  if (error.code === "EEXIST") console.log(".env 已存在，保留当前配置。");
  else throw error;
}
