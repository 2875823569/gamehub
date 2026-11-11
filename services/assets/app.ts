import Fastify from "fastify";
import type { Pool } from "pg";
import type { ApiConfig } from "../api/config";
import { readPlayResource } from "../api/play-store";
import { ApiError } from "../api/errors";

export async function buildAssetsApp(config: ApiConfig, pool: Pool) {
  const app = Fastify({ logger: false, bodyLimit: 1024, requestTimeout: 10000 });
  app.addHook("onRequest", async (_request, reply) => {
    reply.headers({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "cross-origin",
      // No cookies or platform credentials on this origin. Opaque-origin modules use anonymous CORS.
      "Access-Control-Allow-Origin": "*",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      "Content-Security-Policy": [
        "default-src 'none'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:", "font-src 'self' data:", "media-src 'self' blob:",
        "connect-src 'none'", "frame-src 'none'", "object-src 'none'", "base-uri 'none'",
        "form-action 'none'", "sandbox allow-scripts",
        `frame-ancestors ${config.allowedOrigins.join(" ")}`,
      ].join("; "),
    });
  });
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/play/:sessionId/:resourceToken/*", async (request, reply) => {
    const params = request.params as { sessionId: string; resourceToken: string; "*": string };
    const result = await readPlayResource(pool, config, {
      sessionId: params.sessionId, resourceToken: params.resourceToken, path: params["*"],
    });
    return reply.type(result.mime).send(result.body);
  });
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof ApiError ? error.statusCode : 503;
    reply.code(status).type("text/plain; charset=utf-8").send(status === 503 ? "资源服务暂不可用" : "资源不可访问");
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).type("text/plain").send("Not found"));
  return app;
}
