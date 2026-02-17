#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const dotEnv = loadDotEnv(path.join(rootDir, ".env"));
const SPOKE_NETWORKS = {
  worldchain: { envPrefix: "WORLDCHAIN", label: "Worldchain", defaultChainId: 480 },
  ethereum: { envPrefix: "ETHEREUM", label: "Ethereum", defaultChainId: 1 },
  bsc: { envPrefix: "BSC", label: "BSC", defaultChainId: 56 }
};

const HUB_RPC_URL = resolveEnvValue("HUB_RPC_URL", "");
const HUB_RPC_SOURCE = resolveEnvSource("HUB_RPC_URL", "unset");
const HUB_CHAIN_ID = resolveEnvValue("HUB_CHAIN_ID", "8453");
const SPOKE = resolveSpokeConfig("");
const SPOKE_NETWORK = SPOKE.network;
const SPOKE_RPC_URL = SPOKE.rpcUrl;
const SPOKE_RPC_SOURCE = SPOKE.rpcSource;
const SPOKE_CHAIN_ID = String(SPOKE.chainId);
const SPOKE_RPC_KEY = SPOKE.rpcKey;
const SPOKE_CHAIN_KEY = SPOKE.chainKey;
const SPOKE_NETWORK_SOURCE = SPOKE.networkSource;
const VERIFIER_SOURCE =
  process.env.HUB_GROTH16_VERIFIER_SOURCE
  ?? dotEnv.HUB_GROTH16_VERIFIER_SOURCE
  ?? path.join(rootDir, "circuits", "prover", "artifacts", "Groth16Verifier.generated.sol");
const EXPLICIT_CONTRACT_NAME =
  process.env.HUB_GROTH16_VERIFIER_CONTRACT
  ?? dotEnv.HUB_GROTH16_VERIFIER_CONTRACT
  ?? "";
const PROVIDED_VERIFIER_ADDRESS =
  process.env.HUB_GROTH16_VERIFIER_ADDRESS
  ?? dotEnv.HUB_GROTH16_VERIFIER_ADDRESS
  ?? "";
const DEPLOYER_PRIVATE_KEY =
  process.env.DEPLOYER_PRIVATE_KEY
  ?? dotEnv.DEPLOYER_PRIVATE_KEY
  ?? process.env.PRIVATE_KEY
  ?? dotEnv.PRIVATE_KEY
  ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const USING_DEFAULT_DEPLOYER_KEY =
  !process.env.DEPLOYER_PRIVATE_KEY
  && !dotEnv.DEPLOYER_PRIVATE_KEY
  && !process.env.PRIVATE_KEY
  && !dotEnv.PRIVATE_KEY;
const BUILD_ARTIFACTS_SCRIPT = path.join(rootDir, "circuits", "prover", "build-artifacts.sh");
const DISABLE_FORGE_SYSTEM_PROXY =
  (process.env.DISABLE_FORGE_SYSTEM_PROXY
    ?? dotEnv.DISABLE_FORGE_SYSTEM_PROXY
    ?? "1") !== "0";
const ENABLE_FORGE_BROADCAST =
  (process.env.ENABLE_FORGE_BROADCAST
    ?? dotEnv.ENABLE_FORGE_BROADCAST
    ?? "1") !== "0";
const JSON_MODE = process.argv.includes("--json");

main().catch((error) => {
  console.error("[e2e-circuit:prepare] failed:", error.message);
  process.exit(1);
});

