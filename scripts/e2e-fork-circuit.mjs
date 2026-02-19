#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createPublicClient, defineChain, http } from "viem";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const dotEnv = loadDotEnv(path.join(rootDir, ".env"));
const SPOKE_NETWORKS = {
  base: { envPrefix: "BASE", label: "Base", defaultChainId: 8453 },
  bsc: { envPrefix: "BSC", label: "BSC", defaultChainId: 56 }
};

const artifactsDir = process.env.PROVER_CIRCUIT_ARTIFACTS_DIR
  ?? path.join(rootDir, "circuits", "prover", "artifacts");
const wasmPath = process.env.PROVER_CIRCUIT_WASM_PATH
  ?? path.join(artifactsDir, "SettlementBatchRoot_js", "SettlementBatchRoot.wasm");
const zkeyPath = process.env.PROVER_CIRCUIT_ZKEY_PATH
  ?? path.join(artifactsDir, "SettlementBatchRoot_final.zkey");

const groth16VerifierAddress =
  process.env.HUB_GROTH16_VERIFIER_ADDRESS
  ?? dotEnv.HUB_GROTH16_VERIFIER_ADDRESS
  ?? "";
const hubRpcUrl = resolveEnvValue("HUB_RPC_URL", "http://127.0.0.1:8545");
const hubChainId = resolveEnvValue("HUB_CHAIN_ID", "1");
const spoke = resolveSpokeConfig("http://127.0.0.1:8546");
const spokeRpcUrl = spoke.rpcUrl;
const spokeChainId = String(spoke.chainId);
const spokeNetwork = spoke.network;
const spokeChainKey = spoke.chainKey;
const spokeRpcKey = spoke.rpcKey;
const configuredSnarkjsBin = process.env.PROVER_SNARKJS_BIN ?? dotEnv.PROVER_SNARKJS_BIN ?? "";

main().catch((error) => {
  console.error("[e2e-circuit] failed:", error.message);
  process.exit(1);
});

async function main() {
  const snarkjsBin = await preflightChecks();

  console.log("[e2e-circuit] starting fork E2E in circuit mode");
  await run("node", ["./scripts/e2e-fork.mjs"], {
    cwd: rootDir,
    env: {
      ...process.env,
      HUB_RPC_URL: hubRpcUrl,
      HUB_CHAIN_ID: hubChainId,
      SPOKE_NETWORK: spokeNetwork,
      [spokeRpcKey]: spokeRpcUrl,
      [spokeChainKey]: spokeChainId,
      E2E_PROVER_MODE: "circuit",
      HUB_VERIFIER_DEV_MODE: "0",
      HUB_GROTH16_VERIFIER_ADDRESS: groth16VerifierAddress,
      PROVER_SNARKJS_BIN: snarkjsBin
    }
  });
}

async function preflightChecks() {
  if (!isHexAddress(groth16VerifierAddress)) {
    throw new Error(
      "Set HUB_GROTH16_VERIFIER_ADDRESS to the deployed generated Groth16 verifier contract address."
    );
  }

  if (!fs.existsSync(wasmPath)) {
    throw new Error(`Missing circuit wasm at ${wasmPath}. Run: bash ./circuits/prover/build-artifacts.sh`);
  }
  if (!fs.existsSync(zkeyPath)) {
    throw new Error(`Missing circuit zkey at ${zkeyPath}. Run: bash ./circuits/prover/build-artifacts.sh`);
  }

  const snarkjs = resolveSnarkjsBin();
  console.log(`[e2e-circuit] using snarkjs binary: ${snarkjs}`);

  const verifierHasCode = await hasBytecodeOnHub(groth16VerifierAddress);
  if (!verifierHasCode) {
    throw new Error(
      `HUB_GROTH16_VERIFIER_ADDRESS=${groth16VerifierAddress} has no bytecode on HUB_RPC_URL=${hubRpcUrl}.\n` +
      "Run pnpm test:e2e:fork:circuit:prepare and use the printed exports for this same RPC/fork."
    );
  }

  return snarkjs;
}

function resolveSnarkjsBin() {
  const candidates = uniqueNonEmpty([
    configuredSnarkjsBin,
    "snarkjs",
    path.join(rootDir, "node_modules", ".bin", "snarkjs"),
    path.join(os.homedir(), "Library", "pnpm", "snarkjs")
  ]);

  const probeArgs = ["groth16", "fullprove", "--help"];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, probeArgs, { stdio: "ignore" });
    if (!probe.error && probe.status === 0) {
      return candidate;
    }
  }

  throw new Error(
    "Unable to execute 'snarkjs'. Set PROVER_SNARKJS_BIN to the binary path " +
    "(example: /Users/sebas/Library/pnpm/snarkjs)."
  );
}

function uniqueNonEmpty(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function resolveEnvValue(key, fallback = "") {
  return process.env[key] ?? dotEnv[key] ?? fallback;
}

function resolveSpokeConfig(defaultRpcUrl = "") {
  const network = normalizeSpokeNetwork(resolveEnvValue("SPOKE_NETWORK", "base"));
  const config = SPOKE_NETWORKS[network];
  const chainKey = `SPOKE_${config.envPrefix}_CHAIN_ID`;
  const rpcKey = `SPOKE_${config.envPrefix}_RPC_URL`;

  const chainId = Number(resolveEnvValue(chainKey, String(config.defaultChainId)));
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`Invalid ${chainKey} for SPOKE_NETWORK=${network}: ${chainId}`);
  }

  const rpcUrl = resolveEnvValue(rpcKey, network === "base" ? defaultRpcUrl : "");
  if (!rpcUrl) {
    throw new Error(`Missing ${rpcKey} for SPOKE_NETWORK=${network}`);
  }

  return {
    network,
    chainId,
    rpcUrl,
    chainKey,
    rpcKey
  };
}

function normalizeSpokeNetwork(value) {
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "bnb") return "bsc";
  if (normalized in SPOKE_NETWORKS) return normalized;

  throw new Error(
    `Unsupported SPOKE_NETWORK=${value}. Use one of: ${Object.keys(SPOKE_NETWORKS).join(", ")}`
  );
}

async function hasBytecodeOnHub(address) {
  try {
    const chain = defineChain({
      id: Number(hubChainId),
      name: "Hub RPC",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [hubRpcUrl] } }
    });
    const client = createPublicClient({ chain, transport: http(hubRpcUrl) });
    const code = await client.getBytecode({ address });
    return Boolean(code && code !== "0x");
  } catch (error) {
    throw new Error(
      `Failed to check verifier bytecode on HUB_RPC_URL=${hubRpcUrl}: ${(error).message ?? String(error)}`
    );
  }
}

function isHexAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function loadDotEnv(filePath) {
  const values = {};
  if (!fs.existsSync(filePath)) return values;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
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
