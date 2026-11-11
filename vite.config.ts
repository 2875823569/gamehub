import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: "apps/web",
  build: { outDir: "../../dist", emptyOutDir: true, rollupOptions: {
    input: { legacy: resolve("apps/web/index.html"), platform: resolve("apps/web/platform.html") }
  } },
  server: {
    proxy: {
      "/api/v1": { target: "http://127.0.0.1:8788", ws: true },
      "/api": { target: "http://127.0.0.1:8787", ws: true }
    }
  }
});
