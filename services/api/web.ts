import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { ApiConfig } from "./config";

export async function registerPlatformWeb(app: FastifyInstance, config: ApiConfig) {
  const dist = resolve("dist");
  if (!existsSync(resolve(dist, "platform.html"))) return;
  await app.register(fastifyStatic, { root: resolve(dist, "assets"), prefix: "/assets/", index: false });
  app.get("/", async (_request, reply) => {
    reply.header("Content-Security-Policy", `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src ${config.gameOrigin ?? "'none'"}; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`);
    reply.header("Referrer-Policy", "no-referrer");
    return reply.sendFile("platform.html", dist);
  });
  app.get("/favicon.svg", (_request, reply) => reply.sendFile("favicon.svg", dist));
}
