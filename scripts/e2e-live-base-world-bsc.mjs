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

const NETWORKS = {
  ethereum: { envPrefix: "ETHEREUM", label: "Ethereum", defaultChainId: 1 },
  base: { envPrefix: "BASE", label: "Base", defaultChainId: 8453 },
  bsc: { envPrefix: "BSC", label: "BSC", defaultChainId: 56 },
  worldchain: { envPrefix: "WORLDCHAIN", label: "Worldchain", defaultChainId: 480 }
};

const LIVE_MODE = "1";
const HUB_NETWORK = "base";
const WORLD_NETWORK = "worldchain";
const BSC_NETWORK = "bsc";
const SPOKE_NETWORKS = `${WORLD_NETWORK},${BSC_NETWORK}`;

const HUB_CHAIN_ID = resolveNetworkChainId(HUB_NETWORK);
const WORLD_CHAIN_ID = resolveNetworkChainId(WORLD_NETWORK);
const BSC_CHAIN_ID = resolveNetworkChainId(BSC_NETWORK);

const HUB_RPC_URL = resolveNetworkRpc(HUB_NETWORK);
const WORLD_RPC_URL = resolveNetworkRpc(WORLD_NETWORK);
const BSC_RPC_URL = resolveNetworkRpc(BSC_NETWORK);

const INDEXER_PORT = Number(process.env.E2E_LIVE_INDEXER_PORT ?? "4130");
const RELAYER_PORT = Number(process.env.E2E_LIVE_RELAYER_PORT ?? "4140");
const PROVER_PORT = Number(process.env.E2E_LIVE_PROVER_PORT ?? "4150");
const INDEXER_API_URL = `http://127.0.0.1:${INDEXER_PORT}`;
const RELAYER_API_URL = `http://127.0.0.1:${RELAYER_PORT}`;
const PROVER_API_URL = `http://127.0.0.1:${PROVER_PORT}`;
const PROVER_BATCH_START = process.env.PROVER_BATCH_START ?? String(Math.floor(Date.now() / 1000));

const INTERNAL_API_AUTH_SECRET = resolveInternalAuthSecret();
const E2E_INTERNAL_CALLER_SERVICE = process.env.E2E_INTERNAL_CALLER_SERVICE ?? "e2e";

const DEFAULT_DEPLOYER_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const DEPLOYER_PRIVATE_KEY = resolveEnvValue("DEPLOYER_PRIVATE_KEY", DEFAULT_DEPLOYER_PRIVATE_KEY);
const RELAYER_PRIVATE_KEY = resolveEnvValue("RELAYER_PRIVATE_KEY", DEPLOYER_PRIVATE_KEY);
const BRIDGE_PRIVATE_KEY = resolveEnvValue("BRIDGE_PRIVATE_KEY", DEPLOYER_PRIVATE_KEY);
const PROVER_PRIVATE_KEY = resolveEnvValue("PROVER_PRIVATE_KEY", DEPLOYER_PRIVATE_KEY);
const USER1_PRIVATE_KEY = resolveEnvValue("USER1_PRIVATE_KEY", DEPLOYER_PRIVATE_KEY);
const USER2_PRIVATE_KEY = resolveEnvValue("USER2_PRIVATE_KEY", DEPLOYER_PRIVATE_KEY);
const HUB_GROTH16_VERIFIER_ADDRESS = resolveEnvValue("HUB_GROTH16_VERIFIER_ADDRESS");
const HUB_LIGHT_CLIENT_VERIFIER_ADDRESS = resolveEnvValue("HUB_LIGHT_CLIENT_VERIFIER_ADDRESS");
const HUB_ACROSS_DEPOSIT_EVENT_VERIFIER_ADDRESS = resolveEnvValue("HUB_ACROSS_DEPOSIT_EVENT_VERIFIER_ADDRESS");
const HUB_ACROSS_BORROW_FILL_EVENT_VERIFIER_ADDRESS = resolveEnvValue("HUB_ACROSS_BORROW_FILL_EVENT_VERIFIER_ADDRESS");

const deployer = privateKeyToAccount(DEPLOYER_PRIVATE_KEY);
const relayer = privateKeyToAccount(RELAYER_PRIVATE_KEY);
const user1 = privateKeyToAccount(USER1_PRIVATE_KEY);
const user2 = privateKeyToAccount(USER2_PRIVATE_KEY);

const user1UsdcSupplyUnits = process.env.E2E_USER1_USDC_SUPPLY ?? "10";
const user2WethSupplyUnits = process.env.E2E_USER2_WETH_SUPPLY ?? "0.0005";
const user2BorrowUsdcUnits = process.env.E2E_USER2_BORROW_USDC ?? "1";
const maxUser1UsdcSupplyUnits = process.env.E2E_MAX_USER1_USDC ?? "20";
const maxUser2WethSupplyUnits = process.env.E2E_MAX_USER2_WETH ?? "0.002";
const maxUser2BorrowUsdcUnits = process.env.E2E_MAX_USER2_BORROW_USDC ?? "5";
const relayerHubUsdcTopupUnits = process.env.E2E_RELAYER_HUB_USDC_TOPUP ?? "2";
const maxRelayerHubUsdcTopupUnits = process.env.E2E_MAX_RELAYER_HUB_USDC_TOPUP ?? "5";
const staleLockScanBlocks = BigInt(process.env.E2E_STALE_LOCK_SCAN_BLOCKS ?? "100000");
const minHubDeployerEth = process.env.E2E_MIN_HUB_DEPLOYER_ETH ?? "0.001";
const minWorldUserEth = process.env.E2E_MIN_WORLD_USER_ETH ?? "0.01";

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

const AcrossFundsDepositedEvent = parseAbiItem(
  "event FundsDeposited(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint256 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 indexed depositor, bytes32 recipient, bytes32 exclusiveRelayer, bytes message)"
);
const SpokeBorrowFillRecordedEvent = parseAbiItem(
  "event BorrowFillRecorded(bytes32 indexed intentId,uint8 indexed intentType,address indexed user,address recipient,address spokeToken,address hubAsset,uint256 amount,uint256 fee,address relayer,uint256 destinationChainId,address hubFinalizer,bytes32 messageHash)"
);
const HubBorrowLockedEvent = parseAbiItem(
  "event BorrowLocked(bytes32 indexed intentId,address indexed user,address indexed asset,uint256 amount,address relayer)"
);