async function main() {
  warnIfProcessOverridesDotEnv("HUB_RPC_URL");
  warnIfProcessOverridesDotEnv("SPOKE_NETWORK");
  warnIfProcessOverridesDotEnv(SPOKE_RPC_KEY);
  warnIfProcessOverridesDotEnv(SPOKE_CHAIN_KEY);

  if (!HUB_RPC_URL) {
    throw new Error(
      "Missing HUB_RPC_URL. Set it in env or .env."
    );
  }
  if (!SPOKE_RPC_URL) {
    throw new Error(
      `Missing ${SPOKE_RPC_KEY} for SPOKE_NETWORK=${SPOKE_NETWORK}. Set it in env or .env.`
    );
  }
  info(`[e2e-circuit:prepare] HUB_RPC_URL source: ${HUB_RPC_SOURCE}`);
  info(`[e2e-circuit:prepare] SPOKE_NETWORK source: ${SPOKE_NETWORK_SOURCE}`);
  info(`[e2e-circuit:prepare] SPOKE_RPC_URL source: ${SPOKE_RPC_SOURCE}`);

  if (USING_DEFAULT_DEPLOYER_KEY && !isLocalRpc(HUB_RPC_URL)) {
    console.warn(
      "[e2e-circuit:prepare] DEPLOYER_PRIVATE_KEY is not set; using default local anvil key. " +
      "For Tenderly, set a funded DEPLOYER_PRIVATE_KEY in .env."
    );
  }

  let verifierAddress = PROVIDED_VERIFIER_ADDRESS;
  if (isHexAddress(verifierAddress)) {
    const hasCode = await addressHasCode(verifierAddress);
    if (!hasCode) {
      console.warn(
        `[e2e-circuit:prepare] HUB_GROTH16_VERIFIER_ADDRESS has no bytecode on selected HUB_RPC_URL; redeploying verifier.`
      );
      verifierAddress = await deployGeneratedVerifier();
    }
  } else {
    verifierAddress = await deployGeneratedVerifier();
  }

  if (!isHexAddress(verifierAddress)) {
    throw new Error("Unable to resolve HUB_GROTH16_VERIFIER_ADDRESS.");
  }

  const exports = {
    HUB_RPC_URL,
    HUB_CHAIN_ID,
    SPOKE_NETWORK,
    [SPOKE_RPC_KEY]: SPOKE_RPC_URL,
    [SPOKE_CHAIN_KEY]: SPOKE_CHAIN_ID,
    HUB_GROTH16_VERIFIER_ADDRESS: verifierAddress,
    HUB_VERIFIER_DEV_MODE: "0",
    E2E_PROVER_MODE: "circuit"
  };

  if (JSON_MODE) {
    process.stdout.write(`${JSON.stringify(exports)}\n`);
    return;
  }

  info("\n# Copy/paste these exports before running circuit E2E");
  for (const [key, value] of Object.entries(exports)) {
    info(`export ${key}=${shQuote(value)}`);
  }
  info("\n# Run circuit-mode E2E");
  info("pnpm test:e2e:fork:circuit");
}

