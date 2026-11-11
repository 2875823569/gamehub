import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { ApiConfig } from "./config";
import type { AccessIdentity } from "./access-store";

export type AccountCapability = "create" | "submit" | "comment" | "billing";
export interface PlatformActor {
  userId: string;
  sessionId: string;
  accessSessionId: string;
  generation: number;
  roles: string[];
}
export interface PlatformAuth {
  /** Validate test access and CSRF on mutations. Never grants account privileges. */
  access(request: FastifyRequest): Promise<AccessIdentity>;
  /** Validate account, access, generation, restrictions and CSRF on mutations. */
  user(request: FastifyRequest, capability?: AccountCapability): Promise<PlatformActor>;
  /** Requires a separate admin session, role and test access. */
  admin(request: FastifyRequest, roles?: readonly string[]): Promise<PlatformActor>;
}
export interface PlatformModuleContext {
  app: FastifyInstance;
  config: ApiConfig;
  pool: Pool;
  auth: PlatformAuth;
}