const WETH9Abi = parseAbi([
  "function deposit() payable",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)"
]);
const ERC20Abi = parseAbi([
  "function approve(address spender,uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)"
]);
const AcrossSpokePoolAbi = parseAbi([
  "function depositV3(address depositor,address recipient,address inputToken,address outputToken,uint256 inputAmount,uint256 outputAmount,uint256 destinationChainId,address exclusiveRelayer,uint32 quoteTimestamp,uint32 fillDeadline,uint32 exclusivityDeadline,bytes message) payable"
]);
const HubLockManagerOpsAbi = parseAbi([
  "function reservedDebt(address user,address asset) view returns (uint256)",
  "function locks(bytes32 intentId) view returns (bytes32 intentId,address user,uint8 intentType,address asset,uint256 amount,address relayer,uint256 lockTimestamp,uint256 expiry,uint8 status)",
  "function cancelLock(bytes32 intentId)"
]);

const children = [];
let isStopping = false;

main().catch(async (error) => {
  console.error("[e2e-live] failed:", error);
  await stopAll();
  process.exit(1);
});

async function main() {
  const dataDir = path.join(rootDir, ".tmp", "e2e-live-base-world-bsc", String(Date.now()));
  fs.mkdirSync(dataDir, { recursive: true });

  assertWorkspaceLinks();
  assertRequiredLiveVerifiers();

  if (isTenderlyRpc(HUB_RPC_URL) || isTenderlyRpc(WORLD_RPC_URL) || isTenderlyRpc(BSC_RPC_URL)) {
    throw new Error("LIVE_MODE run forbids Tenderly RPC URLs");
  }

  console.log("[e2e-live] building contracts");
  await run("forge", ["build"], { cwd: contractsDir });

  console.log("[e2e-live] generating + building shared ABIs package");
  await run("pnpm", ["abis:generate"], { cwd: rootDir });
  await run("pnpm", ["--filter", "@elhub/abis", "build"], { cwd: rootDir });

  const deploymentPath = path.join(
    rootDir,
    "contracts",
    "deployments",
    `live-${HUB_NETWORK}-hub-${SPOKE_NETWORKS.split(",").join("-")}.json`
  );
  const envPath = path.join(
    rootDir,
    "contracts",
    "deployments",
    `live-${HUB_NETWORK}-hub-${SPOKE_NETWORKS.split(",").join("-")}.env`
  );
  const skipDeploy = (process.env.E2E_LIVE_SKIP_DEPLOY ?? "0") === "1";
  if (skipDeploy) {
    console.log("[e2e-live] skipping deploy (E2E_LIVE_SKIP_DEPLOY=1), reusing existing live deployment artifacts");
    if (!fs.existsSync(deploymentPath) || !fs.existsSync(envPath)) {
      throw new Error("E2E_LIVE_SKIP_DEPLOY=1 requires existing deployment json/env artifacts");
    }
  } else {
    console.log("[e2e-live] deploying/upgrading protocol (Base hub + Worldchain/BSC spokes)");
    await run("node", ["./contracts/script/deploy-live-multi.mjs"], {
      cwd: rootDir,
      env: {
        ...dotEnv,
        ...process.env,
        LIVE_MODE,
        HUB_NETWORK,
        SPOKE_NETWORKS,
        BASE_CHAIN_ID: String(HUB_CHAIN_ID),
        WORLDCHAIN_CHAIN_ID: String(WORLD_CHAIN_ID),
        BSC_CHAIN_ID: String(BSC_CHAIN_ID),
        BASE_RPC_URL: HUB_RPC_URL,
        WORLDCHAIN_RPC_URL: WORLD_RPC_URL,
        BSC_RPC_URL: BSC_RPC_URL,
        INTERNAL_API_AUTH_SECRET,
        DEPLOYER_PRIVATE_KEY,
        RELAYER_PRIVATE_KEY,
        BRIDGE_PRIVATE_KEY,
        PROVER_PRIVATE_KEY,
        HUB_GROTH16_VERIFIER_ADDRESS,
        HUB_LIGHT_CLIENT_VERIFIER_ADDRESS,
        HUB_ACROSS_DEPOSIT_EVENT_VERIFIER_ADDRESS,
        HUB_ACROSS_BORROW_FILL_EVENT_VERIFIER_ADDRESS,
        DEPLOY_MIN_DEPLOYER_GAS_ETH: process.env.DEPLOY_MIN_DEPLOYER_GAS_ETH ?? "0.003",
        DEPLOY_MIN_OPERATOR_GAS_ETH: process.env.DEPLOY_MIN_OPERATOR_GAS_ETH ?? "0.003",
        HUB_VERIFIER_DEV_MODE: "0"
      }
    });
  }

  const deployments = readJson(deploymentPath);
  const liveEnv = parseEnvFile(envPath);

  const hubChain = defineChain({
    id: Number(deployments.hub.chainId),
    name: "Base Hub",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [deployments.hub.rpcUrl] } }
  });
  const worldChain = defineChain({
    id: Number(deployments.spokes.worldchain.chainId),
    name: "Worldchain Spoke",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [deployments.spokes.worldchain.rpcUrl] } }
  });
  const bscChain = defineChain({
    id: Number(deployments.spokes.bsc.chainId),
    name: "BSC Spoke",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: { default: { http: [deployments.spokes.bsc.rpcUrl] } }
  });

  const hubPublic = createPublicClient({ chain: hubChain, transport: http(deployments.hub.rpcUrl) });
  const worldPublic = createPublicClient({ chain: worldChain, transport: http(deployments.spokes.worldchain.rpcUrl) });
  const bscPublic = createPublicClient({ chain: bscChain, transport: http(deployments.spokes.bsc.rpcUrl) });

  const hubDeployerWallet = createWalletClient({ account: deployer, chain: hubChain, transport: http(deployments.hub.rpcUrl) });
  const worldUser1Wallet = createWalletClient({ account: user1, chain: worldChain, transport: http(deployments.spokes.worldchain.rpcUrl) });
  const worldUser2Wallet = createWalletClient({ account: user2, chain: worldChain, transport: http(deployments.spokes.worldchain.rpcUrl) });

  await ensureNativeBalance(hubPublic, deployer.address, parseEther(minHubDeployerEth), "hub deployer");
  await ensureNativeBalance(worldPublic, user1.address, parseEther(minWorldUserEth), "world user1");
  await ensureNativeBalance(worldPublic, user2.address, parseEther(minWorldUserEth), "world user2");

  const SpokePortalAbi = readJson(path.join(rootDir, "packages", "abis", "src", "generated", "SpokePortal.json"));
  const HubMoneyMarketAbi = readJson(path.join(rootDir, "packages", "abis", "src", "generated", "HubMoneyMarket.json"));

  const commonServiceEnv = {
    ...dotEnv,
    ...process.env,
    ...liveEnv,
    LIVE_MODE,
    INTERNAL_API_AUTH_SECRET,
    HUB_NETWORK,
    HUB_CHAIN_ID: String(deployments.hub.chainId),
    HUB_RPC_URL: deployments.hub.rpcUrl,
    BASE_CHAIN_ID: String(deployments.hub.chainId),
    BASE_RPC_URL: deployments.hub.rpcUrl,
    WORLDCHAIN_CHAIN_ID: String(deployments.spokes.worldchain.chainId),
    WORLDCHAIN_RPC_URL: deployments.spokes.worldchain.rpcUrl,
    BSC_CHAIN_ID: String(deployments.spokes.bsc.chainId),
    BSC_RPC_URL: deployments.spokes.bsc.rpcUrl,
    DEPLOYER_PRIVATE_KEY,
    RELAYER_PRIVATE_KEY,
    BRIDGE_PRIVATE_KEY,
    PROVER_PRIVATE_KEY,
    PROVER_FUNDER_PRIVATE_KEY: DEPLOYER_PRIVATE_KEY,
    PROVER_MIN_NATIVE_ETH: process.env.PROVER_MIN_NATIVE_ETH ?? minHubDeployerEth,
    PROVER_MODE: process.env.PROVER_MODE ?? "circuit",
    INDEXER_PORT: String(INDEXER_PORT),
    RELAYER_PORT: String(RELAYER_PORT),
    PROVER_PORT: String(PROVER_PORT),
    INDEXER_API_URL,
    PROVER_API_URL,
    CORS_ALLOW_ORIGIN: process.env.CORS_ALLOW_ORIGIN ?? "https://localhost",
    INDEXER_DB_KIND: "sqlite",
    INDEXER_DB_PATH: path.join(dataDir, "indexer.db"),
    PROVER_STORE_KIND: "sqlite",
    PROVER_DB_PATH: path.join(dataDir, "prover.db"),
    PROVER_BATCH_START,
    RELAYER_INITIAL_BACKFILL_BLOCKS: "20",
    RELAYER_MAX_LOG_RANGE: "200",
    RELAYER_SPOKE_FINALITY_BLOCKS: process.env.RELAYER_SPOKE_FINALITY_BLOCKS ?? "6",
    RELAYER_HUB_FINALITY_BLOCKS: process.env.RELAYER_HUB_FINALITY_BLOCKS ?? "6"
  };

  console.log("[e2e-live] starting indexer");
  children.push(startService("indexer", ["--filter", "@elhub/indexer", "dev"], commonServiceEnv));
  await waitForHealth(`${INDEXER_API_URL}/health`);

  console.log("[e2e-live] stage worldchain: starting prover + relayer");
  let stage = await startStageServices({
    name: WORLD_NETWORK,
    chainId: Number(deployments.spokes.worldchain.chainId),
    rpcUrl: deployments.spokes.worldchain.rpcUrl,
    relayerTrackingPath: path.join(dataDir, "relayer-worldchain.json"),
    commonServiceEnv,
    spokeToHubMap: Object.fromEntries(
      Object.entries(deployments.tokens).map(([symbol, token]) => [token.spokes.worldchain.toLowerCase(), token.hub])
    )
  });

  const worldPortal = deployments.spokes.worldchain.portal;
  const worldAcrossSpokePool = deployments.spokes.worldchain.acrossSpokePool;
  const worldUsdc = deployments.tokens.USDC.spokes.worldchain;
  const worldWeth = deployments.tokens.WETH.spokes.worldchain;

  const usdcHub = deployments.tokens.USDC.hub;
  const wethHub = deployments.tokens.WETH.hub;
  const moneyMarket = deployments.hub.moneyMarket;

  const worldUsdcDecimals = Number(
    await worldPublic.readContract({ abi: ERC20Abi, address: worldUsdc, functionName: "decimals" })
  );
  const hubUsdcDecimals = Number(
    await hubPublic.readContract({ abi: ERC20Abi, address: usdcHub, functionName: "decimals" })
  );
  const worldWethDecimals = Number(
    await worldPublic.readContract({ abi: WETH9Abi, address: worldWeth, functionName: "decimals" })
  );
  const bscUsdc = deployments.tokens.USDC.spokes.bsc;
  const bscUsdcDecimals = Number(
    await bscPublic.readContract({ abi: ERC20Abi, address: bscUsdc, functionName: "decimals" })
  );

  const user1UsdcSupplyAmount = parseUnits(user1UsdcSupplyUnits, worldUsdcDecimals);
  const user2WethSupplyAmount = parseUnits(user2WethSupplyUnits, worldWethDecimals);
  const user2BorrowUsdcAmount = parseUnits(user2BorrowUsdcUnits, bscUsdcDecimals);
  const relayerHubUsdcTopupAmount = parseUnits(relayerHubUsdcTopupUnits, hubUsdcDecimals);
  const maxUser1UsdcSupply = parseUnits(maxUser1UsdcSupplyUnits, worldUsdcDecimals);
  const maxUser2WethSupply = parseUnits(maxUser2WethSupplyUnits, worldWethDecimals);
  const maxUser2BorrowUsdc = parseUnits(maxUser2BorrowUsdcUnits, bscUsdcDecimals);
  const maxRelayerHubUsdcTopup = parseUnits(maxRelayerHubUsdcTopupUnits, hubUsdcDecimals);
  const requiredRelayerHubUsdc = scaleAmountUnits(user2BorrowUsdcAmount, bscUsdcDecimals, hubUsdcDecimals);

  if (user1UsdcSupplyAmount > maxUser1UsdcSupply) {
    throw new Error("USER1 supply exceeds configured max-notional guardrail");
  }
  if (user2WethSupplyAmount > maxUser2WethSupply) {
    throw new Error("USER2 ETH supply exceeds configured max-notional guardrail");
  }
  if (user2BorrowUsdcAmount > maxUser2BorrowUsdc) {
    throw new Error("USER2 borrow exceeds configured max-notional guardrail");
  }
  if (relayerHubUsdcTopupAmount > maxRelayerHubUsdcTopup) {
    throw new Error("Relayer top-up exceeds configured max-notional guardrail");
  }

  const evidence = {
    user1SupplyTx: "",
    user1AcrossSourceDepositId: "",
    user2SupplyTx: "",
    user2AcrossSourceDepositId: "",
    relayerLiquidityTopupTx: "",
    relayerLiquidityAcrossDepositId: "",
    user2BorrowDispatchTx: "",
    user2BorrowAcrossDepositId: ""
  };

  console.log(`[e2e-live] USER1 supply ${user1UsdcSupplyUnits} USDC from Worldchain`);
  const user1SupplyResult = await runSupplyFromSpoke({
    label: "USER1 USDC supply",
    spokePublic: worldPublic,
    spokeWallet: worldUser1Wallet,
    portal: worldPortal,
    spokeToken: worldUsdc,
    hubToken: usdcHub,
    amount: user1UsdcSupplyAmount,
    acrossSpokePool: worldAcrossSpokePool,
    destinationChainId: BigInt(deployments.hub.chainId),
    destinationReceiver: deployments.hub.hubAcrossReceiver,
    indexerApiUrl: INDEXER_API_URL,
    proverApiUrl: PROVER_API_URL,
    internalSecret: INTERNAL_API_AUTH_SECRET,
    erc20Abi: ERC20Abi,
    spokePortalAbi: SpokePortalAbi,
    sourceChainId: BigInt(deployments.spokes.worldchain.chainId)
  });
  evidence.user1SupplyTx = user1SupplyResult.txHash;
  evidence.user1AcrossSourceDepositId = user1SupplyResult.acrossDepositId;

  console.log(`[e2e-live] USER2 supply ${user2WethSupplyUnits} ETH (WETH) from Worldchain`);
  await writeAndWait(worldUser2Wallet, worldPublic, {
    abi: WETH9Abi,
    address: worldWeth,
    functionName: "deposit",
    args: [],
    value: user2WethSupplyAmount
  });

  const user2SupplyResult = await runSupplyFromSpoke({
    label: "USER2 WETH supply",
    spokePublic: worldPublic,
    spokeWallet: worldUser2Wallet,
    portal: worldPortal,
    spokeToken: worldWeth,
    hubToken: wethHub,
    amount: user2WethSupplyAmount,
    acrossSpokePool: worldAcrossSpokePool,
    destinationChainId: BigInt(deployments.hub.chainId),
    destinationReceiver: deployments.hub.hubAcrossReceiver,
    indexerApiUrl: INDEXER_API_URL,
    proverApiUrl: PROVER_API_URL,
    internalSecret: INTERNAL_API_AUTH_SECRET,
    erc20Abi: ERC20Abi,
    spokePortalAbi: SpokePortalAbi,
    sourceChainId: BigInt(deployments.spokes.worldchain.chainId),
    skipMint: true
  });
  evidence.user2SupplyTx = user2SupplyResult.txHash;
  evidence.user2AcrossSourceDepositId = user2SupplyResult.acrossDepositId;

  await waitForUserSupply({
    hubPublic,
    moneyMarket,
    moneyMarketAbi: HubMoneyMarketAbi,
    user: user1.address,
    asset: usdcHub,
    label: "USER1 USDC"
  });

  await waitForUserSupply({
    hubPublic,
    moneyMarket,
    moneyMarketAbi: HubMoneyMarketAbi,
    user: user2.address,
    asset: wethHub,
    label: "USER2 WETH"
  });

  const relayerTopup = await ensureRelayerHubLiquidityViaAcross({
    hubPublic,
    sourcePublic: worldPublic,
    sourceWallet: worldUser1Wallet,
    sourceToken: worldUsdc,
    sourceAcrossSpokePool: worldAcrossSpokePool,
    destinationToken: usdcHub,
    sourceChainId: BigInt(deployments.spokes.worldchain.chainId),
    destinationChainId: BigInt(deployments.hub.chainId),
    recipient: relayer.address,
    minHubBalance: requiredRelayerHubUsdc,
    topupInputAmount: relayerHubUsdcTopupAmount,
    erc20Abi: ERC20Abi
  });
  if (relayerTopup.txHash) {
    evidence.relayerLiquidityTopupTx = relayerTopup.txHash;
    evidence.relayerLiquidityAcrossDepositId = relayerTopup.acrossDepositId;
  }

  await clearStaleBorrowLocks({
    hubPublic,
    hubWallet: hubDeployerWallet,
    lockManager: deployments.hub.lockManager,
    user: user2.address,
    asset: usdcHub,
    scanBlocks: staleLockScanBlocks
  });

  await stopChildren([stage.relayer, stage.prover]);

  console.log("[e2e-live] stage bsc: starting prover + relayer");
  stage = await startStageServices({
    name: BSC_NETWORK,
    chainId: Number(deployments.spokes.bsc.chainId),
    rpcUrl: deployments.spokes.bsc.rpcUrl,
    relayerTrackingPath: path.join(dataDir, "relayer-bsc.json"),
    commonServiceEnv,
    spokeToHubMap: Object.fromEntries(
      Object.entries(deployments.tokens).map(([symbol, token]) => [token.spokes.bsc.toLowerCase(), token.hub])
    )
  });

  const user2BscUsdcBefore = await bscPublic.readContract({
    abi: ERC20Abi,
    address: bscUsdc,
    functionName: "balanceOf",
    args: [user2.address]
  });
  const borrowLogFromBlock = await bscPublic.getBlockNumber();

  console.log(`[e2e-live] USER2 borrow ${user2BorrowUsdcUnits} USDC to BSC`);
  const quoteRes = await fetch(`${RELAYER_API_URL}/quote?intentType=3&amount=${user2BorrowUsdcAmount.toString()}`);
  if (!quoteRes.ok) {
    throw new Error(`quote failed: ${quoteRes.status} ${await quoteRes.text()}`);
  }
  const quote = await quoteRes.json();
  const relayerFee = BigInt(quote.fee);

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const borrowIntent = {
    intentType: 3,
    user: user2.address,
    inputChainId: BigInt(deployments.spokes.bsc.chainId),
    outputChainId: BigInt(deployments.spokes.bsc.chainId),
    inputToken: bscUsdc,
    outputToken: bscUsdc,
    amount: user2BorrowUsdcAmount,
    recipient: user2.address,
    maxRelayerFee: relayerFee,
    nonce: BigInt(Date.now()),
    deadline: nowSec + 1800n
  };

  const borrowSignature = await user2.signTypedData({
    domain: {
      name: "ElHubIntentInbox",
      version: "1",
      chainId: Number(deployments.hub.chainId),
      verifyingContract: deployments.hub.intentInbox
    },
    types: intentTypes,
    primaryType: "Intent",
    message: borrowIntent
  });

  const borrowIntentId = rawIntentId(borrowIntent);
  const submitRes = await fetch(`${RELAYER_API_URL}/intent/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      intent: {
        ...borrowIntent,
        inputChainId: borrowIntent.inputChainId.toString(),
        outputChainId: borrowIntent.outputChainId.toString(),
        amount: borrowIntent.amount.toString(),
        maxRelayerFee: borrowIntent.maxRelayerFee.toString(),
        nonce: borrowIntent.nonce.toString(),
        deadline: borrowIntent.deadline.toString()
      },
      signature: borrowSignature,
      relayerFee: relayerFee.toString()
    })
  });
  if (!submitRes.ok) {
    throw new Error(`borrow submit failed: ${submitRes.status} ${await submitRes.text()}`);
  }
  const submitPayload = await submitRes.json();
  const dispatchTx = submitPayload.dispatchTx;
  if (!dispatchTx) {
    throw new Error("missing dispatchTx for borrow");
  }
  evidence.user2BorrowDispatchTx = dispatchTx;

  const borrowAcrossMeta = await decodeAcrossFundsDeposited({
    sourcePublic: hubPublic,
    sourceAcrossSpokePool: deployments.hub.hubAcrossSpokePool,
    sourceTxHash: dispatchTx,
    expectedDestinationChainId: BigInt(deployments.spokes.bsc.chainId),
    flowLabel: "USER2 borrow"
  });
  evidence.user2BorrowAcrossDepositId = borrowAcrossMeta.depositId.toString();

  await postInternal(PROVER_API_URL, "/internal/flush", {}, INTERNAL_API_AUTH_SECRET);

  await waitUntil(
    async () => {
      const res = await fetch(`${INDEXER_API_URL}/intents/${borrowIntentId}`);
      if (!res.ok) return false;
      const payload = await res.json();
      return payload.status === "settled";
    },
    "borrow settlement",
    900_000
  );

  await waitUntil(
    async () => {
      const current = await hubPublic.readContract({
        abi: HubMoneyMarketAbi,
        address: moneyMarket,
        functionName: "getUserDebt",
        args: [user2.address, usdcHub]
      });
      return current > 0n;
    },
    "USER2 USDC debt after borrow settlement",
    180_000
  );

  const user2BscUsdcAfter = await bscPublic.readContract({
    abi: ERC20Abi,
    address: bscUsdc,
    functionName: "balanceOf",
    args: [user2.address]
  });
  const borrowFill = await waitForBorrowFillLog({
    bscPublic,
    borrowReceiver: deployments.spokes.bsc.borrowReceiver,
    intentId: borrowIntentId,
    fromBlock: borrowLogFromBlock
  });
  evidence.user2BorrowFillTx = borrowFill.txHash;
  evidence.user2BorrowFillAmount = borrowFill.amount.toString();
  evidence.user2BorrowFillFee = borrowFill.fee.toString();

  const expectedNet = borrowFill.amount - borrowFill.fee;
  if (user2BscUsdcAfter - user2BscUsdcBefore < expectedNet) {
    throw new Error("expected USER2 BSC USDC balance increase from borrow fill");
  }

  await stopChildren([stage.relayer, stage.prover]);

  console.log("[e2e-live] ==================================================");
  console.log("[e2e-live] PASS: Base hub live scenario (World supplies + BSC borrow)");
  console.log(
    `[e2e-live] checks: USER1 supplied ${user1UsdcSupplyUnits} USDC, USER2 supplied ${user2WethSupplyUnits} WETH, USER2 borrowed ${user2BorrowUsdcUnits} USDC on BSC`
  );
  console.log("[e2e-live] evidence:", JSON.stringify(evidence, null, 2));
  console.log("[e2e-live] ==================================================");

  await stopAll();
}

async function startStageServices({ name, chainId, rpcUrl, relayerTrackingPath, commonServiceEnv, spokeToHubMap }) {
  const stageEnv = {
    ...commonServiceEnv,
    LIVE_MODE,
    SPOKE_NETWORKS: name,
    SPOKE_NETWORK: name,
    SPOKE_CHAIN_ID: String(chainId),
    SPOKE_RPC_URL: rpcUrl,
    SPOKE_TO_HUB_TOKEN_MAP: JSON.stringify(spokeToHubMap),
    RELAYER_TRACKING_PATH: relayerTrackingPath
  };

  const config = NETWORKS[name];
  if (config) {
    stageEnv[`${config.envPrefix}_CHAIN_ID`] = String(chainId);
    stageEnv[`${config.envPrefix}_RPC_URL`] = rpcUrl;
    delete stageEnv[`${config.envPrefix}_TENDERLY_RPC_URL`];
  }

  const prover = startService("prover", ["--filter", "@elhub/prover", "dev"], stageEnv);
  const relayer = startService("relayer", ["--filter", "@elhub/relayer", "dev"], stageEnv);
  children.push(prover, relayer);

  await waitForHealth(`${PROVER_API_URL}/health`);
  await waitForHealth(`${RELAYER_API_URL}/health`);

  return { prover, relayer };
}

async function runSupplyFromSpoke({
  label,
  spokePublic,
  spokeWallet,
  portal,
  spokeToken,
  hubToken,
  amount,
  acrossSpokePool,
  destinationChainId,
  destinationReceiver,
  indexerApiUrl,
  proverApiUrl,
  internalSecret,
  erc20Abi,
  spokePortalAbi,
  sourceChainId,
  skipMint = false
}) {
  if (!skipMint) {
    const bal = await spokePublic.readContract({
      abi: erc20Abi,
      address: spokeToken,
      functionName: "balanceOf",
      args: [spokeWallet.account.address]
    });
    if (bal < amount) {
      throw new Error(`${label}: insufficient token balance ${bal.toString()} < ${amount.toString()}`);
    }
  }

  const nextDepositId = await spokePublic.readContract({
    abi: spokePortalAbi,
    address: portal,
    functionName: "nextDepositId"
  });

  await writeAndWait(spokeWallet, spokePublic, {
    abi: erc20Abi,
    address: spokeToken,
    functionName: "approve",
    args: [portal, amount]
  });

  const quote = await fetchAcrossSuggestedFee({
    originChainId: sourceChainId,
    destinationChainId,
    inputToken: spokeToken,
    outputToken: hubToken,
    amount,
    recipient: destinationReceiver
  });

  const txHash = await writeAndWait(spokeWallet, spokePublic, {
    abi: spokePortalAbi,
    address: portal,
    functionName: "initiateSupply",
    args: [spokeToken, amount, spokeWallet.account.address, quote]
  });

  const acrossMeta = await decodeAcrossFundsDeposited({
    sourcePublic: spokePublic,
    sourceAcrossSpokePool: acrossSpokePool,
    sourceTxHash: txHash,
    expectedDestinationChainId: destinationChainId,
    flowLabel: label
  });

  const depositId = Number(nextDepositId) + 1;
  await waitUntil(
    async () => {
      const res = await fetch(`${indexerApiUrl}/deposits/${sourceChainId.toString()}/${depositId}`);
      if (!res.ok) return false;
      const payload = await res.json();
      return payload.status === "pending_fill" || payload.status === "bridged" || payload.status === "settled";
    },
    `${label} pending_fill`,
    900_000
  );

  await waitUntil(
    async () => {
      const res = await fetch(`${indexerApiUrl}/deposits/${sourceChainId.toString()}/${depositId}`);
      if (!res.ok) return false;
      const payload = await res.json();
      return payload.status === "bridged" || payload.status === "settled";
    },
    `${label} proof finalization`,
    900_000
  );

  await postInternal(proverApiUrl, "/internal/flush", {}, internalSecret);

  await waitUntil(
    async () => {
      const res = await fetch(`${indexerApiUrl}/deposits/${sourceChainId.toString()}/${depositId}`);
      if (!res.ok) return false;
      const payload = await res.json();
      return payload.status === "settled";
    },
    `${label} settlement`,
    900_000
  );

  return {
    depositId,
    txHash,
    acrossDepositId: acrossMeta.depositId.toString(),
    acrossSourceTxHash: acrossMeta.txHash
  };
}

async function ensureRelayerHubLiquidityViaAcross({
  hubPublic,
  sourcePublic,
  sourceWallet,
  sourceToken,
  sourceAcrossSpokePool,
  destinationToken,
  sourceChainId,
  destinationChainId,
  recipient,
  minHubBalance,
  topupInputAmount,
  erc20Abi
}) {
  const balanceBefore = await hubPublic.readContract({
    abi: erc20Abi,
    address: destinationToken,
    functionName: "balanceOf",
    args: [recipient]
  });
  if (balanceBefore >= minHubBalance) {
    console.log(
      `[e2e-live] relayer hub liquidity already sufficient (${balanceBefore.toString()} >= ${minHubBalance.toString()})`
    );
    return { txHash: "", acrossDepositId: "", balanceBefore, balanceAfter: balanceBefore };
  }

  if (topupInputAmount <= 0n) {
    throw new Error("E2E_RELAYER_HUB_USDC_TOPUP must be > 0 when relayer hub liquidity is insufficient");
  }

  const sourceBalance = await sourcePublic.readContract({
    abi: erc20Abi,
    address: sourceToken,
    functionName: "balanceOf",
    args: [sourceWallet.account.address]
  });
  if (sourceBalance < topupInputAmount) {
    throw new Error(
      `insufficient source token balance for relayer top-up: have ${sourceBalance.toString()} need ${topupInputAmount.toString()}`
    );
  }

  console.log(
    `[e2e-live] topping up relayer hub liquidity via Across: ${topupInputAmount.toString()} source units`
  );

  await writeAndWait(sourceWallet, sourcePublic, {
    abi: erc20Abi,
    address: sourceToken,
    functionName: "approve",
    args: [sourceAcrossSpokePool, topupInputAmount]
  });

  const quote = await fetchAcrossSuggestedFee({
    originChainId: sourceChainId,
    destinationChainId,
    inputToken: sourceToken,
    outputToken: destinationToken,
    amount: topupInputAmount,
    recipient
  });

  const txHash = await writeAndWait(sourceWallet, sourcePublic, {
    abi: AcrossSpokePoolAbi,
    address: sourceAcrossSpokePool,
    functionName: "depositV3",
    args: [
      sourceWallet.account.address,
      recipient,
      sourceToken,
      destinationToken,
      topupInputAmount,
      quote.outputAmount,
      destinationChainId,
      quote.exclusiveRelayer,
      quote.quoteTimestamp,
      quote.fillDeadline,
      quote.exclusivityDeadline,
      "0x"
    ]
  });

  const acrossMeta = await decodeAcrossFundsDeposited({
    sourcePublic,
    sourceAcrossSpokePool,
    sourceTxHash: txHash,
    expectedDestinationChainId: destinationChainId,
    flowLabel: "relayer liquidity top-up"
  });

  await waitUntil(
    async () => {
      const current = await hubPublic.readContract({
        abi: erc20Abi,
        address: destinationToken,
        functionName: "balanceOf",
        args: [recipient]
      });
      return current > balanceBefore;
    },
    "Across relayer top-up fill",
    900_000,
    5_000
  );

  const balanceAfter = await hubPublic.readContract({
    abi: erc20Abi,
    address: destinationToken,
    functionName: "balanceOf",
    args: [recipient]
  });

  if (balanceAfter < minHubBalance) {
    throw new Error(
      `relayer hub liquidity still insufficient after Across top-up: have ${balanceAfter.toString()} need ${minHubBalance.toString()}`
    );
  }

  return {
    txHash,
    acrossDepositId: acrossMeta.depositId.toString(),
    balanceBefore,
    balanceAfter
  };
}

async function clearStaleBorrowLocks({ hubPublic, hubWallet, lockManager, user, asset, scanBlocks }) {
  const reservedBefore = await hubPublic.readContract({
    abi: HubLockManagerOpsAbi,
    address: lockManager,
    functionName: "reservedDebt",
    args: [user, asset]
  });
  if (reservedBefore === 0n) return;

  console.log(`[e2e-live] clearing stale borrow locks (reservedDebt=${reservedBefore.toString()})`);

  const latest = await hubPublic.getBlockNumber();
  const seen = new Set();
  let cancelled = await cancelActiveLocksInRange({
    hubPublic,
    hubWallet,
    lockManager,
    user,
    asset,
    fromBlock: latest > scanBlocks ? latest - scanBlocks : 0n,
    toBlock: latest,
    seen
  });

  let reservedAfter = await hubPublic.readContract({
    abi: HubLockManagerOpsAbi,
    address: lockManager,
    functionName: "reservedDebt",
    args: [user, asset]
  });

  if (reservedAfter > 0n && latest > scanBlocks) {
    console.log("[e2e-live] retrying stale lock cleanup from full history");
    cancelled += await cancelActiveLocksInRange({
      hubPublic,
      hubWallet,
      lockManager,
      user,
      asset,
      fromBlock: 0n,
      toBlock: latest,
      seen
    });
    reservedAfter = await hubPublic.readContract({
      abi: HubLockManagerOpsAbi,
      address: lockManager,
      functionName: "reservedDebt",
      args: [user, asset]
    });
  }

  if (reservedAfter > 0n) {
    throw new Error(
      `unable to clear stale borrow locks completely: reservedDebt=${reservedAfter.toString()}`
    );
  }

  if (cancelled > 0) {
    console.log(`[e2e-live] cancelled ${cancelled} stale borrow lock(s)`);
  }
}

async function cancelActiveLocksInRange({
  hubPublic,
  hubWallet,
  lockManager,
  user,
  asset,
  fromBlock,
  toBlock,
  seen
}) {
  const logs = await hubPublic.getLogs({
    address: lockManager,
    event: HubBorrowLockedEvent,
    args: { user, asset },
    fromBlock,
    toBlock
  });

  let cancelled = 0;
  for (const log of [...logs].reverse()) {
    const intentId = log.args.intentId;
    if (!intentId || seen.has(intentId)) continue;
    seen.add(intentId);

    const lock = await hubPublic.readContract({
      abi: HubLockManagerOpsAbi,
      address: lockManager,
      functionName: "locks",
      args: [intentId]
    });
    const status = Number((lock?.status ?? (Array.isArray(lock) ? lock[8] : 0)));
    if (status !== 1) continue;

    await writeAndWait(hubWallet, hubPublic, {
      abi: HubLockManagerOpsAbi,
      address: lockManager,
      functionName: "cancelLock",
      args: [intentId]
    });
    cancelled += 1;
  }
  return cancelled;
}

async function decodeAcrossFundsDeposited({
  sourcePublic,
  sourceAcrossSpokePool,
  sourceTxHash,
  expectedDestinationChainId,
  flowLabel
}) {
  const receipt = await sourcePublic.getTransactionReceipt({ hash: sourceTxHash });
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== sourceAcrossSpokePool.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: [AcrossFundsDepositedEvent],
        eventName: "FundsDeposited",
        data: log.data,
        topics: log.topics
      });

      const outputToken = bytes32ToAddress(decoded.args.outputToken);
      const recipient = bytes32ToAddress(decoded.args.recipient);
      if (!outputToken || !recipient) {
        throw new Error(`unable to decode Across bytes32 address fields for ${flowLabel}`);
      }

      if (decoded.args.destinationChainId !== expectedDestinationChainId) {
        throw new Error(
          `unexpected destination chain in ${flowLabel}. expected=${expectedDestinationChainId.toString()} got=${decoded.args.destinationChainId.toString()}`
        );
      }

      return {
        txHash: sourceTxHash,
        depositId: decoded.args.depositId,
        outputToken,
        outputAmount: decoded.args.outputAmount,
        destinationChainId: decoded.args.destinationChainId,
        recipient,
        message: decoded.args.message,
        logIndex: log.logIndex
      };
    } catch {
      // continue scanning logs
    }
  }

  throw new Error(`missing V3FundsDeposited log for ${flowLabel}`);
}

async function waitForBorrowFillLog({ bscPublic, borrowReceiver, intentId, fromBlock }) {
  let found;
  await waitUntil(
    async () => {
      const logs = await bscPublic.getLogs({
        address: borrowReceiver,
        event: SpokeBorrowFillRecordedEvent,
        args: { intentId },
        fromBlock
      });
      if (logs.length === 0) return false;

      const log = logs[logs.length - 1];
      const amount = parseBigint(log.args.amount);
      const fee = parseBigint(log.args.fee);
      if (amount === undefined || fee === undefined) return false;
      found = {
        txHash: log.transactionHash,
        amount,
        fee
      };
      return true;
    },
    "borrow fill recorded event",
    900_000
  );
  return found;
}

async function fetchAcrossSuggestedFee({ originChainId, destinationChainId, inputToken, outputToken, amount, recipient }) {
  const apiBase = resolveEnvValue("ACROSS_API_URL", "https://app.across.to/api").replace(/\/+$/, "");
  const allowUnmatchedDecimals = resolveEnvValue("ACROSS_ALLOW_UNMATCHED_DECIMALS", "1") !== "0";
  const search = new URLSearchParams({
    originChainId: originChainId.toString(),
    destinationChainId: destinationChainId.toString(),
    inputToken,
    outputToken,
    amount: amount.toString(),
    recipient
  });
  if (allowUnmatchedDecimals) {
    search.set("allowUnmatchedDecimals", "true");
  }

  const res = await fetch(`${apiBase}/suggested-fees?${search.toString()}`);
  if (!res.ok) {
    throw new Error(`Across suggested-fees failed: ${res.status} ${await res.text()}`);
  }

  const payload = await res.json();
  const outputAmount = parseBigint(payload.outputAmount)
    ?? parseBigint(payload.expectedOutputAmount)
    ?? parseBigint(payload.estimatedFillAmount)
    ?? parseBigint(payload.amountToReceive)
    ?? deriveOutputFromFee(payload, amount)
    ?? amount;

  const quoteTimestamp = Number(payload.quoteTimestamp ?? payload.timestamp ?? Math.floor(Date.now() / 1000));
  const fillDeadline = Number(payload.fillDeadline ?? quoteTimestamp + 2 * 60 * 60);
  const exclusivityDeadline = Number(payload.exclusivityDeadline ?? 0);
  const exclusiveRelayer = isAddress(payload.exclusiveRelayer)
    ? payload.exclusiveRelayer
    : "0x0000000000000000000000000000000000000000";

  return {
    outputAmount,
    quoteTimestamp,
    fillDeadline,
    exclusivityDeadline,
    exclusiveRelayer
  };
}

async function waitForUserSupply({ hubPublic, moneyMarket, moneyMarketAbi, user, asset, label }) {
  await waitUntil(
    async () => {
      const current = await hubPublic.readContract({
        abi: moneyMarketAbi,
        address: moneyMarket,
        functionName: "getUserSupply",
        args: [user, asset]
      });
      return current > 0n;
    },
    `${label} hub supply credit`,
    120_000
  );
}

function deriveOutputFromFee(payload, amount) {
  const total = parseBigint(payload?.totalRelayFee?.total);
  if (total === undefined) return undefined;
  if (total > amount) return undefined;
  return amount - total;
}

function parseBigint(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string" && value.length > 0) {
    try {
      return BigInt(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function scaleAmountUnits(amount, fromDecimals, toDecimals) {
  if (fromDecimals === toDecimals) return amount;
  if (fromDecimals > toDecimals) {
    return amount / 10n ** BigInt(fromDecimals - toDecimals);
  }
  return amount * 10n ** BigInt(toDecimals - fromDecimals);
}

function isAddress(value) {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function bytes32ToAddress(value) {
  if (typeof value !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(value)) return undefined;
  return `0x${value.slice(-40)}`;
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
    "Workspace package links are missing.\n" +
      "Run `pnpm install` at repository root, then retry.\n" +
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
    if (code !== 0 && code !== 143 && signal !== "SIGTERM") {
      console.error(`[${name}] exited unexpectedly (code=${code}, signal=${signal ?? "none"})`);
    }
  });

  return child;
}

async function stopChildren(targets) {
  const waiters = [];
  for (const child of targets) {
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

async function stopAll() {
  isStopping = true;
  await stopChildren(children);
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

async function ensureNativeBalance(publicClient, address, minBalanceWei, label) {
  const current = await publicClient.getBalance({ address });
  if (current < minBalanceWei) {
    throw new Error(
      `${label} has insufficient native balance (${formatEther(current)} < ${formatEther(minBalanceWei)})`
    );
  }
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
      (value.startsWith('"') && value.endsWith('"'))
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

function resolveInternalAuthSecret() {
  const configured = (process.env.INTERNAL_API_AUTH_SECRET ?? dotEnv.INTERNAL_API_AUTH_SECRET ?? "").trim();
  if (configured && configured !== "dev-internal-auth-secret") {
    return configured;
  }
  const nonce = `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  return `e2e-live-${createHash("sha256").update(nonce).digest("hex")}`;
}

