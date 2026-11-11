import { getDomain } from "tldts";

export interface ApiConfig {
  mode: "development" | "internal";
  environmentId: string;
  host: string;
  port: number;
  databaseUrl: string;
  databaseSchema: string;
  databasePoolMax?: number;
  tokenSecret: string;
  allowedOrigins: string[];
  secureCookies: boolean;
  accessTtlSeconds: number;
  gameOrigin?: string;
  assetsPort?: number;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`缺少配置 ${key}`);
  return value;
}

function integer(value: string, key: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) throw new Error(`${key} 必须是整数`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error(`${key} 超出允许范围`);
  return result;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const mode = required(env, "GAMEHUB_MODE");
  if (mode !== "development" && mode !== "internal") {
    throw new Error("当前 API 只支持 development/internal，公开部署尚未实现");
  }
  const environmentId = required(env, "GAMEHUB_ENVIRONMENT_ID");
  if (!/^[a-z][a-z0-9_-]{2,47}$/.test(environmentId)) throw new Error("环境 ID 格式不正确");
  const databaseUrl = required(env, "GAMEHUB_DATABASE_URL");
  let database: URL;
  try { database = new URL(databaseUrl); } catch { throw new Error("数据库连接配置格式不正确"); }
  if (!["postgres:", "postgresql:"].includes(database.protocol) || !database.hostname || database.pathname.length < 2) {
    throw new Error("数据库配置必须指定 PostgreSQL 主机和数据库");
  }
  const databaseSchema = env.GAMEHUB_DATABASE_SCHEMA ?? "public";
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(databaseSchema)) throw new Error("数据库 Schema 格式不正确");
  const tokenSecret = required(env, "GAMEHUB_TOKEN_SECRET");
  if (Buffer.byteLength(tokenSecret) < 32) throw new Error("GAMEHUB_TOKEN_SECRET 至少需要 32 字节");
  const allowedOrigins = required(env, "GAMEHUB_ALLOWED_ORIGINS").split(",").map(value => value.trim());
  for (const origin of allowedOrigins) {
    let url: URL;
    try { url = new URL(origin); } catch { throw new Error("允许的 Origin 格式不正确"); }
    if (url.origin !== origin || !["http:", "https:"].includes(url.protocol)) throw new Error("Origin 不得包含路径或通配符");
    if (mode === "internal" && url.protocol !== "https:") throw new Error("内测环境必须使用 HTTPS Origin");
    if (mode === "development" && url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      throw new Error("开发环境明文 HTTP 仅支持本机地址");
    }
  }
  // No real-provider adapters exist in this slice. Reject rather than silently ignore an enable flag.
  for (const key of ["GAMEHUB_REAL_PAYMENTS", "GAMEHUB_REAL_AI", "GAMEHUB_REAL_SMS"]) {
    if (env[key] && env[key] !== "false") throw new Error(`${key} 尚未开放，必须关闭`);
  }
  const host = env.GAMEHUB_API_HOST ?? "127.0.0.1";
  if (mode === "development" && !["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error("开发 API 必须监听本机地址");
  }
  const gameOrigin = env.GAMEHUB_GAME_ORIGIN ?? (mode === "development" ? "http://127.0.0.2:8790" : undefined);
  if (gameOrigin) {
    let origin: URL;
    try { origin = new URL(gameOrigin); } catch { throw new Error("游戏资源 Origin 格式不正确"); }
    const site = (hostname: string) => getDomain(hostname, { allowPrivateDomains: true }) ?? hostname;
    if (origin.origin !== gameOrigin || !["http:", "https:"].includes(origin.protocol) ||
        allowedOrigins.some(platform => site(new URL(platform).hostname) === site(origin.hostname)) ||
        (mode === "internal" && origin.protocol !== "https:") ||
        (mode === "development" && !["localhost", "127.0.0.1", "127.0.0.2", "[::1]"].includes(origin.hostname))) {
      throw new Error("游戏资源必须使用不同站点，不能仅更换端口或子域名；内测须为 HTTPS");
    }
  }
  return {
    mode, environmentId, host, databaseUrl, databaseSchema, tokenSecret, allowedOrigins,
    port: integer(env.GAMEHUB_API_PORT ?? "8788", "GAMEHUB_API_PORT", 1, 65535),
    secureCookies: mode === "internal",
    accessTtlSeconds: integer(env.GAMEHUB_ACCESS_TTL_SECONDS ?? "43200", "GAMEHUB_ACCESS_TTL_SECONDS", 60, 86400),
    gameOrigin,
    assetsPort: integer(env.GAMEHUB_ASSETS_PORT ?? "8790", "GAMEHUB_ASSETS_PORT", 1, 65535),
    databasePoolMax: integer(env.GAMEHUB_DATABASE_POOL_MAX ?? "10", "GAMEHUB_DATABASE_POOL_MAX", 1, 30),
  };
}
