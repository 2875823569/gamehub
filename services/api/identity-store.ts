import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomInt, randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import type { ApiConfig } from "./config";
import { withTransaction } from "./db";
import { AccessStore, type AccessIdentity } from "./access-store";
import { ApiError, accessRequired } from "./errors";
import { csrfToken, digest, isToken, newToken, tokenEqual } from "./tokens";
import type { AccountCapability, PlatformActor, PlatformAuth } from "./platform-auth";

export type SessionKind = "user" | "admin" | "support";
export type ChallengePurpose = "login" | "admin" | "support" | "phone-change-old" | "phone-change-new";
const mutates = (request: FastifyRequest) => ["POST", "PUT", "PATCH", "DELETE"].includes(request.method);
export const accountCookieName = (config: ApiConfig, kind: SessionKind) =>
  `${config.secureCookies ? "__Host-" : "dev_"}gamehub_${kind}`;
const accessCookie = (config: ApiConfig) => config.secureCookies ? "__Host-gamehub_test_access" : "gamehub_dev_test_access";
const authError = () => new ApiError(401, "AUTH_REQUIRED", "请先登录");
const challengeError = () => new ApiError(400, "SMS_CHALLENGE_INVALID", "验证码无效、已使用、已过期或尝试次数过多");
// Actor objects stay in-process; preserve the route's required roles through its later commit fence.
const adminRequirements=new WeakMap<PlatformActor,readonly string[]>();