function assertRequiredLiveVerifiers() {
  const required = [
    "HUB_GROTH16_VERIFIER_ADDRESS",
    "HUB_LIGHT_CLIENT_VERIFIER_ADDRESS",
    "HUB_ACROSS_DEPOSIT_EVENT_VERIFIER_ADDRESS",
    "HUB_ACROSS_BORROW_FILL_EVENT_VERIFIER_ADDRESS"
  ];
  for (const key of required) {
    if (!resolveEnvValue(key).trim()) {
      throw new Error(`Missing ${key} in environment/.env for live e2e run`);
    }
  }
}

function normalizeNetwork(value) {
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "mainnet") return "ethereum";
  if (normalized === "world") return "worldchain";
  if (normalized === "bnb") return "bsc";
  if (normalized in NETWORKS) return normalized;

  throw new Error(`Unsupported network=${value}. Use one of: ${Object.keys(NETWORKS).join(", ")}`);
}

function resolveNetworkChainId(network) {
  const config = NETWORKS[normalizeNetwork(network)];
  return Number(resolveEnvValue(`${config.envPrefix}_CHAIN_ID`, String(config.defaultChainId)));
}

function resolveNetworkRpc(network) {
  const config = NETWORKS[normalizeNetwork(network)];
  const rpc = resolveEnvValue(`${config.envPrefix}_RPC_URL`, "");
  if (!rpc) {
    throw new Error(`Missing ${config.envPrefix}_RPC_URL`);
  }
  return rpc;
}

function isTenderlyRpc(url) {
  return typeof url === "string" && url.includes("tenderly.co");
}
