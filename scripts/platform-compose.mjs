import { spawn, spawnSync } from "node:child_process";

const native = spawnSync("docker", ["compose", "version"], { stdio: "ignore", windowsHide: true });
const command = native.status === 0 ? "docker" : "docker-compose";
const prefix = native.status === 0 ? ["compose"] : [];
const operation = process.argv[2];
if (!["up", "down"].includes(operation)) throw new Error("Only up/down are supported");
const args = [...prefix, "-f", "infra/compose.dev.yml", ...(operation === "up" ? ["up", "-d", "--wait"] : ["down"])];
const child = spawn(command, args, { stdio: "inherit", windowsHide: true });
child.on("error", () => { console.error("请先安装并启动 Docker 和 Docker Compose"); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
