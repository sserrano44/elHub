#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  stringToHex,
  encodeFunctionData,
  isAddress,
  parseAbi,
  formatEther,
  parseEther
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");
const contractsDir = path.resolve(rootDir, "contracts");
const outDir = path.resolve(contractsDir, "out");
const deploymentsDir = path.resolve(contractsDir, "deployments");

const NETWORK_CATALOG = {
  ethereum: { label: "Ethereum", chainId: 1, envPrefix: "ETHEREUM", nativeSymbol: "ETH" },
  base: { label: "Base", chainId: 8453, envPrefix: "BASE", nativeSymbol: "ETH" },
  bsc: { label: "BSC", chainId: 56, envPrefix: "BSC", nativeSymbol: "BNB" },
  worldchain: { label: "Worldchain", chainId: 480, envPrefix: "WORLDCHAIN", nativeSymbol: "ETH" }
};

const LIVE_MODE = (process.env.LIVE_MODE ?? "1") !== "0";
const HUB_NETWORK = normalizeNetwork(process.env.HUB_NETWORK ?? "base");
const HUB_DEFAULTS = NETWORK_CATALOG[HUB_NETWORK];
const HUB_CHAIN_ID = Number(process.env.HUB_CHAIN_ID ?? process.env[`${HUB_DEFAULTS.envPrefix}_CHAIN_ID`] ?? HUB_DEFAULTS.chainId);
const HUB_RPC_URL = resolveRpcEnv(HUB_DEFAULTS);

const SPOKE_NETWORKS = (process.env.SPOKE_NETWORKS ?? "worldchain,bsc")
  .split(",")
  .map((n) => normalizeNetwork(n))
  .filter((n, idx, arr) => n !== HUB_NETWORK && arr.indexOf(n) === idx);

if (!HUB_RPC_URL) {
  throw new Error(`Missing ${HUB_DEFAULTS.envPrefix}_RPC_URL for HUB_NETWORK=${HUB_NETWORK}`);
}
if (!Number.isInteger(HUB_CHAIN_ID) || HUB_CHAIN_ID <= 0) {
  throw new Error(`Invalid HUB_CHAIN_ID: ${HUB_CHAIN_ID}`);
}
if (SPOKE_NETWORKS.length === 0) {
  throw new Error("No spoke networks configured. Set SPOKE_NETWORKS, e.g. worldchain,bsc.");
}
if (LIVE_MODE && isTenderlyRpc(HUB_RPC_URL)) {
  throw new Error("LIVE_MODE forbids Tenderly RPC for hub");
}

const runtimeEnv = (process.env.ZKHUB_ENV ?? process.env.NODE_ENV ?? "production").toLowerCase();
const isProduction = runtimeEnv === "production";
const HUB_VERIFIER_DEV_MODE = (process.env.HUB_VERIFIER_DEV_MODE ?? "0") !== "0";
const HUB_GROTH16_VERIFIER_ADDRESS = process.env.HUB_GROTH16_VERIFIER_ADDRESS ?? "";

if (LIVE_MODE && HUB_VERIFIER_DEV_MODE) {
  throw new Error("LIVE_MODE requires HUB_VERIFIER_DEV_MODE=0");
}
if (!HUB_GROTH16_VERIFIER_ADDRESS || !isAddress(HUB_GROTH16_VERIFIER_ADDRESS)) {
  throw new Error("Set HUB_GROTH16_VERIFIER_ADDRESS for live deployment");
}

const EXTERNAL_LIGHT_CLIENT_VERIFIER = process.env.HUB_LIGHT_CLIENT_VERIFIER_ADDRESS ?? "";
const EXTERNAL_ACROSS_DEPOSIT_EVENT_VERIFIER = process.env.HUB_ACROSS_DEPOSIT_EVENT_VERIFIER_ADDRESS ?? "";
const EXTERNAL_ACROSS_BORROW_FILL_EVENT_VERIFIER = process.env.HUB_ACROSS_BORROW_FILL_EVENT_VERIFIER_ADDRESS ?? "";

if (!isAddress(EXTERNAL_LIGHT_CLIENT_VERIFIER)) {
  throw new Error("Set HUB_LIGHT_CLIENT_VERIFIER_ADDRESS");
}
if (!isAddress(EXTERNAL_ACROSS_DEPOSIT_EVENT_VERIFIER)) {
  throw new Error("Set HUB_ACROSS_DEPOSIT_EVENT_VERIFIER_ADDRESS");
}
if (!isAddress(EXTERNAL_ACROSS_BORROW_FILL_EVENT_VERIFIER)) {
  throw new Error("Set HUB_ACROSS_BORROW_FILL_EVENT_VERIFIER_ADDRESS");
}

const DEPLOYER_PRIVATE_KEY =
  process.env.DEPLOYER_PRIVATE_KEY ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY ?? DEPLOYER_PRIVATE_KEY;
const BRIDGE_PRIVATE_KEY = process.env.BRIDGE_PRIVATE_KEY ?? DEPLOYER_PRIVATE_KEY;
const PROVER_PRIVATE_KEY = process.env.PROVER_PRIVATE_KEY ?? DEPLOYER_PRIVATE_KEY;

const deployer = privateKeyToAccount(DEPLOYER_PRIVATE_KEY);
const relayer = privateKeyToAccount(RELAYER_PRIVATE_KEY);
const bridge = privateKeyToAccount(BRIDGE_PRIVATE_KEY);
const prover = privateKeyToAccount(PROVER_PRIVATE_KEY);

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const UUPS_UPGRADE_ABI = parseAbi(["function upgradeToAndCall(address newImplementation, bytes data)"]);

const TOKEN_DEFS = [
  {
    symbol: "WETH",
    decimals: 18,
    supplyCap: 100_000_000n * 10n ** 18n,
    borrowCap: 80_000_000n * 10n ** 18n
  },
  {
    symbol: "USDC",
    decimals: 6,
    supplyCap: 100_000_000n * 10n ** 6n,
    borrowCap: 80_000_000n * 10n ** 6n
  }
];
const erc20MetadataAbi = parseAbi(["function decimals() view returns (uint8)"]);
const TX_MAX_ATTEMPTS = Number(process.env.LIVE_TX_MAX_ATTEMPTS ?? "8");
const TX_RECEIPT_TIMEOUT_MS = Number(process.env.LIVE_TX_RECEIPT_TIMEOUT_MS ?? "90000");
const TX_GAS_BUMP_BPS = Number(process.env.LIVE_TX_GAS_BUMP_BPS ?? "120");
const TX_GAS_BUMP_STEP_BPS = Number(process.env.LIVE_TX_GAS_BUMP_STEP_BPS ?? "25");
const MIN_GAS_PRICE_WEI = BigInt(process.env.LIVE_MIN_GAS_PRICE_WEI ?? "100000000"); // 0.1 gwei

if (!Number.isInteger(TX_MAX_ATTEMPTS) || TX_MAX_ATTEMPTS <= 0) {
  throw new Error(`Invalid LIVE_TX_MAX_ATTEMPTS=${TX_MAX_ATTEMPTS}`);
}
if (!Number.isInteger(TX_RECEIPT_TIMEOUT_MS) || TX_RECEIPT_TIMEOUT_MS <= 0) {
  throw new Error(`Invalid LIVE_TX_RECEIPT_TIMEOUT_MS=${TX_RECEIPT_TIMEOUT_MS}`);
}
if (!Number.isInteger(TX_GAS_BUMP_BPS) || TX_GAS_BUMP_BPS < 100) {
  throw new Error(`Invalid LIVE_TX_GAS_BUMP_BPS=${TX_GAS_BUMP_BPS}`);
}
if (!Number.isInteger(TX_GAS_BUMP_STEP_BPS) || TX_GAS_BUMP_STEP_BPS < 0) {
  throw new Error(`Invalid LIVE_TX_GAS_BUMP_STEP_BPS=${TX_GAS_BUMP_STEP_BPS}`);
}
if (MIN_GAS_PRICE_WEI <= 0n) {
  throw new Error(`Invalid LIVE_MIN_GAS_PRICE_WEI=${MIN_GAS_PRICE_WEI}`);
}