async function deployGeneratedVerifier() {
  ensureVerifierSource();

  if (!fs.existsSync(VERIFIER_SOURCE)) {
    throw new Error(
      `No verifier address provided and generated verifier source not found at ${VERIFIER_SOURCE}.`
    );
  }

  const contractName = EXPLICIT_CONTRACT_NAME || detectVerifierContractName(VERIFIER_SOURCE);
  if (!contractName) {
    throw new Error(
      `Could not detect contract name in ${VERIFIER_SOURCE}. Set HUB_GROTH16_VERIFIER_CONTRACT.`
    );
  }

  info(
    `[e2e-circuit:prepare] deploying generated verifier (${contractName}) to ${HUB_RPC_URL}`
  );

  const target = `${VERIFIER_SOURCE}:${contractName}`;
  const forgeArgs = ["create", "--rpc-url", HUB_RPC_URL, "--private-key", DEPLOYER_PRIVATE_KEY];
  if (ENABLE_FORGE_BROADCAST) forgeArgs.push("--broadcast");
  forgeArgs.push(target);
  const result = spawnSync(
    "forge",
    forgeArgs,
    {
      cwd: rootDir,
      encoding: "utf8",
      stdio: "pipe",
      env: forgeChildEnv()
    }
  );

  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.error) {
    throw new Error(`forge create failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    if (combined.includes("Attempted to create a NULL object")) {
      console.warn(
        "[e2e-circuit:prepare] forge create hit known Foundry macOS panic; " +
        "falling back to viem deployment path."
      );
      return await deployVerifierWithViem(contractName);
    }
    throw new Error(`forge create failed (exit=${result.status}).\n${combined}`);
  }

  const match =
    combined.match(/Deployed to:\s*(0x[a-fA-F0-9]{40})/)
    ?? combined.match(/"deployedTo"\s*:\s*"(0x[a-fA-F0-9]{40})"/)
    ?? combined.match(/"contractAddress"\s*:\s*"(0x[a-fA-F0-9]{40})"/);

  if (!match) {
    if (combined.includes("Dry run enabled")) {
      throw new Error(
        "forge create ran in dry-run mode, so no contract was deployed.\n" +
        "Ensure --broadcast is enabled (default) or set ENABLE_FORGE_BROADCAST=1.\n" +
        `Raw output:\n${combined}`
      );
    }
    throw new Error(`Unable to parse deployed verifier address from forge output.\n${combined}`);
  }

  info(`[e2e-circuit:prepare] deployed verifier at ${match[1]}`);
  return match[1];
}

async function deployVerifierWithViem(contractName) {
  const contractsRoot = path.join(rootDir, "contracts");
  const generatedDir = path.join(contractsRoot, "src", "generated");
  const generatedSourceName = "Groth16Verifier.generated.sol";
  const generatedSourcePath = path.join(generatedDir, generatedSourceName);
  const artifactPath = path.join(contractsRoot, "out", generatedSourceName, `${contractName}.json`);

  fs.mkdirSync(generatedDir, { recursive: true });
  fs.copyFileSync(VERIFIER_SOURCE, generatedSourcePath);
  try {
    const build = spawnSync("forge", ["build"], {
      cwd: contractsRoot,
      encoding: "utf8",
      stdio: "pipe",
      env: forgeChildEnv()
    });

    if (build.error || build.status !== 0) {
      const combined = `${build.stdout ?? ""}\n${build.stderr ?? ""}`;
      throw new Error(`forge build for viem fallback failed.\n${combined}`);
    }

    if (!fs.existsSync(artifactPath)) {
      throw new Error(`Expected verifier artifact not found at ${artifactPath}`);
    }

    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    const bytecodeObject = artifact?.bytecode?.object;
    const abi = artifact?.abi;

    if (typeof bytecodeObject !== "string" || bytecodeObject.length === 0) {
      throw new Error(`Missing bytecode in ${artifactPath}`);
    }
    if (!Array.isArray(abi)) {
      throw new Error(`Missing ABI in ${artifactPath}`);
    }

    const bytecode = bytecodeObject.startsWith("0x") ? bytecodeObject : `0x${bytecodeObject}`;
    const account = privateKeyToAccount(DEPLOYER_PRIVATE_KEY);

    const baseChain = defineChain({
      id: Number(HUB_CHAIN_ID),
      name: "Hub RPC",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [HUB_RPC_URL] } }
    });

    const publicClient = createPublicClient({ chain: baseChain, transport: http(HUB_RPC_URL) });
    const walletClient = createWalletClient({ account, chain: baseChain, transport: http(HUB_RPC_URL) });

    info("[e2e-circuit:prepare] deploying verifier via viem fallback");
    const txHash = await walletClient.deployContract({
      abi,
      bytecode
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const deployed = receipt.contractAddress;
    if (!isHexAddress(deployed)) {
      throw new Error(`Viem fallback deploy did not return a contractAddress. tx=${txHash}`);
    }

    info(`[e2e-circuit:prepare] deployed verifier at ${deployed} (viem fallback)`);
    return deployed;
  } finally {
    try {
      if (fs.existsSync(generatedSourcePath)) {
        fs.rmSync(generatedSourcePath, { force: true });
      }
      if (fs.existsSync(generatedDir) && fs.readdirSync(generatedDir).length === 0) {
        fs.rmdirSync(generatedDir);
      }
    } catch {
      // Best-effort cleanup only.
    }
  }
}

function forgeChildEnv() {
  if (!DISABLE_FORGE_SYSTEM_PROXY) return process.env;
  return {
    ...process.env,
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    NO_PROXY: "*",
    http_proxy: "",
    https_proxy: "",
    all_proxy: "",
    no_proxy: "*"
  };
}

function ensureVerifierSource() {
  if (fs.existsSync(VERIFIER_SOURCE)) return;

  if (!fs.existsSync(BUILD_ARTIFACTS_SCRIPT)) {
    return;
  }

  info(
    `[e2e-circuit:prepare] verifier source missing, attempting to build artifacts via ${BUILD_ARTIFACTS_SCRIPT}`
  );
  const result = spawnSync("bash", [BUILD_ARTIFACTS_SCRIPT], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: "pipe"
  });
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.error || result.status !== 0) {
    throw new Error(
      `Failed to build circuit artifacts.\n` +
      `Install required tools first (circom + snarkjs), then re-run.\n` +
      `${combined}`
    );
  }
}

function detectVerifierContractName(sourcePath) {
  const source = fs.readFileSync(sourcePath, "utf8");
  const regex = /contract\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:is\s+[^{]+)?\{/g;
  const names = [];
  for (const match of source.matchAll(regex)) {
    names.push(match[1]);
  }
  if (names.length === 0) return "";
  if (names.includes("Groth16Verifier")) return "Groth16Verifier";
  if (names.includes("Verifier")) return "Verifier";
  return names[0];
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function isHexAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function isLocalRpc(url) {
  return url.includes("127.0.0.1") || url.includes("localhost");
}

function resolveEnvValue(key, fallback = "") {
  return process.env[key] ?? dotEnv[key] ?? fallback;
}

function resolveEnvSource(key, fallback = "unset") {
  if (process.env[key]) return `process.env.${key}`;
  if (dotEnv[key]) return `.env ${key}`;
  return fallback;
}

function resolveSpokeConfig(defaultRpcUrl = "") {
  const network = normalizeSpokeNetwork(resolveEnvValue("SPOKE_NETWORK", "worldchain"));
  const networkSource = resolveEnvSource("SPOKE_NETWORK", "default");
  const config = SPOKE_NETWORKS[network];
  const chainKey = `SPOKE_${config.envPrefix}_CHAIN_ID`;
  const rpcKey = `SPOKE_${config.envPrefix}_RPC_URL`;

  const chainId = Number(resolveEnvValue(chainKey, String(config.defaultChainId)));
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`Invalid ${chainKey} for SPOKE_NETWORK=${network}: ${chainId}`);
  }

  const rpcUrl = resolveEnvValue(rpcKey, network === "worldchain" ? defaultRpcUrl : "");
  if (!rpcUrl) {
    throw new Error(`Missing ${rpcKey} for SPOKE_NETWORK=${network}`);
  }

  return {
    network,
    networkSource,
    chainId,
    chainKey,
    rpcKey,
    rpcUrl,
    rpcSource: resolveEnvSource(rpcKey, "default")
  };
}

function normalizeSpokeNetwork(value) {
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "bnb") return "bsc";
  if (normalized === "eth") return "ethereum";
  if (normalized in SPOKE_NETWORKS) return normalized;

  throw new Error(
    `Unsupported SPOKE_NETWORK=${value}. Use one of: ${Object.keys(SPOKE_NETWORKS).join(", ")}`
  );
}

function info(message) {
  if (!JSON_MODE) {
    console.log(message);
  }
}

async function addressHasCode(address) {
  try {
    const hubChain = defineChain({
      id: Number(HUB_CHAIN_ID),
      name: "Hub RPC",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [HUB_RPC_URL] } }
    });
    const publicClient = createPublicClient({ chain: hubChain, transport: http(HUB_RPC_URL) });
    const code = await publicClient.getBytecode({ address });
    return Boolean(code && code !== "0x");
  } catch (error) {
    throw new Error(
      `Failed to check verifier bytecode at ${address} on ${HUB_RPC_URL}: ${(error).message ?? String(error)}`
    );
  }
}

function warnIfProcessOverridesDotEnv(key) {
  const processValue = process.env[key];
  const dotEnvValue = dotEnv[key];
  if (!processValue || !dotEnvValue || processValue === dotEnvValue) return;
  console.warn(
    `[e2e-circuit:prepare] ${key} from process env overrides .env value. ` +
    `Run 'unset ${key}' to use .env for this command.`
  );
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
