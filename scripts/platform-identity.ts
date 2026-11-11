import { loadConfig } from "../services/api/config";
import { createPool } from "../services/api/db";
import { IdentityService } from "../services/api/identity-store";

const config = loadConfig(), pool = createPool(config), service = new IdentityService(pool, config);
try {
  const [command, value, arg, actor] = process.argv.slice(2);
  if (command === "allow-phone") {
    if (!value || !arg) throw new Error("用法 allow-phone <测试手机号> <操作者>");
    await service.allowTestPhone(value, arg);
    console.log("已加入内测短信白名单，不会发送真实短信");
  } else if (command === "sms-code") {
    if (!value || !/^[0-9a-f-]{36}$/i.test(value)) throw new Error("需要挑战 UUID");
    console.log(await service.readTestCode(value));
  } else if (command === "grant-role" || command === "revoke-role") {
    if (!value || !arg || !actor) throw new Error("用法 grant-role <用户UUID> <角色> <操作者>");
    if (command === "grant-role") await service.grantRole(value, arg, actor);
    else await service.revokeRole(value, arg, actor);
    console.log(command === "grant-role" ? "已授予后台角色；仍需独立后台验证码登录" : "已撤销角色和现有后台会话");
  } else throw new Error("命令：allow-phone / sms-code / grant-role / revoke-role");
} catch (error) {
  if (error instanceof Error && !("code" in error)) console.error(error.message);
  else console.error("身份管理操作失败，请检查参数、权限和数据库");
  process.exitCode = 1;
} finally { await pool.end(); }
