#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  encodeAbiParameters,
  formatEther,
  http,
  keccak256,
  parseAbi,
  parseAbiItem,
  parseEther,
  parseUnits
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const contractsDir = path.join(rootDir, "contracts");
const dotEnv = loadDotEnv(path.join(rootDir, ".env"));

const SPOKE_NETWORKS = {
  base: { envPrefix: "BASE", label: "Base", defaultChainId: 8453 },
  bsc: { envPrefix: "BSC", label: "BSC", defaultChainId: 56 }
};

const HUB_RPC_URL = resolveEnvValue("HUB_RPC_URL", "http://127.0.0.1:8545");
const HUB_ADMIN_RPC_URL = resolveEnvValue("HUB_ADMIN_RPC_URL", HUB_RPC_URL);
const HUB_CHAIN_ID = Number(resolveEnvValue("HUB_CHAIN_ID", "1"));
const SPOKE = resolveSpokeConfig("http://127.0.0.1:8546");
const SPOKE_NETWORK = SPOKE.network;
const SPOKE_LABEL = SPOKE.label;
const SPOKE_CHAIN_ID = SPOKE.chainId;
const SPOKE_RPC_URL = SPOKE.rpcUrl;
const SPOKE_ADMIN_RPC_URL = SPOKE.adminRpcUrl;
const SPOKE_CHAIN_KEY = SPOKE.chainKey;
const SPOKE_RPC_KEY = SPOKE.rpcKey;
const SPOKE_ADMIN_RPC_KEY = SPOKE.adminRpcKey;
const INTERNAL_API_AUTH_SECRET =
  process.env.INTERNAL_API_AUTH_SECRET
  ?? dotEnv.INTERNAL_API_AUTH_SECRET
  ?? "dev-internal-auth-secret";
const E2E_INTERNAL_CALLER_SERVICE = process.env.E2E_INTERNAL_CALLER_SERVICE ?? "e2e";

const INDEXER_PORT = Number(process.env.E2E_INDEXER_PORT ?? "4030");
const RELAYER_PORT = Number(process.env.E2E_RELAYER_PORT ?? "4040");
const PROVER_PORT = Number(process.env.E2E_PROVER_PORT ?? "4050");
const E2E_PROVER_MODE = process.env.E2E_PROVER_MODE ?? process.env.PROVER_MODE ?? "dev";
const E2E_SUPPLY_ONLY = (process.env.E2E_SUPPLY_ONLY ?? "0") !== "0";
const PROVER_MIN_NATIVE_ETH = process.env.PROVER_MIN_NATIVE_ETH ?? "0.05";
const INDEXER_API_URL = `http://127.0.0.1:${INDEXER_PORT}`;
const RELAYER_API_URL = `http://127.0.0.1:${RELAYER_PORT}`;
const PROVER_API_URL = `http://127.0.0.1:${PROVER_PORT}`;

const DEFAULT_DEPLOYER_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const USER_PRIVATE_KEY = process.env.USER_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY ?? DEFAULT_DEPLOYER_PRIVATE_KEY;
const E2E_USE_TENDERLY_FUNDING = (process.env.E2E_USE_TENDERLY_FUNDING ?? "1") !== "0";

const supplyAmount = parseUnits("250", 6);
const borrowAmount = parseUnits("25", 6);
const MockAcrossSpokePoolAbi = parseAbi([
  "function relayV3Deposit(uint256 originChainId,bytes32 originTxHash,uint256 originLogIndex,address outputToken,uint256 outputAmount,address recipient,bytes message)"
]);
const AcrossFundsDepositedEvent = parseAbiItem(
  "event V3FundsDeposited(uint256 indexed depositId, address indexed depositor, address indexed recipient, address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, address exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes message, address caller)"
);