export class IdentityService implements PlatformAuth {
  readonly accessStore: AccessStore;
  constructor(readonly pool: Pool, readonly config: ApiConfig) {
    this.accessStore = new AccessStore(pool, config);
  }
  private key(purpose: string) {
    return Buffer.from(hkdfSync("sha256", this.config.tokenSecret, this.config.environmentId, purpose, 32));
  }
  encrypt(value: string, purpose: string): string {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key(purpose), iv);
    return Buffer.concat([iv, cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]).toString("base64url");
  }
  decrypt(value: string, purpose: string): string {
    const bytes = Buffer.from(value, "base64url"), decipher = createDecipheriv("aes-256-gcm", this.key(purpose), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString("utf8");
  }
  phoneDigest(phone: string) { return digest(this.config.tokenSecret, `phone:${this.config.environmentId}`, phone); }
  private verifyMutation(request: FastifyRequest, token: string) {
    if (!mutates(request)) return;
    const csrf = request.headers["x-csrf-token"];
    if (!request.headers.origin || !this.config.allowedOrigins.includes(request.headers.origin) ||
        request.headers["sec-fetch-site"] === "cross-site" ||
        typeof csrf !== "string" || !tokenEqual(csrfToken(this.config.tokenSecret, token), csrf)) {
      throw new ApiError(403, "PERMISSION_DENIED", "请求校验失败，请刷新后重试");
    }
  }
  async access(request: FastifyRequest): Promise<AccessIdentity> {
    const token = request.cookies[accessCookie(this.config)];
    if (!isToken(token)) throw accessRequired();
    this.verifyMutation(request, token);
    return this.accessStore.current(token);
  }
  /** Account routes check account CSRF, while independently checking the test-access credential. */
  async authenticate(request: FastifyRequest, kind: SessionKind, capability?: AccountCapability): Promise<PlatformActor> {
    const accessToken = request.cookies[accessCookie(this.config)];
    const token = request.cookies[accountCookieName(this.config, kind)];
    if (!isToken(accessToken)) throw accessRequired();
    if (!isToken(token)) throw authError();
    this.verifyMutation(request, token);
    const access = await this.accessStore.current(accessToken);
    const result = await this.pool.query(
      `SELECT s.id, s.user_id, s.generation, u.status
       FROM account_sessions s JOIN users u ON u.id=s.user_id
       WHERE s.token_digest=$1 AND s.environment_id=$2 AND s.generation=$3
         AND s.access_session_id=$4 AND s.kind=$5 AND s.revoked_at IS NULL AND s.expires_at>now()`,
      [digest(this.config.tokenSecret, "account", token), this.config.environmentId, access.generation, access.id, kind],
    );
    const row = result.rows[0];
    if (!row) throw authError();
    if (kind !== "support" && row.status !== "active") throw new ApiError(403, "ACCOUNT_RESTRICTED", "账号已受限，请使用支持入口");
    const roles = (await this.pool.query<{ role: string }>("SELECT role FROM role_assignments WHERE user_id=$1", [row.user_id])).rows.map(r => r.role);
    const actor: PlatformActor = { userId: row.user_id, sessionId: row.id, accessSessionId: access.id, generation: access.generation, roles };
    if (kind !== "support") await this.checkRestrictions(this.pool, actor.userId, capability);
    return actor;
  }
  user(request: FastifyRequest, capability?: AccountCapability) { return this.authenticate(request, "user", capability); }
  async admin(request: FastifyRequest, roles: readonly string[] = []) {
    const actor = await this.authenticate(request, "admin");
    if (!actor.roles.length || (!actor.roles.includes("super_admin") && roles.length && !actor.roles.some(role => roles.includes(role)))) {
      throw new ApiError(403, "PERMISSION_DENIED", "没有所需后台权限");
    }
    adminRequirements.set(actor,roles);
    return actor;
  }
  async checkRestrictions(client: Pick<PoolClient, "query"> | Pool, userId: string, capability?: AccountCapability) {
    const found = await client.query(
      `SELECT 1 FROM account_restrictions WHERE user_id=$1 AND released_at IS NULL
       AND (expires_at IS NULL OR expires_at>now()) AND capability=ANY($2::text[]) LIMIT 1`,
      [userId, capability ? ["all", capability] : ["all"]],
    );
    if (found.rowCount) throw new ApiError(403, "ACCOUNT_RESTRICTED", "账号暂时不能执行此操作");
  }
  async assertActor(client: PoolClient, actor: PlatformActor, capability?: AccountCapability) {
    const found = await client.query(
      `SELECT u.id,s.kind FROM users u
       JOIN account_sessions s ON s.user_id=u.id
       JOIN test_access_sessions a ON a.id=s.access_session_id
       JOIN test_access_grants g ON g.id=a.grant_id
       JOIN environments e ON e.id=s.environment_id
       WHERE u.id=$1 AND s.id=$2 AND u.status='active'
         AND e.id=$3 AND e.generation=$4 AND e.accepting_access
         AND s.generation=e.generation AND s.revoked_at IS NULL AND s.expires_at>now()
         AND a.revoked_at IS NULL AND a.expires_at>now() AND g.revoked_at IS NULL AND g.expires_at>now()
       FOR SHARE OF e,u,s,a,g`,
      [actor.userId, actor.sessionId, this.config.environmentId, actor.generation],
    );
    if (!found.rowCount) throw authError();
    if(found.rows[0].kind==="admin"){
      const required=adminRequirements.get(actor)??[];
      const roles=(await client.query<{role:string}>("SELECT role FROM role_assignments WHERE user_id=$1 FOR SHARE",[actor.userId])).rows.map(row=>row.role);
      if(!roles.length || (!roles.includes("super_admin") && required.length && !roles.some(role=>required.includes(role)))){
        throw new ApiError(403,"PERMISSION_DENIED","后台权限已变化，请重新登录");
      }
    }
    await this.checkRestrictions(client, actor.userId, capability);
  }
  async assertAccess(client: PoolClient, access: AccessIdentity) {
    const result = await client.query(
      `SELECT a.id FROM environments e JOIN test_access_sessions a ON a.environment_id=e.id
       JOIN test_access_grants g ON g.id=a.grant_id
       WHERE e.id=$1 AND e.generation=$2 AND e.accepting_access
         AND a.id=$3 AND a.generation=e.generation AND a.revoked_at IS NULL AND a.expires_at>now()
         AND g.revoked_at IS NULL AND g.expires_at>now() FOR SHARE OF e,a,g`,
      [this.config.environmentId, access.generation, access.id],
    );
    if (!result.rowCount) throw accessRequired();
  }
  async allowTestPhone(phone: string, actor: string) {
    if (!/^1[3-9]\d{9}$/.test(phone) || !actor.trim()) throw new Error("需要有效测试手机号和操作者");
    await withTransaction(this.pool, async client => {
      await client.query(`INSERT INTO test_phone_allowlist(environment_id,phone_digest) VALUES($1,$2)
        ON CONFLICT(environment_id,phone_digest) DO UPDATE SET enabled=true`, [this.config.environmentId, this.phoneDigest(phone)]);
      await client.query(
        `INSERT INTO audit_events(id,environment_id,generation,actor,action,metadata)
         SELECT $1,id,generation,$3,'test_phone_allowed',$4 FROM environments WHERE id=$2`,
        [randomUUID(), this.config.environmentId, actor, { phoneDigest: this.phoneDigest(phone) }]);
    });
  }
  async readTestCode(challengeId: string): Promise<string> {
    const result = await this.pool.query(
      `SELECT d.code_ciphertext FROM test_sms_deliveries d JOIN sms_challenges c ON c.id=d.challenge_id
       WHERE d.challenge_id=$1 AND c.environment_id=$2 AND d.expires_at>now() AND c.consumed_at IS NULL`,
      [challengeId, this.config.environmentId],
    );
    if (!result.rows[0]) throw new Error("没有可用的测试验证码");
    return this.decrypt(result.rows[0].code_ciphertext, "test-sms");
  }
  async challenge(access: AccessIdentity, phone: string, purpose: ChallengePurpose) {
    return withTransaction(this.pool, async client => {
      await this.assertAccess(client, access);
      const phoneHash = this.phoneDigest(phone);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))", [this.config.environmentId, phoneHash]);
      const allowed = await client.query("SELECT 1 FROM test_phone_allowlist WHERE environment_id=$1 AND phone_digest=$2 AND enabled", [this.config.environmentId, phoneHash]);
      if (!allowed.rowCount) throw new ApiError(403, "PERMISSION_DENIED", "测试短信仅支持已授权号码，请联系测试管理员");
      const recent = await client.query(
        `SELECT count(*) FILTER(WHERE created_at>now()-interval '60 seconds')::int AS recent,
         count(*)::int AS daily FROM sms_challenges WHERE environment_id=$1 AND phone_digest=$2 AND created_at>now()-interval '1 day'`,
        [this.config.environmentId, phoneHash],
      );
      if (recent.rows[0].recent || recent.rows[0].daily >= 10) throw new ApiError(429, "RATE_LIMITED", "验证码发送过于频繁，请稍后重试");
      const id = randomUUID(), code = randomInt(0, 1000000).toString().padStart(6, "0");
      const result = await client.query(
        `INSERT INTO sms_challenges(id,environment_id,generation,access_session_id,phone_digest,phone_ciphertext,purpose,code_digest,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '5 minutes') RETURNING expires_at`,
        [id, this.config.environmentId, access.generation, access.id, phoneHash, this.encrypt(phone, "phone"), purpose,
          digest(this.config.tokenSecret, `sms:${id}`, code)],
      );
      await client.query("INSERT INTO test_sms_deliveries(challenge_id,code_ciphertext,expires_at) VALUES($1,$2,$3)",
        [id, this.encrypt(code, "test-sms"), result.rows[0].expires_at]);
      return { challengeId: id, expiresAt: result.rows[0].expires_at.toISOString(), resendAfterSeconds: 60, provider: "test" };
    });
  }
  private async verifyChallenge(client: PoolClient, access: AccessIdentity, id: string, code: string, allowed: readonly ChallengePurpose[]) {
    const result = await client.query(
      `SELECT *, expires_at>now() AS unexpired FROM sms_challenges WHERE id=$1 AND environment_id=$2 AND generation=$3
       AND access_session_id=$4 FOR UPDATE`,
      [id, this.config.environmentId, access.generation, access.id],
    );
    const row = result.rows[0];
    if (!row || row.consumed_at || !row.unexpired || row.attempts >= 5 || !allowed.includes(row.purpose)) return null;
    if (!tokenEqual(row.code_digest, digest(this.config.tokenSecret, `sms:${id}`, code))) {
      await client.query("UPDATE sms_challenges SET attempts=attempts+1 WHERE id=$1", [id]);
      return null;
    }
    return row;
  }
  async login(access: AccessIdentity, body: { challengeId: string; code: string; acceptTerms?: boolean; termsVersion?: string }) {
    const result = await withTransaction(this.pool, async client => {
      await this.assertAccess(client, access);
      const challenge = await this.verifyChallenge(client, access, body.challengeId, body.code, ["login", "admin", "support"]);
      if (!challenge) return { error: challengeError() } as const;
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))", [this.config.environmentId, challenge.phone_digest]);
      const found = await client.query(
        `SELECT u.id,u.nickname,u.status,u.avatar_key AS "avatarKey" FROM phone_bindings p JOIN users u ON u.id=p.user_id
         WHERE p.environment_id=$1 AND p.phone_digest=$2 AND p.active FOR UPDATE OF u`,
        [this.config.environmentId, challenge.phone_digest],
      );
      let user = found.rows[0];
      if (!user) {
        if (challenge.purpose !== "login") return { error: authError() } as const;
        if (body.acceptTerms !== true || body.termsVersion !== "internal-v1") {
          return { error: new ApiError(400, "INVALID_REQUEST", "首次注册需明确同意内测注册协议") } as const;
        }
        user = { id: randomUUID(), nickname: "新玩家", status: "active",avatarKey:"dice" };
        await client.query("INSERT INTO users(id,environment_id,nickname,terms_version) VALUES($1,$2,$3,$4)",
          [user.id, this.config.environmentId, user.nickname, body.termsVersion]);
        await client.query(
          "INSERT INTO phone_bindings(id,user_id,environment_id,phone_digest,phone_ciphertext) VALUES($1,$2,$3,$4,$5)",
          [randomUUID(), user.id, this.config.environmentId, challenge.phone_digest, challenge.phone_ciphertext],
        );
      }
      const kind: SessionKind = challenge.purpose === "login" ? "user" : challenge.purpose;
      if (kind !== "support" && user.status !== "active") {
        return { error: new ApiError(403, "ACCOUNT_RESTRICTED", "账号已受限，请使用支持入口") } as const;
      }
      if (kind !== "support") {
        try { await this.checkRestrictions(client, user.id); }
        catch (error) { return { error: error as ApiError } as const; }
      }
      const roles = (await client.query<{ role: string }>("SELECT role FROM role_assignments WHERE user_id=$1", [user.id])).rows.map(r => r.role);
      if (kind === "admin" && !roles.length) return { error: new ApiError(403, "PERMISSION_DENIED", "此账号没有后台角色") } as const;
      await client.query("UPDATE sms_challenges SET consumed_at=now() WHERE id=$1", [challenge.id]);
      await client.query("DELETE FROM test_sms_deliveries WHERE challenge_id=$1", [challenge.id]);
      await client.query("UPDATE account_sessions SET revoked_at=now() WHERE access_session_id=$1 AND kind=$2 AND revoked_at IS NULL", [access.id, kind]);
      const id = randomUUID(), token = newToken();
      const session = await client.query(
        `INSERT INTO account_sessions(id,environment_id,generation,user_id,access_session_id,kind,token_digest,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,LEAST($8::timestamptz,now()+interval '12 hours')) RETURNING expires_at`,
        [id, this.config.environmentId, access.generation, user.id, access.id, kind, digest(this.config.tokenSecret, "account", token), access.expires_at],
      );
      return { token, kind, user, roles, expiresAt: session.rows[0].expires_at.toISOString() };
    });
    if ("error" in result) throw result.error;
    return result;
  }
  async grantRole(userId: string, role: string, actor: string) {
    if (!["super_admin", "reviewer", "operations", "finance", "support"].includes(role) || !actor.trim()) throw new Error("无效角色或操作者");
    await withTransaction(this.pool, async client => {
      const user = await client.query("SELECT id FROM users WHERE id=$1 AND environment_id=$2 FOR UPDATE", [userId, this.config.environmentId]);
      if (!user.rowCount) throw new Error("账号不存在");
      await client.query("INSERT INTO role_assignments(user_id,role,assigned_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [userId, role, actor]);
      await client.query(
        `INSERT INTO audit_events(id,environment_id,generation,actor,action,object_id,metadata)
         SELECT $1,id,generation,$3,'role_granted',$4,$5 FROM environments WHERE id=$2`,
        [randomUUID(), this.config.environmentId, actor, userId, JSON.stringify({ role })],
      );
    });
  }
  async revokeRole(userId: string, role: string, actor: string) {
    if (!["super_admin", "reviewer", "operations", "finance", "support"].includes(role) || !actor.trim()) throw new Error("无效角色或操作者");
    await withTransaction(this.pool, async client => {
      const user = await client.query("SELECT id FROM users WHERE id=$1 AND environment_id=$2 FOR UPDATE", [userId, this.config.environmentId]);
      if (!user.rowCount) throw new Error("账号不存在");
      await client.query("DELETE FROM role_assignments WHERE user_id=$1 AND role=$2", [userId, role]);
      await client.query("UPDATE account_sessions SET revoked_at=now() WHERE user_id=$1 AND kind='admin'", [userId]);
      await client.query(
        `INSERT INTO audit_events(id,environment_id,generation,actor,action,object_id,metadata)
         SELECT $1,id,generation,$3,'role_revoked',$4,$5 FROM environments WHERE id=$2`,
        [randomUUID(), this.config.environmentId, actor, userId, { role }]);
    });
  }
  async changePhone(actor: PlatformActor, access: AccessIdentity, body: {
    oldChallengeId: string; oldCode: string; newChallengeId: string; newCode: string;
  }) {
    const result = await withTransaction(this.pool, async client => {
      await this.assertActor(client, actor);
      const old = await this.verifyChallenge(client, access, body.oldChallengeId, body.oldCode, ["phone-change-old"]);
      if (!old) return { error: challengeError() };
      const next = await this.verifyChallenge(client, access, body.newChallengeId, body.newCode, ["phone-change-new"]);
      if (!next) return { error: challengeError() };
      const current = await client.query("SELECT id,phone_digest FROM phone_bindings WHERE user_id=$1 AND active FOR UPDATE", [actor.userId]);
      if (current.rows[0]?.phone_digest !== old.phone_digest) return { error: new ApiError(403, "PERMISSION_DENIED", "必须验证当前绑定手机号") };
      if (old.phone_digest === next.phone_digest) return { error: new ApiError(409, "VERSION_CONFLICT", "新手机号与当前号码相同") };
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))", [this.config.environmentId, next.phone_digest]);
      const occupied = await client.query("SELECT id FROM phone_bindings WHERE environment_id=$1 AND phone_digest=$2 AND active", [this.config.environmentId, next.phone_digest]);
      if (occupied.rowCount) return { error: new ApiError(409, "VERSION_CONFLICT", "该号码不可绑定") };
      await client.query("UPDATE phone_bindings SET active=false, retired_at=now() WHERE id=$1", [current.rows[0].id]);
      await client.query("INSERT INTO phone_bindings(id,user_id,environment_id,phone_digest,phone_ciphertext) VALUES($1,$2,$3,$4,$5)",
        [randomUUID(), actor.userId, this.config.environmentId, next.phone_digest, next.phone_ciphertext]);
      await client.query("UPDATE sms_challenges SET consumed_at=now() WHERE id=ANY($1::uuid[])", [[old.id, next.id]]);
      await client.query("DELETE FROM test_sms_deliveries WHERE challenge_id=ANY($1::uuid[])", [[old.id, next.id]]);
      await client.query("UPDATE account_sessions SET revoked_at=now() WHERE user_id=$1", [actor.userId]);
      await client.query(
        "INSERT INTO audit_events(id,environment_id,generation,actor,action,object_id) VALUES($1,$2,$3,$4,'phone_changed',$5)",
        [randomUUID(), this.config.environmentId, actor.generation, actor.userId, actor.userId]);
      return { changed: true };
    });
    if ("error" in result) throw result.error;
    return result;
  }
}
