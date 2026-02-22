#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

main().catch((error) => {
  console.error("[e2e-base-mainnet-supply] failed:", error.message);
  process.exit(1);
});

async function main() {
  await run("node", ["./scripts/e2e-fork.mjs"], {
    cwd: rootDir,
    env: {
      ...process.env,
      HUB_CHAIN_ID: process.env.HUB_CHAIN_ID ?? "1",
      SPOKE_NETWORK: process.env.SPOKE_NETWORK ?? "base",
      E2E_SUPPLY_ONLY: "1"
    }
  });
}

async function run(cmd, args, options) {
  await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: "inherit"
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`${cmd} ${args.join(" ")} failed with exit code ${code}`));
    });
  });
}