const intentTypes = {
  Intent: [
    { name: "intentType", type: "uint8" },
    { name: "user", type: "address" },
    { name: "inputChainId", type: "uint256" },
    { name: "outputChainId", type: "uint256" },
    { name: "inputToken", type: "address" },
    { name: "outputToken", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "recipient", type: "address" },
    { name: "maxRelayerFee", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" }
  ]
};

const children = [];
let isStopping = false;

main().catch(async (error) => {
  console.error("[e2e] failed:", error);
  await stopAll();
  process.exit(1);
});

async function main() {
  const dataDir = path.join(rootDir, ".tmp", "e2e-fork", String(Date.now()));
  fs.mkdirSync(dataDir, { recursive: true });

  assertWorkspaceLinks();
  await ensureDeployerGasBeforeDeploy();

  console.log("[e2e] building contracts");
  await run("forge", ["build"], { cwd: contractsDir });

  console.log("[e2e] generating + building shared ABIs package");
  await run("pnpm", ["abis:generate"], { cwd: rootDir });
  await run("pnpm", ["--filter", "@elhub/abis", "build"], { cwd: rootDir });

  console.log("[e2e] deploying protocol to fork endpoints");
  await run("node", ["./contracts/script/deploy-local.mjs"], {
    cwd: rootDir,
    env: {
      ...process.env,
      HUB_RPC_URL,
      HUB_CHAIN_ID: String(HUB_CHAIN_ID),
      SPOKE_NETWORK,
      [SPOKE_RPC_KEY]: SPOKE_RPC_URL,
      [SPOKE_CHAIN_KEY]: String(SPOKE_CHAIN_ID),
      INTERNAL_API_AUTH_SECRET
    }
  });

  const deployments = readJson(path.join(rootDir, "contracts", "deployments", "local.json"));
  const localEnv = parseEnvFile(path.join(rootDir, "contracts", "deployments", "local.env"));
  await ensureOperatorGas(localEnv);
  await logOperatorBalances(localEnv);

  const relayerPrivateKey = (localEnv.RELAYER_PRIVATE_KEY ?? process.env.RELAYER_PRIVATE_KEY ?? "").trim();
  const bridgePrivateKey = (
    localEnv.BRIDGE_PRIVATE_KEY
    ?? process.env.BRIDGE_PRIVATE_KEY
    ?? relayerPrivateKey
  ).trim();
  const proverPrivateKey = (
    localEnv.PROVER_PRIVATE_KEY
    ?? process.env.PROVER_PRIVATE_KEY
    ?? relayerPrivateKey
  ).trim();
  const deployerPrivateKey = (process.env.DEPLOYER_PRIVATE_KEY ?? DEFAULT_DEPLOYER_PRIVATE_KEY).trim();

  if (!relayerPrivateKey || !bridgePrivateKey || !proverPrivateKey) {
    throw new Error("Missing RELAYER/BRIDGE/PROVER private keys after deployment env load.");
  }

  const serviceEnv = {
    ...process.env,
    ...localEnv,
    HUB_RPC_URL,
    SPOKE_RPC_URL,
    HUB_CHAIN_ID: String(HUB_CHAIN_ID),
    SPOKE_CHAIN_ID: String(SPOKE_CHAIN_ID),
    SPOKE_NETWORK,
    [SPOKE_RPC_KEY]: SPOKE_RPC_URL,
    [SPOKE_CHAIN_KEY]: String(SPOKE_CHAIN_ID),
    [SPOKE_ADMIN_RPC_KEY]: SPOKE_ADMIN_RPC_URL,
    INTERNAL_API_AUTH_SECRET,
    RELAYER_PRIVATE_KEY: relayerPrivateKey,
    BRIDGE_PRIVATE_KEY: bridgePrivateKey,
    PROVER_PRIVATE_KEY: proverPrivateKey,
    DEPLOYER_PRIVATE_KEY: deployerPrivateKey,
    PROVER_FUNDER_PRIVATE_KEY: deployerPrivateKey,
    PROVER_MIN_NATIVE_ETH,
    INDEXER_PORT: String(INDEXER_PORT),
    RELAYER_PORT: String(RELAYER_PORT),
    PROVER_PORT: String(PROVER_PORT),
    INDEXER_API_URL,
    PROVER_API_URL,
    CORS_ALLOW_ORIGIN: "*",
    PROVER_MODE: E2E_PROVER_MODE,
    INDEXER_DB_PATH: path.join(dataDir, "indexer.json"),
    PROVER_QUEUE_PATH: path.join(dataDir, "prover-queue.json"),
    PROVER_STATE_PATH: path.join(dataDir, "prover-state.json"),
    RELAYER_TRACKING_PATH: path.join(dataDir, "relayer-tracking.json"),
    RELAYER_INITIAL_BACKFILL_BLOCKS: "20",
    RELAYER_MAX_LOG_RANGE: "200"
  };

  console.log("[e2e] starting indexer/prover/relayer");
  children.push(startService("indexer", ["--filter", "@elhub/indexer", "dev"], serviceEnv));
  children.push(startService("prover", ["--filter", "@elhub/prover", "dev"], serviceEnv));
  children.push(startService("relayer", ["--filter", "@elhub/relayer", "dev"], serviceEnv));

  await waitForHealth(`${INDEXER_API_URL}/health`);
  await waitForHealth(`${PROVER_API_URL}/health`);
  await waitForHealth(`${RELAYER_API_URL}/health`);

  const userAccount = privateKeyToAccount(USER_PRIVATE_KEY);
  const hubChain = defineChain({
    id: HUB_CHAIN_ID,
    name: "Ethereum Fork",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [HUB_RPC_URL] } }
  });
  const spokeChain = defineChain({
    id: SPOKE_CHAIN_ID,
    name: `${SPOKE_LABEL} Fork`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [SPOKE_RPC_URL] } }
  });

  const hubPublic = createPublicClient({ chain: hubChain, transport: http(HUB_RPC_URL) });
  const spokePublic = createPublicClient({ chain: spokeChain, transport: http(SPOKE_RPC_URL) });
  const hubWallet = createWalletClient({ account: userAccount, chain: hubChain, transport: http(HUB_RPC_URL) });
  const spokeWallet = createWalletClient({ account: userAccount, chain: spokeChain, transport: http(SPOKE_RPC_URL) });

  const MockERC20Abi = readJson(path.join(rootDir, "packages", "abis", "src", "generated", "MockERC20.json"));
  const SpokePortalAbi = readJson(path.join(rootDir, "packages", "abis", "src", "generated", "SpokePortal.json"));
  const HubMoneyMarketAbi = readJson(path.join(rootDir, "packages", "abis", "src", "generated", "HubMoneyMarket.json"));

  const usdcSpoke = deployments.tokens.USDC.spoke;
  const usdcHub = deployments.tokens.USDC.hub;
  const portal = deployments.spoke.portal;
  const market = deployments.hub.moneyMarket;
  const inbox = deployments.hub.intentInbox;

  console.log("[e2e] supply flow: mint + approve + initiateSupply");
  await writeAndWait(spokeWallet, spokePublic, {
    abi: MockERC20Abi,
    address: usdcSpoke,
    functionName: "mint",
    args: [userAccount.address, supplyAmount]
  });

  const nextDepositId = await spokePublic.readContract({
    abi: SpokePortalAbi,
    address: portal,
    functionName: "nextDepositId"
  });

  await writeAndWait(spokeWallet, spokePublic, {
    abi: MockERC20Abi,
    address: usdcSpoke,
    functionName: "approve",
    args: [portal, supplyAmount]
  });

  const supplyTxHash = await writeAndWait(spokeWallet, spokePublic, {
    abi: SpokePortalAbi,
    address: portal,
    functionName: "initiateSupply",
    args: [usdcSpoke, supplyAmount, userAccount.address]
  });

  await simulateAcrossRelay({
    spokePublic,
    hubPublic,
    hubWallet,
    sourceAcrossSpokePool: deployments.spoke.acrossSpokePool,
    hubAcrossSpokePool: deployments.hub.hubAcrossSpokePool,
    sourceChainId: BigInt(SPOKE_CHAIN_ID),
    sourceTxHash: supplyTxHash
  });

  const depositId = Number(nextDepositId) + 1;
  await waitUntil(
    async () => {
      const res = await fetch(`${INDEXER_API_URL}/deposits/${depositId}`);
      if (!res.ok) return false;
      const payload = await res.json();
      return payload.status === "pending_fill" || payload.status === "bridged" || payload.status === "settled";
    },
    "deposit pending fill",
    120_000
  );

  await waitUntil(
    async () => {
      const res = await fetch(`${INDEXER_API_URL}/deposits/${depositId}`);
      if (!res.ok) return false;
      const payload = await res.json();
      return payload.status === "bridged" || payload.status === "settled";
    },
    "deposit proof finalization",
    120_000
  );

  await postInternal(PROVER_API_URL, "/internal/flush", {}, INTERNAL_API_AUTH_SECRET);

  await waitUntil(
    async () => {
      const res = await fetch(`${INDEXER_API_URL}/deposits/${depositId}`);
      if (!res.ok) return false;
      const payload = await res.json();
      return payload.status === "settled";
    },
    "deposit settlement",
    120_000
  );

  const userSupply = await hubPublic.readContract({
    abi: HubMoneyMarketAbi,
    address: market,
    functionName: "getUserSupply",
    args: [userAccount.address, usdcHub]
  });
  if (userSupply <= 0n) {
    throw new Error("expected non-zero hub supply after settlement");
  }

  if (E2E_SUPPLY_ONLY) {
    console.log("[e2e] ==================================================");
    console.log("[e2e] PASS: base->hub supply lifecycle settled");
    console.log("[e2e] checks: pending_fill observed, bridged observed, settlement credited on hub");
    console.log("[e2e] ==================================================");
    await stopAll();
    return;
  }

  console.log("[e2e] borrow flow: quote + sign intent + relayer submit");
  const quoteRes = await fetch(
    `${RELAYER_API_URL}/quote?intentType=3&amount=${borrowAmount.toString()}`
  );
  if (!quoteRes.ok) {
    throw new Error(`quote failed: ${quoteRes.status} ${await quoteRes.text()}`);
  }
  const quote = await quoteRes.json();
  const relayerFee = BigInt(quote.fee);

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const intent = {
    intentType: 3,
    user: userAccount.address,
    inputChainId: BigInt(SPOKE_CHAIN_ID),
    outputChainId: BigInt(SPOKE_CHAIN_ID),
    inputToken: usdcSpoke,
    outputToken: usdcSpoke,
    amount: borrowAmount,
    recipient: userAccount.address,
    maxRelayerFee: relayerFee,
    nonce: BigInt(Date.now()),
    deadline: nowSec + 1800n
  };

  const signature = await userAccount.signTypedData({
    domain: {
      name: "ElHubIntentInbox",
      version: "1",
      chainId: HUB_CHAIN_ID,
      verifyingContract: inbox
    },
    types: intentTypes,
    primaryType: "Intent",
    message: intent
  });

  const intentId = rawIntentId(intent);
  const submitRes = await fetch(`${RELAYER_API_URL}/intent/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      intent: {
        ...intent,
        inputChainId: intent.inputChainId.toString(),
        outputChainId: intent.outputChainId.toString(),
        amount: intent.amount.toString(),
        maxRelayerFee: intent.maxRelayerFee.toString(),
        nonce: intent.nonce.toString(),
        deadline: intent.deadline.toString()
      },
      signature,
      relayerFee: relayerFee.toString()
    })
  });
  if (!submitRes.ok) {
    throw new Error(`intent submit failed: ${submitRes.status} ${await submitRes.text()}`);
  }

  await postInternal(PROVER_API_URL, "/internal/flush", {}, INTERNAL_API_AUTH_SECRET);

  await waitUntil(
    async () => {
      const res = await fetch(`${INDEXER_API_URL}/intents/${intentId}`);
      if (!res.ok) return false;
      const payload = await res.json();
      return payload.status === "settled";
    },
    "borrow settlement",
    120_000
  );

  const userDebt = await hubPublic.readContract({
    abi: HubMoneyMarketAbi,
    address: market,
    functionName: "getUserDebt",
    args: [userAccount.address, usdcHub]
  });
  if (userDebt <= 0n) {
    throw new Error("expected non-zero hub debt after borrow settlement");
  }

  console.log("[e2e] ==================================================");
  console.log("[e2e] PASS: supply + borrow cross-chain lifecycle settled");
  console.log("[e2e] checks: deposit settled on hub, borrow settled on hub");
  console.log("[e2e] ==================================================");
  await stopAll();
}

function assertWorkspaceLinks() {
  const required = [
    path.join(rootDir, "services", "prover", "node_modules", "@elhub", "abis", "package.json"),
    path.join(rootDir, "services", "relayer", "node_modules", "@elhub", "abis", "package.json"),
    path.join(rootDir, "services", "relayer", "node_modules", "@elhub", "sdk", "package.json"),
    path.join(rootDir, "services", "indexer", "node_modules", "@elhub", "sdk", "package.json")
  ];

  const missing = required.filter((entry) => !fs.existsSync(entry));
  if (missing.length === 0) return;

  throw new Error(
    "Workspace package links are missing after package scope rename.\n" +
    "Run `pnpm install` at repository root, then re-run this E2E command.\n" +
    `Missing paths:\n- ${missing.join("\n- ")}`
  );
}

function parseEnvFile(filePath) {
  const map = {};
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    map[key] = value;
  }
  return map;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function startService(name, args, env) {
  const child = spawn("pnpm", args, {
    cwd: rootDir,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (buf) => {
    if (isStopping) return;
    process.stdout.write(`[${name}] ${buf}`);
  });
  child.stderr.on("data", (buf) => {
    if (isStopping) return;
    process.stderr.write(`[${name}] ${buf}`);
  });
  child.on("exit", (code, signal) => {
    if (isStopping) return;
    if (code !== 0 && signal !== "SIGTERM") {
      console.error(`[${name}] exited unexpectedly (code=${code}, signal=${signal ?? "none"})`);
    }
  });
  return child;
}

async function stopAll() {
  isStopping = true;
  const waiters = [];
  for (const child of children) {
    if (!child || child.killed) continue;
    child.kill("SIGTERM");
    waiters.push(
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve(undefined);
        }, 5_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve(undefined);
        });
      })
    );
  }
  await Promise.all(waiters);
}

async function waitForHealth(url, timeoutMs = 60_000) {
  await waitUntil(
    async () => {
      const res = await fetch(url).catch(() => null);
      return Boolean(res?.ok);
    },
    `health check ${url}`,
    timeoutMs
  );
}

async function waitUntil(fn, label, timeoutMs, intervalMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(intervalMs);
  }
  throw new Error(`timed out while waiting for ${label}`);
}

async function writeAndWait(walletClient, publicClient, request) {
  const hash = await walletClient.writeContract({
    ...request,
    account: walletClient.account
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

async function simulateAcrossRelay({
  spokePublic,
  hubPublic,
  hubWallet,
  sourceAcrossSpokePool,
  hubAcrossSpokePool,
  sourceChainId,
  sourceTxHash
}) {
  const receipt = await spokePublic.getTransactionReceipt({ hash: sourceTxHash });
  let relayArgs;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== sourceAcrossSpokePool.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: [AcrossFundsDepositedEvent],
        eventName: "V3FundsDeposited",
        data: log.data,
        topics: log.topics
      });
      relayArgs = {
        originLogIndex: log.logIndex,
        outputToken: decoded.args.outputToken,
        outputAmount: decoded.args.outputAmount,
        destinationChainId: decoded.args.destinationChainId,
        recipient: decoded.args.recipient,
        message: decoded.args.message
      };
      break;
    } catch {
      // ignore non-matching logs
    }
  }

  if (!relayArgs) {
    throw new Error("missing V3FundsDeposited log for supply tx");
  }
  if (relayArgs.destinationChainId !== BigInt(HUB_CHAIN_ID)) {
    throw new Error(
      `unexpected destination chain in deposit log. expected=${HUB_CHAIN_ID} got=${relayArgs.destinationChainId.toString()}`
    );
  }

  await writeAndWait(hubWallet, hubPublic, {
    abi: MockAcrossSpokePoolAbi,
    address: hubAcrossSpokePool,
    functionName: "relayV3Deposit",
    args: [
      sourceChainId,
      sourceTxHash,
      relayArgs.originLogIndex,
      relayArgs.outputToken,
      relayArgs.outputAmount,
      relayArgs.recipient,
      relayArgs.message
    ]
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

async function ensureOperatorGas(localEnv) {
  const minOperatorGas = parseEther(process.env.E2E_MIN_OPERATOR_GAS_ETH ?? "0.05");
  const minProverGas = resolveMinProverGas(minOperatorGas);
  const deployerKey = process.env.DEPLOYER_PRIVATE_KEY ?? DEFAULT_DEPLOYER_PRIVATE_KEY;
  const deployer = privateKeyToAccount(deployerKey);

  const relayerKey = localEnv.RELAYER_PRIVATE_KEY ?? process.env.RELAYER_PRIVATE_KEY;
  const bridgeKey = localEnv.BRIDGE_PRIVATE_KEY ?? process.env.BRIDGE_PRIVATE_KEY ?? relayerKey;
  const proverKey = localEnv.PROVER_PRIVATE_KEY ?? process.env.PROVER_PRIVATE_KEY ?? relayerKey;

  if (!relayerKey || !bridgeKey || !proverKey) {
    throw new Error("Missing RELAYER/BRIDGE/PROVER private keys for E2E operator gas funding.");
  }

  const relayer = privateKeyToAccount(relayerKey);
  const bridge = privateKeyToAccount(bridgeKey);
  const prover = privateKeyToAccount(proverKey);

  const hubChain = defineChain({
    id: HUB_CHAIN_ID,
    name: "Hub",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [HUB_RPC_URL] } }
  });
  const spokeChain = defineChain({
    id: SPOKE_CHAIN_ID,
    name: "Spoke",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [SPOKE_RPC_URL] } }
  });

  const hubPublic = createPublicClient({ chain: hubChain, transport: http(HUB_RPC_URL) });
  const spokePublic = createPublicClient({ chain: spokeChain, transport: http(SPOKE_RPC_URL) });
  const hubDeployer = createWalletClient({ account: deployer, chain: hubChain, transport: http(HUB_RPC_URL) });
  const spokeDeployer = createWalletClient({ account: deployer, chain: spokeChain, transport: http(SPOKE_RPC_URL) });

  console.log(
    `[e2e] operator gas targets: default=${formatEther(minOperatorGas)} ETH prover=${formatEther(minProverGas)} ETH`
  );

  await ensureNativeBalance(hubDeployer, hubPublic, relayer.address, minOperatorGas, "hub relayer", HUB_ADMIN_RPC_URL);
  await ensureNativeBalance(hubDeployer, hubPublic, bridge.address, minOperatorGas, "hub bridge", HUB_ADMIN_RPC_URL);
  await ensureNativeBalance(hubDeployer, hubPublic, prover.address, minProverGas, "hub prover", HUB_ADMIN_RPC_URL);
  await ensureNativeBalance(spokeDeployer, spokePublic, relayer.address, minOperatorGas, "spoke relayer", SPOKE_ADMIN_RPC_URL);
  await ensureNativeBalance(spokeDeployer, spokePublic, bridge.address, minOperatorGas, "spoke bridge", SPOKE_ADMIN_RPC_URL);
  await ensureNativeBalance(spokeDeployer, spokePublic, prover.address, minProverGas, "spoke prover", SPOKE_ADMIN_RPC_URL);
}

function resolveMinProverGas(minOperatorGas) {
  const proverRuntimeMin = parseEther(PROVER_MIN_NATIVE_ETH);
  const proverBuffer = parseEther(process.env.E2E_PROVER_GAS_BUFFER_ETH ?? "0.01");
  const explicitProverMin = parseEther(process.env.E2E_MIN_PROVER_GAS_ETH ?? "0.1");
  const runtimeWithBuffer = proverRuntimeMin + proverBuffer;
  return maxBigInt(explicitProverMin, maxBigInt(minOperatorGas, runtimeWithBuffer));
}

function maxBigInt(a, b) {
  return a > b ? a : b;
}

async function logOperatorBalances(localEnv) {
  const deployerKey = (process.env.DEPLOYER_PRIVATE_KEY ?? DEFAULT_DEPLOYER_PRIVATE_KEY).trim();
  const relayerKey = (localEnv.RELAYER_PRIVATE_KEY ?? process.env.RELAYER_PRIVATE_KEY ?? "").trim();
  const bridgeKey = (localEnv.BRIDGE_PRIVATE_KEY ?? process.env.BRIDGE_PRIVATE_KEY ?? relayerKey).trim();
  const proverKey = (localEnv.PROVER_PRIVATE_KEY ?? process.env.PROVER_PRIVATE_KEY ?? relayerKey).trim();

  if (!relayerKey || !bridgeKey || !proverKey) return;

  const deployer = privateKeyToAccount(deployerKey);
  const relayer = privateKeyToAccount(relayerKey);
  const bridge = privateKeyToAccount(bridgeKey);
  const prover = privateKeyToAccount(proverKey);

  const hubChain = defineChain({
    id: HUB_CHAIN_ID,
    name: "Hub",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [HUB_RPC_URL] } }
  });
  const spokeChain = defineChain({
    id: SPOKE_CHAIN_ID,
    name: "Spoke",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [SPOKE_RPC_URL] } }
  });

  const hubPublic = createPublicClient({ chain: hubChain, transport: http(HUB_RPC_URL) });
  const spokePublic = createPublicClient({ chain: spokeChain, transport: http(SPOKE_RPC_URL) });
  const actors = [
    ["deployer", deployer.address],
    ["relayer", relayer.address],
    ["bridge", bridge.address],
    ["prover", prover.address]
  ];

  const rows = [];
  for (const [name, address] of actors) {
    const [hubBalance, spokeBalance] = await Promise.all([
      hubPublic.getBalance({ address }),
      spokePublic.getBalance({ address })
    ]);
    rows.push({
      actor: name,
      address,
      hubEth: formatEther(hubBalance),
      spokeEth: formatEther(spokeBalance)
    });
  }
  console.log(
    `[e2e] operator balances ${JSON.stringify({
      hubRpc: HUB_RPC_URL,
      spokeRpc: SPOKE_RPC_URL,
      rows
    })}`
  );
}

async function ensureNativeBalance(walletClient, publicClient, target, minBalanceWei, label, adminRpcUrl) {
  const current = await publicClient.getBalance({ address: target });
  if (current >= minBalanceWei) return;

  if (E2E_USE_TENDERLY_FUNDING && isTenderlyRpc(adminRpcUrl)) {
    await tenderlySetBalance(adminRpcUrl, target, minBalanceWei);
    const updated = await publicClient.getBalance({ address: target });
    if (updated >= minBalanceWei) return;
    throw new Error(
      `tenderly_setBalance did not fund ${label} to required minimum. ` +
      `expected>=${formatEther(minBalanceWei)} got=${formatEther(updated)}`
    );
  }

  if (target.toLowerCase() === walletClient.account.address.toLowerCase()) {
    throw new Error(
      `insufficient balance for ${label} and no Tenderly funding available. ` +
      `required=${formatEther(minBalanceWei)} current=${formatEther(current)}`
    );
  }

  const topUp = minBalanceWei - current;
  const senderBalance = await publicClient.getBalance({ address: walletClient.account.address });
  if (senderBalance <= topUp) {
    throw new Error(
      `insufficient deployer balance to fund ${label}. ` +
      `needed=${formatEther(topUp)} sender=${formatEther(senderBalance)}`
    );
  }

  const txHash = await walletClient.sendTransaction({
    to: target,
    value: topUp,
    account: walletClient.account
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });
}

async function ensureDeployerGasBeforeDeploy() {
  if (!E2E_USE_TENDERLY_FUNDING) return;
  if (!isTenderlyRpc(HUB_ADMIN_RPC_URL) && !isTenderlyRpc(SPOKE_ADMIN_RPC_URL)) return;

  const minDeployerGas = parseEther(process.env.E2E_MIN_DEPLOYER_GAS_ETH ?? "2");
  const deployerKey = process.env.DEPLOYER_PRIVATE_KEY ?? DEFAULT_DEPLOYER_PRIVATE_KEY;
  const deployer = privateKeyToAccount(deployerKey);

  const hubChain = defineChain({
    id: HUB_CHAIN_ID,
    name: "Hub",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [HUB_RPC_URL] } }
  });
  const spokeChain = defineChain({
    id: SPOKE_CHAIN_ID,
    name: "Spoke",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [SPOKE_RPC_URL] } }
  });
  const hubPublic = createPublicClient({ chain: hubChain, transport: http(HUB_RPC_URL) });
  const spokePublic = createPublicClient({ chain: spokeChain, transport: http(SPOKE_RPC_URL) });

  await ensureBalanceViaTenderlyIfNeeded(
    hubPublic,
    HUB_ADMIN_RPC_URL,
    deployer.address,
    minDeployerGas,
    "hub deployer"
  );
  await ensureBalanceViaTenderlyIfNeeded(
    spokePublic,
    SPOKE_ADMIN_RPC_URL,
    deployer.address,
    minDeployerGas,
    "spoke deployer"
  );
}

async function ensureBalanceViaTenderlyIfNeeded(publicClient, adminRpcUrl, address, minBalanceWei, label) {
  const current = await publicClient.getBalance({ address });
  if (current >= minBalanceWei) return;
  if (!isTenderlyRpc(adminRpcUrl)) {
    throw new Error(
      `${label} below required balance (${formatEther(current)} < ${formatEther(minBalanceWei)}) ` +
      `and no Tenderly Admin RPC configured.`
    );
  }
  await tenderlySetBalance(adminRpcUrl, address, minBalanceWei);
  const updated = await publicClient.getBalance({ address });
  if (updated < minBalanceWei) {
    throw new Error(
      `tenderly_setBalance failed for ${label}: expected>=${formatEther(minBalanceWei)} got=${formatEther(updated)}`
    );
  }
}

async function tenderlySetBalance(adminRpcUrl, address, amountWei) {
  const payload = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tenderly_setBalance",
    params: [[address], toQuantityHex(amountWei)]
  };

  const res = await fetch(adminRpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    throw new Error(`tenderly_setBalance HTTP ${res.status}: ${await res.text()}`);
  }

  const json = await res.json();
  if (json?.error) {
    const code = json.error.code ?? "unknown";
    const message = json.error.message ?? "unknown error";
    throw new Error(`tenderly_setBalance RPC error (${code}): ${message}`);
  }
}

function toQuantityHex(value) {
  const hex = value.toString(16);
  return `0x${hex.length === 0 ? "0" : hex}`;
}

function isTenderlyRpc(url) {
  return typeof url === "string" && url.includes("tenderly.co");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rawIntentId(intent) {
  return keccak256(
    encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "intentType", type: "uint8" },
            { name: "user", type: "address" },
            { name: "inputChainId", type: "uint256" },
            { name: "outputChainId", type: "uint256" },
            { name: "inputToken", type: "address" },
            { name: "outputToken", type: "address" },
            { name: "amount", type: "uint256" },
            { name: "recipient", type: "address" },
            { name: "maxRelayerFee", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" }
          ]
        }
      ],
      [intent]
    )
  );
}

async function postInternal(baseUrl, routePath, body, secret) {
  const rawBody = JSON.stringify(body);
  const timestamp = Date.now().toString();
  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  const payload = `POST\n${routePath}\n${timestamp}\n${E2E_INTERNAL_CALLER_SERVICE}\n${bodyHash}`;
  const signature = createHmac("sha256", secret).update(payload).digest("hex");

  const res = await fetch(new URL(routePath, baseUrl).toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-elhub-internal-ts": timestamp,
      "x-elhub-internal-sig": signature,
      "x-elhub-internal-service": E2E_INTERNAL_CALLER_SERVICE
    },
    body: rawBody
  });
  if (!res.ok) {
    throw new Error(`internal call ${routePath} failed: ${res.status} ${await res.text()}`);
  }
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

function resolveEnvValue(key, fallback = "") {
  return process.env[key] ?? dotEnv[key] ?? fallback;
}

function resolveSpokeConfig(defaultRpcUrl = "") {
  const network = normalizeSpokeNetwork(resolveEnvValue("SPOKE_NETWORK", "base"));
  const config = SPOKE_NETWORKS[network];
  const chainKey = `SPOKE_${config.envPrefix}_CHAIN_ID`;
  const rpcKey = `SPOKE_${config.envPrefix}_RPC_URL`;
  const adminRpcKey = `SPOKE_${config.envPrefix}_ADMIN_RPC_URL`;

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
    label: config.label,
    chainId,
    rpcUrl,
    adminRpcUrl: resolveEnvValue(adminRpcKey, rpcUrl),
    chainKey,
    rpcKey,
    adminRpcKey
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