function loadArtifact(contractName) {
  const artifactPath = path.join(outDir, `${contractName}.sol`, `${contractName}.json`);
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Missing artifact ${artifactPath}. Run forge build first.`);
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const bytecode = normalizeHex(artifact.bytecode.object);
  const deployedBytecode = normalizeHex(artifact.deployedBytecode.object);
  if (!bytecode || !deployedBytecode) {
    throw new Error(`Artifact missing bytecode for ${contractName}`);
  }
  return {
    abi: artifact.abi,
    bytecode,
    deployedBytecode,
    runtimeBytecodeHash: keccak256(deployedBytecode)
  };
}

function normalizeHex(value) {
  if (!value || typeof value !== "string") return "";
  return value.startsWith("0x") ? value : `0x${value}`;
}

function normalizeNetwork(value) {
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "mainnet") return "ethereum";
  if (normalized === "world") return "worldchain";
  if (normalized === "bnb") return "bsc";
  if (normalized in NETWORK_CATALOG) return normalized;

  throw new Error(`Unsupported network=${value}. Use one of: ${Object.keys(NETWORK_CATALOG).join(", ")}`);
}

function resolveRpcEnv(networkConfig) {
  const rpc = process.env[`${networkConfig.envPrefix}_RPC_URL`] ?? "";
  const tenderly = process.env[`${networkConfig.envPrefix}_TENDERLY_RPC_URL`] ?? "";
  if (LIVE_MODE && tenderly) {
    throw new Error(`LIVE_MODE forbids ${networkConfig.envPrefix}_TENDERLY_RPC_URL`);
  }
  return rpc || tenderly;
}

function resolveSpokeConfig(network) {
  const defaults = NETWORK_CATALOG[network];
  const chainKey = `${defaults.envPrefix}_CHAIN_ID`;
  const rpcKey = `${defaults.envPrefix}_RPC_URL`;

  const chainId = Number(process.env[chainKey] ?? defaults.chainId);
  const rpcUrl = process.env[rpcKey] ?? "";
  const tenderly = process.env[`${defaults.envPrefix}_TENDERLY_RPC_URL`] ?? "";

  if (LIVE_MODE && tenderly) {
    throw new Error(`LIVE_MODE forbids ${defaults.envPrefix}_TENDERLY_RPC_URL`);
  }

  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`Invalid ${chainKey}: ${chainId}`);
  }
  if (!rpcUrl) {
    throw new Error(`Missing ${rpcKey}`);
  }
  if (LIVE_MODE && isTenderlyRpc(rpcUrl)) {
    throw new Error(`LIVE_MODE forbids Tenderly RPC for ${network}`);
  }

  return {
    network,
    label: defaults.label,
    envPrefix: defaults.envPrefix,
    nativeSymbol: defaults.nativeSymbol,
    chainId,
    rpcUrl
  };
}

function createChainConfig(label, chainId, rpcUrl, nativeSymbol) {
  return defineChain({
    id: chainId,
    name: label,
    nativeCurrency: { name: nativeSymbol, symbol: nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } }
  });
}

function createClients({ chain, rpcUrl }) {
  return {
    publicClient: createPublicClient({ chain, transport: http(rpcUrl) }),
    walletClient: createWalletClient({ account: deployer, chain, transport: http(rpcUrl) })
  };
}

async function deploy(client, publicClient, contractName, args = []) {
  const { abi, bytecode } = loadArtifact(contractName);
  let lastError;
  for (let attempt = 1; attempt <= TX_MAX_ATTEMPTS; attempt++) {
    const nonce = await getLatestNonce(publicClient, client.account.address);
    const txOverrides = await getTxOverrides(publicClient, attempt);
    let hash;
    try {
      hash = await client.deployContract({ abi, bytecode, args, account: client.account, nonce, ...txOverrides });
    } catch (error) {
      lastError = error;
      if (!isRetryableRpcError(error) || attempt === TX_MAX_ATTEMPTS) {
        throw error;
      }
      console.warn(`[deploy:${contractName}] tx submit failed (attempt ${attempt}/${TX_MAX_ATTEMPTS}), retrying...`);
      await sleep(1_000 * attempt);
      continue;
    }

    try {
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        timeout: TX_RECEIPT_TIMEOUT_MS
      });
      if (!receipt.contractAddress || !isAddress(receipt.contractAddress)) {
        throw new Error(`Deployment failed for ${contractName}`);
      }
      await waitForContractCode(publicClient, receipt.contractAddress, contractName);
      return { address: receipt.contractAddress, txHash: hash };
    } catch (error) {
      lastError = error;
      if (!isRetryableRpcError(error) || attempt === TX_MAX_ATTEMPTS) {
        throw error;
      }
      console.warn(`[deploy:${contractName}] receipt wait failed for ${hash} (attempt ${attempt}/${TX_MAX_ATTEMPTS}), retrying...`);
      await sleep(1_000 * attempt);
    }
  }

  throw lastError ?? new Error(`Deployment failed for ${contractName}`);
}

async function waitForContractCode(publicClient, address, label, attempts = 20, delayMs = 1_000) {
  for (let i = 0; i < attempts; i++) {
    const code = await publicClient.getBytecode({ address });
    if (code && code !== "0x") return;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`${label} ${address} has no bytecode after deployment confirmation`);
}

async function getLatestNonce(publicClient, address) {
  return publicClient.getTransactionCount({
    address,
    blockTag: "latest"
  });
}

async function getTxOverrides(publicClient, attempt) {
  let gasPrice = MIN_GAS_PRICE_WEI;
  try {
    const networkGasPrice = await publicClient.getGasPrice();
    if (networkGasPrice > gasPrice) gasPrice = networkGasPrice;
  } catch {
    // Keep floor when RPC fee oracle is unavailable.
  }
  const bumpBps = BigInt(TX_GAS_BUMP_BPS + (attempt - 1) * TX_GAS_BUMP_STEP_BPS);
  const bumpedGasPrice = (gasPrice * bumpBps) / 100n;
  return {
    gasPrice: bumpedGasPrice > MIN_GAS_PRICE_WEI ? bumpedGasPrice : MIN_GAS_PRICE_WEI
  };
}

async function write(client, publicClient, { address, abi, functionName, args }) {
  let lastError;
  for (let attempt = 1; attempt <= TX_MAX_ATTEMPTS; attempt++) {
    const nonce = await getLatestNonce(publicClient, client.account.address);
    const txOverrides = await getTxOverrides(publicClient, attempt);
    let hash;
    try {
      hash = await client.writeContract({ address, abi, functionName, args, account: client.account, nonce, ...txOverrides });
    } catch (error) {
      lastError = error;
      if (!isRetryableRpcError(error) || attempt === TX_MAX_ATTEMPTS) {
        throw error;
      }
      console.warn(`[write:${functionName}] tx submit failed (attempt ${attempt}/${TX_MAX_ATTEMPTS}), retrying...`);
      await sleep(1_000 * attempt);
      continue;
    }

    try {
      await publicClient.waitForTransactionReceipt({
        hash,
        timeout: TX_RECEIPT_TIMEOUT_MS
      });
      return hash;
    } catch (error) {
      lastError = error;
      if (!isRetryableRpcError(error) || attempt === TX_MAX_ATTEMPTS) {
        throw error;
      }
      console.warn(`[write:${functionName}] receipt wait failed for ${hash} (attempt ${attempt}/${TX_MAX_ATTEMPTS}), retrying...`);
      await sleep(1_000 * attempt);
    }
  }

  throw lastError ?? new Error(`Missing tx hash for ${functionName}`);
}

function isTenderlyRpc(url) {
  return typeof url === "string" && url.includes("tenderly.co");
}

async function waitForAllChains(clients) {
  for (let i = 0; i < 30; i++) {
    try {
      await Promise.all(clients.map((client) => client.getBlockNumber()));
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw new Error("Could not connect to all configured RPC endpoints");
}

async function ensureContractCode(publicClient, address, label) {
  const code = await publicClient.getBytecode({ address });
  if (!code || code === "0x") {
    throw new Error(`${label} ${address} has no bytecode`);
  }
}

function sameAddress(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableRpcError(error) {
  const message = String(
    error?.shortMessage
    ?? error?.message
    ?? error?.cause?.shortMessage
    ?? error?.cause?.message
    ?? ""
  ).toLowerCase();
  const details = String(error?.details ?? error?.cause?.details ?? "").toLowerCase();
  const meta = String(error?.metaMessages?.join(" ") ?? error?.cause?.metaMessages?.join(" ") ?? "").toLowerCase();
  const combined = `${message} ${details} ${meta}`;
  return (
    combined.includes("timed out")
    || combined.includes("took too long")
    || combined.includes("timeout")
    || combined.includes("socket hang up")
    || combined.includes("connection reset")
    || combined.includes("nonce too low")
    || combined.includes("already known")
    || combined.includes("replacement transaction underpriced")
    || combined.includes("already been used")
    || combined.includes("correct nonce")
    || combined.includes("502")
    || combined.includes("503")
    || combined.includes("504")
    || combined.includes("rate limit")
    || combined.includes("too many requests")
  );
}

function isInvalidTokenAddressError(error) {
  if (error?.cause?.data?.errorName === "InvalidTokenAddress") return true;
  if (error?.data?.errorName === "InvalidTokenAddress") return true;
  const message = String(error?.shortMessage ?? error?.message ?? "");
  return message.includes("InvalidTokenAddress()");
}

function isMarketAlreadyInitializedError(error) {
  if (error?.cause?.data?.errorName === "MarketAlreadyInitialized") return true;
  if (error?.data?.errorName === "MarketAlreadyInitialized") return true;
  const message = String(error?.shortMessage ?? error?.message ?? "");
  const details = String(error?.cause?.metaMessages?.join(" ") ?? "");
  return message.includes("MarketAlreadyInitialized") || details.includes("MarketAlreadyInitialized");
}

async function waitForHubTokenConfig({
  publicClient,
  tokenRegistryAddress,
  tokenRegistryAbi,
  hubToken,
  attempts = 20,
  delayMs = 1_500
}) {
  for (let i = 0; i < attempts; i += 1) {
    const cfg = await publicClient.readContract({
      address: tokenRegistryAddress,
      abi: tokenRegistryAbi,
      functionName: "getConfigByHub",
      args: [hubToken]
    });

    if (cfg?.hubToken && !sameAddress(cfg.hubToken, ZERO_ADDRESS)) return;
    await sleep(delayMs);
  }

  throw new Error(`TokenRegistry config missing for hub token ${hubToken}`);
}

async function ensureTokenRoute({
  hubWallet,
  hubPublic,
  tokenRegistryAddress,
  tokenRegistryAbi,
  chainId,
  hubToken,
  spokeDecimals,
  spokeToken,
  attempts = 6,
  delayMs = 1_500
}) {
  const currentSpoke = await hubPublic.readContract({
    address: tokenRegistryAddress,
    abi: tokenRegistryAbi,
    functionName: "getSpokeTokenByHub",
    args: [BigInt(chainId), hubToken]
  });
  const currentDecimals = Number(await hubPublic.readContract({
    address: tokenRegistryAddress,
    abi: tokenRegistryAbi,
    functionName: "getSpokeDecimalsByHub",
    args: [BigInt(chainId), hubToken]
  }));
  if (currentSpoke && sameAddress(currentSpoke, spokeToken) && currentDecimals === spokeDecimals) return;

  for (let i = 0; i < attempts; i += 1) {
    try {
      await write(hubWallet, hubPublic, {
        address: tokenRegistryAddress,
        abi: tokenRegistryAbi,
        functionName: "setTokenRoute",
        args: [BigInt(chainId), hubToken, spokeToken, spokeDecimals]
      });
      return;
    } catch (error) {
      if (!isInvalidTokenAddressError(error) || i + 1 >= attempts) throw error;
      await sleep(delayMs);
    }
  }
}

async function ensureMarketInitialized({
  hubWallet,
  hubPublic,
  moneyMarketAddress,
  marketAbi,
  asset
}) {
  const market = await hubPublic.readContract({
    address: moneyMarketAddress,
    abi: marketAbi,
    functionName: "markets",
    args: [asset]
  });
  const initialized = Array.isArray(market) ? Boolean(market[6]) : Boolean(market.initialized);
  if (initialized) return;

  try {
    await write(hubWallet, hubPublic, {
      address: moneyMarketAddress,
      abi: marketAbi,
      functionName: "initializeMarket",
      args: [asset]
    });
  } catch (error) {
    if (!isMarketAlreadyInitializedError(error)) throw error;
  }
}

async function ensureAccountBalance({
  walletClient,
  publicClient,
  rpcUrl,
  address,
  minBalanceWei,
  label
}) {
  const current = await publicClient.getBalance({ address });
  if (current >= minBalanceWei) return;

  if (isTenderlyRpc(rpcUrl)) {
    throw new Error(`LIVE_MODE forbids Tenderly funding for ${label}`);
  }

  if (address.toLowerCase() !== walletClient.account.address.toLowerCase()) {
    const senderBalance = await publicClient.getBalance({ address: walletClient.account.address });
    const topUp = minBalanceWei - current;
    if (senderBalance <= topUp) {
      throw new Error(
        `Insufficient balance to fund ${label}. needed=${formatEther(topUp)} sender=${formatEther(senderBalance)}`
      );
    }

    const tx = await walletClient.sendTransaction({ to: address, value: topUp, account: walletClient.account });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    return;
  }

  throw new Error(
    `Cannot fund ${label}; deployer balance is ${formatEther(current)} < ${formatEther(minBalanceWei)}`
  );
}

const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

function readManifest(filePath) {
  if (!fs.existsSync(filePath)) {
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      uups: {},
      singletons: {},
      metadata: {}
    };
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeManifest(filePath, manifest) {
  manifest.updatedAt = new Date().toISOString();
  fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2));
}

function toAddressFromStorage(storageValue) {
  if (!storageValue || storageValue === "0x") return ZERO_ADDRESS;
  const clean = storageValue.slice(2).padStart(64, "0");
  return `0x${clean.slice(24)}`;
}

function appendActionLog(logPath, rows) {
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, "# timestamp action network chainId key proxy oldImpl newImpl bytecodeHash tx\n");
  }
  if (rows.length === 0) return;

  const lines = rows.map((row) => {
    return `${row.timestamp} action=${row.action} network=${row.network} chainId=${row.chainId} key=${row.key} proxy=${row.proxy ?? "-"} oldImpl=${row.oldImpl ?? "-"} newImpl=${row.newImpl ?? "-"} bytecodeHash=${row.bytecodeHash ?? "-"} tx=${row.tx ?? "-"}`;
  });
  fs.appendFileSync(logPath, `${lines.join("\n")}\n`);
}

function makeActionRow(actionRows, row) {
  actionRows.push({
    timestamp: new Date().toISOString(),
    ...row
  });
}

async function deployOrUpgradeUUPS({
  key,
  network,
  chainId,
  contractName,
  constructorArgs,
  initArgs,
  client,
  publicClient,
  manifest,
  actionRows
}) {
  const artifact = loadArtifact(contractName);
  const entry = manifest.uups[key];

  if (!entry || !entry.proxy || !isAddress(entry.proxy)) {
    const implDeployment = await deploy(client, publicClient, contractName, constructorArgs);
    const data = encodeFunctionData({
      abi: artifact.abi,
      functionName: "initializeProxy",
      args: initArgs
    });
    const proxyDeployment = await deploy(client, publicClient, "UUPSProxy", [implDeployment.address, data]);

    manifest.uups[key] = {
      proxy: proxyDeployment.address,
      implementation: implDeployment.address,
      runtimeBytecodeHash: artifact.runtimeBytecodeHash,
      deployedAt: new Date().toISOString(),
      lastTxHash: proxyDeployment.txHash
    };

    makeActionRow(actionRows, {
      action: "deploy",
      network,
      chainId,
      key,
      proxy: proxyDeployment.address,
      oldImpl: ZERO_ADDRESS,
      newImpl: implDeployment.address,
      bytecodeHash: artifact.runtimeBytecodeHash,
      tx: proxyDeployment.txHash
    });

    return {
      proxy: proxyDeployment.address,
      implementation: implDeployment.address,
      action: "deploy"
    };
  }

  const proxy = entry.proxy;
  await ensureContractCode(publicClient, proxy, `${key}.proxy`);

  const storageValue = await publicClient.getStorageAt({ address: proxy, slot: IMPLEMENTATION_SLOT });
  const currentImpl = toAddressFromStorage(storageValue);
  await ensureContractCode(publicClient, currentImpl, `${key}.implementation`);

  const currentImplCode = await publicClient.getBytecode({ address: currentImpl });
  const currentImplHash = currentImplCode && currentImplCode !== "0x" ? keccak256(currentImplCode) : "0x";

  if (currentImplHash === artifact.runtimeBytecodeHash) {
    manifest.uups[key] = {
      ...entry,
      implementation: currentImpl,
      runtimeBytecodeHash: currentImplHash,
      lastTxHash: entry.lastTxHash ?? ""
    };

    makeActionRow(actionRows, {
      action: "skip",
      network,
      chainId,
      key,
      proxy,
      oldImpl: currentImpl,
      newImpl: currentImpl,
      bytecodeHash: currentImplHash,
      tx: entry.lastTxHash ?? "-"
    });

    return {
      proxy,
      implementation: currentImpl,
      action: "skip"
    };
  }

  const implDeployment = await deploy(client, publicClient, contractName, constructorArgs);
  const upgradeTx = await write(client, publicClient, {
    address: proxy,
    abi: UUPS_UPGRADE_ABI,
    functionName: "upgradeToAndCall",
    args: [implDeployment.address, "0x"]
  });

  manifest.uups[key] = {
    ...entry,
    proxy,
    implementation: implDeployment.address,
    runtimeBytecodeHash: artifact.runtimeBytecodeHash,
    upgradedAt: new Date().toISOString(),
    lastTxHash: upgradeTx
  };

  makeActionRow(actionRows, {
    action: "upgrade",
    network,
    chainId,
    key,
    proxy,
    oldImpl: currentImpl,
    newImpl: implDeployment.address,
    bytecodeHash: artifact.runtimeBytecodeHash,
    tx: upgradeTx
  });

  return {
    proxy,
    implementation: implDeployment.address,
    action: "upgrade"
  };
}

async function deployOrReuseSingleton({
  key,
  network,
  chainId,
  contractName,
  constructorArgs,
  client,
  publicClient,
  manifest,
  actionRows
}) {
  const artifact = loadArtifact(contractName);
  const entry = manifest.singletons[key];

  if (entry?.address && isAddress(entry.address)) {
    const code = await publicClient.getBytecode({ address: entry.address });
    if (code && code !== "0x") {
      const currentHash = keccak256(code);
      if (currentHash === artifact.runtimeBytecodeHash) {
        makeActionRow(actionRows, {
          action: "skip",
          network,
          chainId,
          key,
          proxy: entry.address,
          oldImpl: entry.address,
          newImpl: entry.address,
          bytecodeHash: currentHash,
          tx: entry.lastTxHash ?? "-"
        });
        return entry.address;
      }
    }
  }

  const deployed = await deploy(client, publicClient, contractName, constructorArgs);
  manifest.singletons[key] = {
    address: deployed.address,
    runtimeBytecodeHash: artifact.runtimeBytecodeHash,
    lastTxHash: deployed.txHash,
    updatedAt: new Date().toISOString()
  };

  makeActionRow(actionRows, {
    action: "deploy",
    network,
    chainId,
    key,
    proxy: deployed.address,
    oldImpl: entry?.address ?? ZERO_ADDRESS,
    newImpl: deployed.address,
    bytecodeHash: artifact.runtimeBytecodeHash,
    tx: deployed.txHash
  });

  return deployed.address;
}

function slugNetwork(network) {
  if (network === "worldchain") return "world";
  return network;
}

function requireAddressEnv(key) {
  const value = process.env[key] ?? "";
  if (!isAddress(value)) {
    throw new Error(`Missing/invalid ${key}`);
  }
  return value;
}

function resolveTokenAddress(envPrefix, symbol) {
  return requireAddressEnv(`${envPrefix}_${symbol}_ADDRESS`);
}

function resolveFeedConfig(envPrefix, symbol) {
  const feed = requireAddressEnv(`${envPrefix}_${symbol}_USD_FEED`);
  const heartbeat = Number(process.env[`${envPrefix}_${symbol}_USD_HEARTBEAT`] ?? "86400");
  const minPriceE8 = BigInt(process.env[`${envPrefix}_${symbol}_MIN_PRICE_E8`] ?? "1");
  const maxPriceE8 = BigInt(process.env[`${envPrefix}_${symbol}_MAX_PRICE_E8`] ?? "0");
  if (!Number.isInteger(heartbeat) || heartbeat <= 0) {
    throw new Error(`Invalid ${envPrefix}_${symbol}_USD_HEARTBEAT=${heartbeat}`);
  }
  return { feed, heartbeat, minPriceE8, maxPriceE8 };
}

async function main() {
  fs.mkdirSync(deploymentsDir, { recursive: true });

  const spokeConfigs = SPOKE_NETWORKS.map(resolveSpokeConfig);

  const hubAcrossSpokePool = requireAddressEnv(`${HUB_DEFAULTS.envPrefix}_ACROSS_SPOKE_POOL_ADDRESS`);
  const hubTokens = Object.fromEntries(TOKEN_DEFS.map((token) => [token.symbol, resolveTokenAddress(HUB_DEFAULTS.envPrefix, token.symbol)]));

  const spokeTokenMap = {};
  const spokeAcrossPools = {};
  for (const spoke of spokeConfigs) {
    spokeAcrossPools[spoke.network] = requireAddressEnv(`${spoke.envPrefix}_ACROSS_SPOKE_POOL_ADDRESS`);
    spokeTokenMap[spoke.network] = Object.fromEntries(
      TOKEN_DEFS.map((token) => [token.symbol, resolveTokenAddress(spoke.envPrefix, token.symbol)])
    );
  }

  const hubChain = createChainConfig(`${HUB_DEFAULTS.label} Hub`, HUB_CHAIN_ID, HUB_RPC_URL, HUB_DEFAULTS.nativeSymbol);
  const { publicClient: hubPublic, walletClient: hubWallet } = createClients({ chain: hubChain, rpcUrl: HUB_RPC_URL });

  const spokeRuntime = spokeConfigs.map((cfg) => {
    const chain = createChainConfig(`${cfg.label} Spoke`, cfg.chainId, cfg.rpcUrl, cfg.nativeSymbol);
    const { publicClient, walletClient } = createClients({ chain, rpcUrl: cfg.rpcUrl });
    return { ...cfg, chain, publicClient, walletClient };
  });

  await waitForAllChains([hubPublic, ...spokeRuntime.map((s) => s.publicClient)]);

  const spokeTokenDecimals = {};
  for (const spoke of spokeRuntime) {
    spokeTokenDecimals[spoke.network] = {};
    for (const token of TOKEN_DEFS) {
      const tokenAddress = spokeTokenMap[spoke.network][token.symbol];
      const decimals = Number(await spoke.publicClient.readContract({
        address: tokenAddress,
        abi: erc20MetadataAbi,
        functionName: "decimals"
      }));
      if (!Number.isInteger(decimals) || decimals <= 0) {
        throw new Error(`Invalid decimals for ${spoke.network} ${token.symbol}: ${decimals}`);
      }
      spokeTokenDecimals[spoke.network][token.symbol] = decimals;
    }
  }

  const minDeployerGas = parseEther(process.env.DEPLOY_MIN_DEPLOYER_GAS_ETH ?? "0.5");
  const minOperatorGas = parseEther(process.env.DEPLOY_MIN_OPERATOR_GAS_ETH ?? "0.05");

  await ensureAccountBalance({
    walletClient: hubWallet,
    publicClient: hubPublic,
    rpcUrl: HUB_RPC_URL,
    address: deployer.address,
    minBalanceWei: minDeployerGas,
    label: "hub deployer"
  });

  for (const spoke of spokeRuntime) {
    await ensureAccountBalance({
      walletClient: spoke.walletClient,
      publicClient: spoke.publicClient,
      rpcUrl: spoke.rpcUrl,
      address: deployer.address,
      minBalanceWei: minDeployerGas,
      label: `${spoke.network} deployer`
    });
  }

  for (const actor of [relayer.address, bridge.address, prover.address]) {
    await ensureAccountBalance({
      walletClient: hubWallet,
      publicClient: hubPublic,
      rpcUrl: HUB_RPC_URL,
      address: actor,
      minBalanceWei: minOperatorGas,
      label: `hub operator ${actor}`
    });
  }

  for (const spoke of spokeRuntime) {
    for (const actor of [relayer.address, bridge.address, prover.address]) {
      await ensureAccountBalance({
        walletClient: spoke.walletClient,
        publicClient: spoke.publicClient,
        rpcUrl: spoke.rpcUrl,
        address: actor,
        minBalanceWei: minOperatorGas,
        label: `${spoke.network} operator ${actor}`
      });
    }
  }

  await ensureContractCode(hubPublic, HUB_GROTH16_VERIFIER_ADDRESS, "HUB_GROTH16_VERIFIER_ADDRESS");
  await ensureContractCode(hubPublic, EXTERNAL_LIGHT_CLIENT_VERIFIER, "HUB_LIGHT_CLIENT_VERIFIER_ADDRESS");
  await ensureContractCode(hubPublic, EXTERNAL_ACROSS_DEPOSIT_EVENT_VERIFIER, "HUB_ACROSS_DEPOSIT_EVENT_VERIFIER_ADDRESS");
  await ensureContractCode(hubPublic, EXTERNAL_ACROSS_BORROW_FILL_EVENT_VERIFIER, "HUB_ACROSS_BORROW_FILL_EVENT_VERIFIER_ADDRESS");

  const slug = `${slugNetwork(HUB_NETWORK)}-${SPOKE_NETWORKS.map(slugNetwork).join("-")}`;
  const manifestPath = path.join(deploymentsDir, `live-${slug}.manifest.json`);
  const manifest = readManifest(manifestPath);
  const actionRows = [];

  console.log(`Deploying/upgrading hub protocol on ${HUB_DEFAULTS.label}...`);
  const tokenRegistryDeployment = await deployOrUpgradeUUPS({
    key: `hub.tokenRegistry`,
    network: HUB_NETWORK,
    chainId: HUB_CHAIN_ID,
    contractName: "TokenRegistry",
    constructorArgs: [deployer.address],
    initArgs: [deployer.address],
    client: hubWallet,
    publicClient: hubPublic,
    manifest,
    actionRows
  });
  const tokenRegistry = tokenRegistryDeployment.proxy;

  const oracle = await deployOrReuseSingleton({
    key: `hub.chainlinkOracle`,
    network: HUB_NETWORK,
    chainId: HUB_CHAIN_ID,
    contractName: "ChainlinkPriceOracle",
    constructorArgs: [deployer.address],
    client: hubWallet,
    publicClient: hubPublic,
    manifest,
    actionRows
  });

  const rateModelDeployment = await deployOrUpgradeUUPS({
    key: `hub.rateModel`,
    network: HUB_NETWORK,
    chainId: HUB_CHAIN_ID,
    contractName: "KinkInterestRateModel",
    constructorArgs: [
      deployer.address,
      3_170_979_198_000_000_000n,
      6_341_958_396_000_000_000n,
      19_025_875_190_000_000_000n,
      800_000_000_000_000_000_000_000_000n,
      100_000_000_000_000_000_000_000_000n
    ],
    initArgs: [
      deployer.address,
      3_170_979_198_000_000_000n,
      6_341_958_396_000_000_000n,
      19_025_875_190_000_000_000n,
      800_000_000_000_000_000_000_000_000n,
      100_000_000_000_000_000_000_000_000n
    ],
    client: hubWallet,
    publicClient: hubPublic,
    manifest,
    actionRows
  });
  const rateModel = rateModelDeployment.proxy;

  const moneyMarketDeployment = await deployOrUpgradeUUPS({
    key: `hub.moneyMarket`,
    network: HUB_NETWORK,
    chainId: HUB_CHAIN_ID,
    contractName: "HubMoneyMarket",
    constructorArgs: [deployer.address, tokenRegistry, rateModel],
    initArgs: [deployer.address],
    client: hubWallet,
    publicClient: hubPublic,
    manifest,
    actionRows
  });
  const moneyMarket = moneyMarketDeployment.proxy;

  const riskManagerDeployment = await deployOrUpgradeUUPS({
    key: `hub.riskManager`,
    network: HUB_NETWORK,
    chainId: HUB_CHAIN_ID,
    contractName: "HubRiskManager",
    constructorArgs: [deployer.address, tokenRegistry, moneyMarket, oracle],
    initArgs: [deployer.address],
    client: hubWallet,
    publicClient: hubPublic,
    manifest,
    actionRows
  });
  const riskManager = riskManagerDeployment.proxy;

  const intentInboxDeployment = await deployOrUpgradeUUPS({
    key: `hub.intentInbox`,
    network: HUB_NETWORK,
    chainId: HUB_CHAIN_ID,
    contractName: "HubIntentInbox",
    constructorArgs: [deployer.address],
    initArgs: [deployer.address],
    client: hubWallet,
    publicClient: hubPublic,
    manifest,
    actionRows
  });
  const intentInbox = intentInboxDeployment.proxy;

  const lockManagerDeployment = await deployOrUpgradeUUPS({
    key: `hub.lockManager`,
    network: HUB_NETWORK,
    chainId: HUB_CHAIN_ID,
    contractName: "HubLockManager",
    constructorArgs: [deployer.address, intentInbox, tokenRegistry, riskManager, moneyMarket],
    initArgs: [deployer.address],
    client: hubWallet,
    publicClient: hubPublic,
    manifest,
    actionRows
  });
  const lockManager = lockManagerDeployment.proxy;

  const custodyDeployment = await deployOrUpgradeUUPS({
    key: `hub.custody`,
    network: HUB_NETWORK,
    chainId: HUB_CHAIN_ID,
    contractName: "HubCustody",
    constructorArgs: [deployer.address],
    initArgs: [deployer.address],
    client: hubWallet,
    publicClient: hubPublic,
    manifest,
    actionRows
  });
  const custody = custodyDeployment.proxy;

  const groth16VerifierAdapterDeployment = await deployOrUpgradeUUPS({
    key: `hub.groth16VerifierAdapter`,
    network: HUB_NETWORK,
    chainId: HUB_CHAIN_ID,
    contractName: "Groth16VerifierAdapter",
    constructorArgs: [deployer.address, HUB_GROTH16_VERIFIER_ADDRESS],
    initArgs: [deployer.address, HUB_GROTH16_VERIFIER_ADDRESS],
    client: hubWallet,
    publicClient: hubPublic,
    manifest,
    actionRows
  });
  const groth16VerifierAdapter = groth16VerifierAdapterDeployment.proxy;

  const verifierDeployment = await deployOrUpgradeUUPS({
    key: `hub.verifier`,
    network: HUB_NETWORK,
    chainId: HUB_CHAIN_ID,
    contractName: "Verifier",
    constructorArgs: [
      deployer.address,
      false,
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      groth16VerifierAdapter,
      4n
    ],
    initArgs: [deployer.address, groth16VerifierAdapter],
    client: hubWallet,
    publicClient: hubPublic,
    manifest,
    actionRows
  });
  const verifier = verifierDeployment.proxy;

  const settlementDeployment = await deployOrUpgradeUUPS({
    key: `hub.settlement`,
    network: HUB_NETWORK,
    chainId: HUB_CHAIN_ID,
    contractName: "HubSettlement",
    constructorArgs: [deployer.address, verifier, moneyMarket, custody, lockManager],
    initArgs: [deployer.address, verifier, moneyMarket, custody, lockManager],
    client: hubWallet,
    publicClient: hubPublic,
    manifest,
    actionRows
  });
  const settlement = settlementDeployment.proxy;

  const lightClientVerifierAdapter = await deployOrReuseSingleton({
    key: `hub.lightClientVerifierAdapter`,
    network: HUB_NETWORK,
    chainId: HUB_CHAIN_ID,
    contractName: "ExternalLightClientVerifier",
    constructorArgs: [deployer.address, EXTERNAL_LIGHT_CLIENT_VERIFIER],
    client: hubWallet,
    publicClient: hubPublic,
    manifest,
    actionRows
  });

  const acrossDepositEventVerifierAdapter = await deployOrReuseSingleton({
    key: `hub.acrossDepositEventVerifierAdapter`,
    network: HUB_NETWORK,
    chainId: HUB_CHAIN_ID,
    contractName: "ExternalAcrossDepositEventVerifier",
    constructorArgs: [deployer.address, EXTERNAL_ACROSS_DEPOSIT_EVENT_VERIFIER],
    client: hubWallet,
    publicClient: hubPublic,
    manifest,
    actionRows
  });

  const acrossBorrowFillEventVerifierAdapter = await deployOrReuseSingleton({
    key: `hub.acrossBorrowFillEventVerifierAdapter`,
    network: HUB_NETWORK,
    chainId: HUB_CHAIN_ID,
    contractName: "ExternalAcrossBorrowFillEventVerifier",
    constructorArgs: [deployer.address, EXTERNAL_ACROSS_BORROW_FILL_EVENT_VERIFIER],
    client: hubWallet,
    publicClient: hubPublic,
    manifest,
    actionRows
  });

  const externalLightAbi = loadArtifact("ExternalLightClientVerifier").abi;
  const externalDepositAbi = loadArtifact("ExternalAcrossDepositEventVerifier").abi;
  const externalBorrowAbi = loadArtifact("ExternalAcrossBorrowFillEventVerifier").abi;

  await write(hubWallet, hubPublic, {
    address: lightClientVerifierAdapter,
    abi: externalLightAbi,
    functionName: "setVerifier",
    args: [EXTERNAL_LIGHT_CLIENT_VERIFIER]
  });
  await write(hubWallet, hubPublic, {
    address: acrossDepositEventVerifierAdapter,
    abi: externalDepositAbi,
    functionName: "setVerifier",
    args: [EXTERNAL_ACROSS_DEPOSIT_EVENT_VERIFIER]
  });
  await write(hubWallet, hubPublic, {
    address: acrossBorrowFillEventVerifierAdapter,
    abi: externalBorrowAbi,
    functionName: "setVerifier",
    args: [EXTERNAL_ACROSS_BORROW_FILL_EVENT_VERIFIER]
  });

  const depositProofBackendDeployment = await deployOrUpgradeUUPS({
    key: `hub.depositProofBackend`,
    network: HUB_NETWORK,
    chainId: HUB_CHAIN_ID,
    contractName: "AcrossDepositProofBackend",
    constructorArgs: [deployer.address, lightClientVerifierAdapter, acrossDepositEventVerifierAdapter],
    initArgs: [deployer.address],
    client: hubWallet,
    publicClient: hubPublic,
    manifest,
    actionRows
  });
  const depositProofBackend = depositProofBackendDeployment.proxy;

  const depositProofVerifier = await deployOrReuseSingleton({
    key: `hub.depositProofVerifier`,
    network: HUB_NETWORK,
    chainId: HUB_CHAIN_ID,
    contractName: "DepositProofVerifier",
    constructorArgs: [depositProofBackend],
    client: hubWallet,
    publicClient: hubPublic,
    manifest,
    actionRows
  });

  const borrowFillProofBackendDeployment = await deployOrUpgradeUUPS({
    key: `hub.borrowFillProofBackend`,
    network: HUB_NETWORK,
    chainId: HUB_CHAIN_ID,
    contractName: "AcrossBorrowFillProofBackend",
    constructorArgs: [deployer.address, lightClientVerifierAdapter, acrossBorrowFillEventVerifierAdapter],
    initArgs: [deployer.address],
    client: hubWallet,
    publicClient: hubPublic,
    manifest,
    actionRows
  });
  const borrowFillProofBackend = borrowFillProofBackendDeployment.proxy;

  const borrowFillProofVerifier = await deployOrReuseSingleton({
    key: `hub.borrowFillProofVerifier`,
    network: HUB_NETWORK,
    chainId: HUB_CHAIN_ID,
    contractName: "BorrowFillProofVerifier",
    constructorArgs: [borrowFillProofBackend],
    client: hubWallet,
    publicClient: hubPublic,
    manifest,
    actionRows
  });

  const hubAcrossBorrowFinalizerDeployment = await deployOrUpgradeUUPS({
    key: `hub.hubAcrossBorrowFinalizer`,
    network: HUB_NETWORK,
    chainId: HUB_CHAIN_ID,
    contractName: "HubAcrossBorrowFinalizer",
    constructorArgs: [deployer.address, settlement, borrowFillProofVerifier],
    initArgs: [deployer.address, borrowFillProofVerifier],
    client: hubWallet,
    publicClient: hubPublic,
    manifest,
    actionRows
  });
  const hubAcrossBorrowFinalizer = hubAcrossBorrowFinalizerDeployment.proxy;

  const hubAcrossBorrowDispatcherDeployment = await deployOrUpgradeUUPS({
    key: `hub.hubAcrossBorrowDispatcher`,
    network: HUB_NETWORK,
    chainId: HUB_CHAIN_ID,
    contractName: "HubAcrossBorrowDispatcher",
    constructorArgs: [deployer.address, hubAcrossBorrowFinalizer],
    initArgs: [deployer.address, hubAcrossBorrowFinalizer],
    client: hubWallet,
    publicClient: hubPublic,
    manifest,
    actionRows
  });
  const hubAcrossBorrowDispatcher = hubAcrossBorrowDispatcherDeployment.proxy;

  const hubAcrossReceiverDeployment = await deployOrUpgradeUUPS({
    key: `hub.hubAcrossReceiver`,
    network: HUB_NETWORK,
    chainId: HUB_CHAIN_ID,
    contractName: "HubAcrossReceiver",
    constructorArgs: [deployer.address, custody, depositProofVerifier, hubAcrossSpokePool],
    initArgs: [deployer.address, depositProofVerifier, hubAcrossSpokePool],
    client: hubWallet,
    publicClient: hubPublic,
    manifest,
    actionRows
  });
  const hubAcrossReceiver = hubAcrossReceiverDeployment.proxy;

  const tokenRegistryAbi = loadArtifact("TokenRegistry").abi;
  const riskAbi = loadArtifact("HubRiskManager").abi;
  const marketAbi = loadArtifact("HubMoneyMarket").abi;
  const inboxAbi = loadArtifact("HubIntentInbox").abi;
  const lockAbi = loadArtifact("HubLockManager").abi;
  const custodyAbi = loadArtifact("HubCustody").abi;
  const settlementAbi = loadArtifact("HubSettlement").abi;
  const portalAbi = loadArtifact("SpokePortal").abi;
  const acrossBridgeAdapterAbi = loadArtifact("AcrossBridgeAdapter").abi;
  const depositProofBackendAbi = loadArtifact("AcrossDepositProofBackend").abi;
  const borrowFillProofBackendAbi = loadArtifact("AcrossBorrowFillProofBackend").abi;
  const hubAcrossBorrowDispatcherAbi = loadArtifact("HubAcrossBorrowDispatcher").abi;
  const chainlinkOracleAbi = loadArtifact("ChainlinkPriceOracle").abi;

  const bridgeAdapterId = keccak256(stringToHex("across-v3"));
  const riskBase = [7500n, 8000n, 10500n];

  const spokeDeployments = {};
  const spokeImplementations = {};

  for (const spoke of spokeRuntime) {
    console.log(`Deploying/upgrading ${spoke.label} spoke protocol (UUPS)...`);

    const portalDeployment = await deployOrUpgradeUUPS({
      key: `spoke.${spoke.network}.portal`,
      network: spoke.network,
      chainId: spoke.chainId,
      contractName: "SpokePortal",
      constructorArgs: [deployer.address, BigInt(HUB_CHAIN_ID)],
      initArgs: [deployer.address],
      client: spoke.walletClient,
      publicClient: spoke.publicClient,
      manifest,
      actionRows
    });
    const portal = portalDeployment.proxy;

    const borrowReceiverDeployment = await deployOrUpgradeUUPS({
      key: `spoke.${spoke.network}.borrowReceiver`,
      network: spoke.network,
      chainId: spoke.chainId,
      contractName: "SpokeAcrossBorrowReceiver",
      constructorArgs: [
        deployer.address,
        spokeAcrossPools[spoke.network],
        hubAcrossBorrowDispatcher,
        hubAcrossBorrowFinalizer,
        BigInt(HUB_CHAIN_ID),
        relayer.address
      ],
      initArgs: [
        deployer.address,
        spokeAcrossPools[spoke.network],
        hubAcrossBorrowDispatcher,
        hubAcrossBorrowFinalizer,
        BigInt(HUB_CHAIN_ID),
        relayer.address
      ],
      client: spoke.walletClient,
      publicClient: spoke.publicClient,
      manifest,
      actionRows
    });
    const borrowReceiver = borrowReceiverDeployment.proxy;

    const bridgeAdapterDeployment = await deployOrUpgradeUUPS({
      key: `spoke.${spoke.network}.bridgeAdapter`,
      network: spoke.network,
      chainId: spoke.chainId,
      contractName: "AcrossBridgeAdapter",
      constructorArgs: [deployer.address, BigInt(HUB_CHAIN_ID)],
      initArgs: [deployer.address],
      client: spoke.walletClient,
      publicClient: spoke.publicClient,
      manifest,
      actionRows
    });
    const bridgeAdapter = bridgeAdapterDeployment.proxy;

    await write(spoke.walletClient, spoke.publicClient, {
      address: portal,
      abi: portalAbi,
      functionName: "setBridgeAdapter",
      args: [bridgeAdapter]
    });
    await write(spoke.walletClient, spoke.publicClient, {
      address: portal,
      abi: portalAbi,
      functionName: "setHubRecipient",
      args: [hubAcrossReceiver]
    });
    await write(spoke.walletClient, spoke.publicClient, {
      address: bridgeAdapter,
      abi: acrossBridgeAdapterAbi,
      functionName: "setAllowedCaller",
      args: [portal, true]
    });

    for (const token of TOKEN_DEFS) {
      await write(spoke.walletClient, spoke.publicClient, {
        address: bridgeAdapter,
        abi: acrossBridgeAdapterAbi,
        functionName: "setRoute",
        args: [
          spokeTokenMap[spoke.network][token.symbol],
          spokeAcrossPools[spoke.network],
          hubTokens[token.symbol],
          true
        ]
      });
    }

    await write(hubWallet, hubPublic, {
      address: depositProofBackend,
      abi: depositProofBackendAbi,
      functionName: "setSourceSpokePool",
      args: [BigInt(spoke.chainId), spokeAcrossPools[spoke.network]]
    });

    await write(hubWallet, hubPublic, {
      address: borrowFillProofBackend,
      abi: borrowFillProofBackendAbi,
      functionName: "setSourceReceiver",
      args: [BigInt(spoke.chainId), borrowReceiver]
    });

    spokeDeployments[spoke.network] = {
      network: spoke.network,
      chainId: spoke.chainId,
      rpcUrl: spoke.rpcUrl,
      portal,
      bridgeAdapter,
      acrossSpokePool: spokeAcrossPools[spoke.network],
      borrowReceiver,
      tokens: spokeTokenMap[spoke.network]
    };

    spokeImplementations[spoke.network] = {
      portal: portalDeployment.implementation,
      bridgeAdapter: bridgeAdapterDeployment.implementation,
      borrowReceiver: borrowReceiverDeployment.implementation
    };
  }

  await write(hubWallet, hubPublic, {
    address: borrowFillProofBackend,
    abi: borrowFillProofBackendAbi,
    functionName: "setDestinationDispatcher",
    args: [hubAcrossBorrowDispatcher]
  });

  console.log("Configuring hub registry/risk/markets + routes...");
  for (const token of TOKEN_DEFS) {
    const hubToken = hubTokens[token.symbol];
    await write(hubWallet, hubPublic, {
      address: tokenRegistry,
      abi: tokenRegistryAbi,
      functionName: "setTokenBehavior",
      args: [hubToken, 1]
    });

    for (const spoke of spokeRuntime) {
      await write(hubWallet, hubPublic, {
        address: tokenRegistry,
        abi: tokenRegistryAbi,
        functionName: "setTokenBehavior",
        args: [spokeTokenMap[spoke.network][token.symbol], 1]
      });
    }

    const firstSpoke = spokeRuntime[0];
    await write(hubWallet, hubPublic, {
      address: tokenRegistry,
      abi: tokenRegistryAbi,
      functionName: "registerTokenFlat",
      args: [
        hubToken,
        spokeTokenMap[firstSpoke.network][token.symbol],
        token.decimals,
        riskBase[0],
        riskBase[1],
        riskBase[2],
        token.supplyCap,
        token.borrowCap,
        bridgeAdapterId,
        true
      ]
    });
    await waitForHubTokenConfig({
      publicClient: hubPublic,
      tokenRegistryAddress: tokenRegistry,
      tokenRegistryAbi,
      hubToken
    });

    for (const spoke of spokeRuntime) {
      await ensureTokenRoute({
        hubWallet,
        hubPublic,
        tokenRegistryAddress: tokenRegistry,
        tokenRegistryAbi,
        chainId: spoke.chainId,
        hubToken,
        spokeDecimals: spokeTokenDecimals[spoke.network][token.symbol],
        spokeToken: spokeTokenMap[spoke.network][token.symbol]
      });
    }

    await write(hubWallet, hubPublic, {
      address: riskManager,
      abi: riskAbi,
      functionName: "setRiskParamsFlat",
      args: [hubToken, riskBase[0], riskBase[1], riskBase[2], token.supplyCap, token.borrowCap]
    });

    await ensureMarketInitialized({
      hubWallet,
      hubPublic,
      moneyMarketAddress: moneyMarket,
      marketAbi,
      asset: hubToken
    });

    const feedCfg = resolveFeedConfig(HUB_DEFAULTS.envPrefix, token.symbol);
    await write(hubWallet, hubPublic, {
      address: oracle,
      abi: chainlinkOracleAbi,
      functionName: "setFeed",
      args: [hubToken, feedCfg.feed, feedCfg.heartbeat, feedCfg.minPriceE8, feedCfg.maxPriceE8]
    });
  }

  await write(hubWallet, hubPublic, {
    address: moneyMarket,
    abi: marketAbi,
    functionName: "setRiskManager",
    args: [riskManager]
  });
  await write(hubWallet, hubPublic, {
    address: moneyMarket,
    abi: marketAbi,
    functionName: "setSettlement",
    args: [settlement]
  });
  await write(hubWallet, hubPublic, {
    address: riskManager,
    abi: riskAbi,
    functionName: "setLockManager",
    args: [lockManager]
  });
  await write(hubWallet, hubPublic, {
    address: intentInbox,
    abi: inboxAbi,
    functionName: "setConsumer",
    args: [lockManager, true]
  });
  await write(hubWallet, hubPublic, {
    address: lockManager,
    abi: lockAbi,
    functionName: "setSettlement",
    args: [settlement]
  });

  const CANONICAL_BRIDGE_RECEIVER_ROLE = keccak256(stringToHex("CANONICAL_BRIDGE_RECEIVER_ROLE"));
  const SETTLEMENT_ROLE = keccak256(stringToHex("SETTLEMENT_ROLE"));
  const PROOF_FILL_ROLE = keccak256(stringToHex("PROOF_FILL_ROLE"));

  await write(hubWallet, hubPublic, {
    address: custody,
    abi: custodyAbi,
    functionName: "grantRole",
    args: [CANONICAL_BRIDGE_RECEIVER_ROLE, hubAcrossReceiver]
  });
  await write(hubWallet, hubPublic, {
    address: custody,
    abi: custodyAbi,
    functionName: "grantRole",
    args: [SETTLEMENT_ROLE, settlement]
  });
  await write(hubWallet, hubPublic, {
    address: settlement,
    abi: settlementAbi,
    functionName: "grantRole",
    args: [PROOF_FILL_ROLE, hubAcrossBorrowFinalizer]
  });

  await write(hubWallet, hubPublic, {
    address: hubAcrossBorrowDispatcher,
    abi: hubAcrossBorrowDispatcherAbi,
    functionName: "setAllowedCaller",
    args: [relayer.address, true]
  });

  for (const token of TOKEN_DEFS) {
    for (const spoke of spokeRuntime) {
      await write(hubWallet, hubPublic, {
        address: hubAcrossBorrowDispatcher,
        abi: hubAcrossBorrowDispatcherAbi,
        functionName: "setRoute",
        args: [
          hubTokens[token.symbol],
          BigInt(spoke.chainId),
          hubAcrossSpokePool,
          spokeTokenMap[spoke.network][token.symbol],
          spokeDeployments[spoke.network].borrowReceiver,
          relayer.address,
          300_000,
          0,
          true
        ]
      });
    }
  }

  const implementations = {
    hub: {
      tokenRegistry: tokenRegistryDeployment.implementation,
      rateModel: rateModelDeployment.implementation,
      moneyMarket: moneyMarketDeployment.implementation,
      riskManager: riskManagerDeployment.implementation,
      intentInbox: intentInboxDeployment.implementation,
      lockManager: lockManagerDeployment.implementation,
      custody: custodyDeployment.implementation,
      hubAcrossReceiver: hubAcrossReceiverDeployment.implementation,
      depositProofBackend: depositProofBackendDeployment.implementation,
      borrowFillProofBackend: borrowFillProofBackendDeployment.implementation,
      hubAcrossBorrowFinalizer: hubAcrossBorrowFinalizerDeployment.implementation,
      hubAcrossBorrowDispatcher: hubAcrossBorrowDispatcherDeployment.implementation,
      groth16VerifierAdapter: groth16VerifierAdapterDeployment.implementation,
      verifier: verifierDeployment.implementation,
      settlement: settlementDeployment.implementation
    },
    spokes: spokeImplementations
  };

  const deploymentJson = {
    deployedAt: new Date().toISOString(),
    liveMode: LIVE_MODE,
    hubNetwork: HUB_NETWORK,
    spokeNetworks: SPOKE_NETWORKS,
    implementations,
    hub: {
      chainId: HUB_CHAIN_ID,
      rpcUrl: HUB_RPC_URL,
      tokenRegistry,
      oracle,
      rateModel,
      moneyMarket,
      riskManager,
      intentInbox,
      lockManager,
      custody,
      hubAcrossReceiver,
      hubAcrossSpokePool,
      lightClientVerifier: lightClientVerifierAdapter,
      acrossDepositEventVerifier: acrossDepositEventVerifierAdapter,
      depositProofBackend,
      depositProofVerifier,
      acrossBorrowFillEventVerifier: acrossBorrowFillEventVerifierAdapter,
      borrowFillProofBackend,
      borrowFillProofVerifier,
      hubAcrossBorrowFinalizer,
      hubAcrossBorrowDispatcher,
      verifierDevMode: false,
      groth16Verifier: HUB_GROTH16_VERIFIER_ADDRESS,
      groth16VerifierAdapter,
      verifier,
      settlement
    },
    spokes: spokeDeployments,
    tokens: Object.fromEntries(
      TOKEN_DEFS.map((token) => [
        token.symbol,
        {
          hub: hubTokens[token.symbol],
          decimals: token.decimals,
          spokes: Object.fromEntries(spokeRuntime.map((spoke) => [spoke.network, spokeTokenMap[spoke.network][token.symbol]]))
        }
      ])
    ),
    operators: {
      deployer: deployer.address,
      relayer: relayer.address,
      bridge: bridge.address,
      prover: prover.address
    }
  };

  const deploymentPath = path.join(deploymentsDir, `live-${HUB_NETWORK}-hub-${SPOKE_NETWORKS.join("-")}.json`);
  fs.writeFileSync(deploymentPath, JSON.stringify(deploymentJson, null, 2));

  const spokeToHubMapByChain = Object.fromEntries(
    spokeRuntime.map((spoke) => [
      String(spoke.chainId),
      Object.fromEntries(TOKEN_DEFS.map((token) => [spokeTokenMap[spoke.network][token.symbol].toLowerCase(), hubTokens[token.symbol]]))
    ])
  );

  const firstSpokeNetwork = spokeRuntime[0]?.network;
  const defaultSpokeToHubMap = firstSpokeNetwork
    ? Object.fromEntries(
      TOKEN_DEFS.map((token) => [spokeTokenMap[firstSpokeNetwork][token.symbol].toLowerCase(), hubTokens[token.symbol]])
    )
    : {};

  const envLines = [
    `LIVE_MODE=1`,
    `HUB_NETWORK=${HUB_NETWORK}`,
    `${HUB_DEFAULTS.envPrefix}_RPC_URL=${HUB_RPC_URL}`,
    `${HUB_DEFAULTS.envPrefix}_CHAIN_ID=${HUB_CHAIN_ID}`,
    `HUB_CHAIN_ID=${HUB_CHAIN_ID}`,
    `SPOKE_NETWORKS=${SPOKE_NETWORKS.join(",")}`,
    `HUB_LOCK_MANAGER_ADDRESS=${lockManager}`,
    `HUB_SETTLEMENT_ADDRESS=${settlement}`,
    `HUB_CUSTODY_ADDRESS=${custody}`,
    `HUB_ACROSS_RECEIVER_ADDRESS=${hubAcrossReceiver}`,
    `HUB_ACROSS_SPOKE_POOL_ADDRESS=${hubAcrossSpokePool}`,
    `HUB_DEPOSIT_PROOF_BACKEND_ADDRESS=${depositProofBackend}`,
    `HUB_BORROW_FILL_PROOF_BACKEND_ADDRESS=${borrowFillProofBackend}`,
    `HUB_ACROSS_BORROW_FINALIZER_ADDRESS=${hubAcrossBorrowFinalizer}`,
    `HUB_ACROSS_BORROW_DISPATCHER_ADDRESS=${hubAcrossBorrowDispatcher}`,
    `SPOKE_TO_HUB_TOKEN_MAP=${JSON.stringify(defaultSpokeToHubMap)}`,
    `SPOKE_TO_HUB_TOKEN_MAP_BY_CHAIN=${JSON.stringify(spokeToHubMapByChain)}`,
    `NEXT_PUBLIC_PROTOCOL_CONFIG_JSON=${JSON.stringify(deploymentJson)}`
  ];

  for (const spoke of spokeRuntime) {
    envLines.push(`${spoke.envPrefix}_CHAIN_ID=${spoke.chainId}`);
    envLines.push(`${spoke.envPrefix}_RPC_URL=${spoke.rpcUrl}`);

    const dep = spokeDeployments[spoke.network];
    envLines.push(`SPOKE_${spoke.envPrefix}_PORTAL_ADDRESS=${dep.portal}`);
    envLines.push(`SPOKE_${spoke.envPrefix}_ACROSS_SPOKE_POOL_ADDRESS=${dep.acrossSpokePool}`);
    envLines.push(`SPOKE_${spoke.envPrefix}_BORROW_RECEIVER_ADDRESS=${dep.borrowReceiver}`);
  }

  const envPath = path.join(deploymentsDir, `live-${HUB_NETWORK}-hub-${SPOKE_NETWORKS.join("-")}.env`);
  fs.writeFileSync(envPath, `${envLines.join("\n")}\n`);

  const liveDeployLogPath = path.join(deploymentsDir, "live_deployed_contracts.log");
  appendActionLog(liveDeployLogPath, actionRows);
  writeManifest(manifestPath, manifest);

  const hubBalance = await hubPublic.getBalance({ address: deployer.address });
  console.log(`Deployment complete. Deployer hub balance: ${formatEther(hubBalance)} ${HUB_DEFAULTS.nativeSymbol}`);
  console.log(`- ${path.relative(rootDir, deploymentPath)}`);
  console.log(`- ${path.relative(rootDir, envPath)}`);
  console.log(`- ${path.relative(rootDir, manifestPath)}`);
  console.log(`- ${path.relative(rootDir, liveDeployLogPath)} (+${actionRows.length} rows)`);

  if (isProduction && !LIVE_MODE) {
    throw new Error("Production runtime requires LIVE_MODE=1 for deploy-live-multi");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
