import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const children = new Set();
let stopping = false;

function start(label, args) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });

  children.add(child);
  child.once("error", (error) => {
    console.error(`[${label}] failed to start`, error);
    stop(1);
  });
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!stopping) {
      const reason = signal ? `signal ${signal}` : `code ${code ?? 1}`;
      console.error(`[${label}] exited with ${reason}`);
      stop(code || 1);
    }
  });
}

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;

  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }

  const fallback = setTimeout(() => process.exit(exitCode), 1500);
  fallback.unref();
  Promise.all([...children].map((child) => new Promise((resolve) => child.once("exit", resolve))))
    .finally(() => process.exit(exitCode));
}

process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));

start("api", ["--watch", "--env-file-if-exists=.env", "server/index.mjs"]);
start("vite", ["node_modules/vite/bin/vite.js"]);
