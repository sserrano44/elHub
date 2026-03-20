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
  formatUnits,
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
const ALLOW_TENDERLY_RPC = (process.env.E2E_ALLOW_TENDERLY_RPC ?? process.env.ALLOW_TENDERLY_RPC ?? "0") !== "0";
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
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const user1UsdcSupplyUnits = process.env.E2E_USER1_USDC_SUPPLY ?? "10";
const user2WethSupplyUnits = process.env.E2E_USER2_WETH_SUPPLY ?? "0.0005";
const user2BorrowUsdcUnits = process.env.E2E_USER2_BORROW_USDC ?? "1";
const user2RepayBufferUsdcUnits = process.env.E2E_USER2_REPAY_BUFFER_USDC ?? "0.05";
const user2RepayDebtDustUsdcUnits = process.env.E2E_USER2_REPAY_DEBT_DUST_USDC ?? "0.001";
const user1WithdrawBps = Number(process.env.E2E_USER1_WITHDRAW_BPS ?? "9950");
const user2WithdrawBps = Number(process.env.E2E_USER2_WITHDRAW_BPS ?? "9950");
const maxUser1UsdcSupplyUnits = process.env.E2E_MAX_USER1_USDC ?? "20";
const maxUser2WethSupplyUnits = process.env.E2E_MAX_USER2_WETH ?? "0.002";
const maxUser2BorrowUsdcUnits = process.env.E2E_MAX_USER2_BORROW_USDC ?? "5";
const maxUser2RepayBufferUsdcUnits = process.env.E2E_MAX_USER2_REPAY_BUFFER_USDC ?? "1";
const relayerHubUsdcTopupUnits = process.env.E2E_RELAYER_HUB_USDC_TOPUP ?? "2";
const maxRelayerHubUsdcTopupUnits = process.env.E2E_MAX_RELAYER_HUB_USDC_TOPUP ?? "5";
const minHubDeployerEth = process.env.E2E_MIN_HUB_DEPLOYER_ETH ?? "0.001";
const minHubFinalizerEth = process.env.E2E_MIN_HUB_FINALIZER_ETH ?? "0.003";
const minWorldUserEth = process.env.E2E_MIN_WORLD_USER_ETH ?? "0.01";
const minBscUserEth = process.env.E2E_MIN_BSC_USER_ETH ?? "0.001";

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
  "event BorrowFillRecorded(bytes32 indexed intentId,uint8 indexed intentType,address indexed user,address recipient,address spokeToken,address hubAsset,uint256 amount,uint256 fee,address relayer,uint256 sourceChainId,uint256 destinationChainId,address hubDispatcher,address hubFinalizer,bytes32 messageHash)"
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
  "function reservedLiquidity(address asset) view returns (uint256)",
  "function locks(bytes32 intentId) view returns (bytes32 intentId,address user,uint8 intentType,address asset,uint256 amount,address relayer,uint256 lockTimestamp,uint256 expiry,uint8 status)",
  "function cancelLock(bytes32 intentId)"
]);

const children = [];
let isStopping = false;
let intentNonceCursor = BigInt(Date.now());

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

  if (!ALLOW_TENDERLY_RPC && (isTenderlyRpc(HUB_RPC_URL) || isTenderlyRpc(WORLD_RPC_URL) || isTenderlyRpc(BSC_RPC_URL))) {
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
        HUB_CHAIN_ID: String(HUB_CHAIN_ID),
        HUB_RPC_URL,
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
        ALLOW_TENDERLY_RPC: ALLOW_TENDERLY_RPC ? "1" : "0",
        E2E_ALLOW_TENDERLY_RPC: ALLOW_TENDERLY_RPC ? "1" : "0",
        HUB_GROTH16_VERIFIER_ADDRESS,
        HUB_LIGHT_CLIENT_VERIFIER_ADDRESS,
        HUB_ACROSS_DEPOSIT_EVENT_VERIFIER_ADDRESS,
        HUB_ACROSS_BORROW_FILL_EVENT_VERIFIER_ADDRESS,
        LIVE_DEPLOY_STRATEGY: process.env.E2E_LIVE_DEPLOY_STRATEGY ?? process.env.LIVE_DEPLOY_STRATEGY ?? "incremental",
        DEPLOY_MIN_DEPLOYER_GAS_ETH: process.env.DEPLOY_MIN_DEPLOYER_GAS_ETH ?? "0.003",
        DEPLOY_MIN_OPERATOR_GAS_ETH: process.env.DEPLOY_MIN_OPERATOR_GAS_ETH ?? "0.002",
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

  const hubDeployerWallet = createWalletClient({
    account: deployer,
    chain: hubChain,
    transport: http(deployments.hub.rpcUrl)
  });
  const worldDeployerWallet = createWalletClient({
    account: deployer,
    chain: worldChain,
    transport: http(deployments.spokes.worldchain.rpcUrl)
  });
  const bscDeployerWallet = createWalletClient({
    account: deployer,
    chain: bscChain,
    transport: http(deployments.spokes.bsc.rpcUrl)
  });
  const worldUser1Wallet = createWalletClient({
    account: user1,
    chain: worldChain,
    transport: http(deployments.spokes.worldchain.rpcUrl)
  });
  const worldUser2Wallet = createWalletClient({
    account: user2,
    chain: worldChain,
    transport: http(deployments.spokes.worldchain.rpcUrl)
  });
  const bscUser2Wallet = createWalletClient({
    account: user2,
    chain: bscChain,
    transport: http(deployments.spokes.bsc.rpcUrl)
  });

  await ensureNativeBalance(hubPublic, deployer.address, parseEther(minHubDeployerEth), "hub deployer");
  await ensureNativeBalance(worldPublic, user1.address, parseEther(minWorldUserEth), "world user1", {
    funderWalletClient: worldDeployerWallet,
    funderPublicClient: worldPublic,
    nativeSymbol: "ETH"
  });
  await ensureNativeBalance(worldPublic, user2.address, parseEther(minWorldUserEth), "world user2", {
    funderWalletClient: worldDeployerWallet,
    funderPublicClient: worldPublic,
    nativeSymbol: "ETH"
  });
  await ensureNativeBalance(bscPublic, user2.address, parseEther(minBscUserEth), "bsc user2", {
    funderWalletClient: bscDeployerWallet,
    funderPublicClient: bscPublic,
    nativeSymbol: "BNB"
  });

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
    ALLOW_TENDERLY_RPC: ALLOW_TENDERLY_RPC ? "1" : "0",
    E2E_ALLOW_TENDERLY_RPC: ALLOW_TENDERLY_RPC ? "1" : "0",
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
  const lockManager = deployments.hub.lockManager;
  const bscPortal = deployments.spokes.bsc.portal;
  const bscAcrossSpokePool = deployments.spokes.bsc.acrossSpokePool;

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
  const user2RepayBufferHubAmount = parseUnits(user2RepayBufferUsdcUnits, hubUsdcDecimals);
  const user2RepayDebtDustHubAmount = parseUnits(user2RepayDebtDustUsdcUnits, hubUsdcDecimals);
  const user2RepayBufferBscAmount = scaleAmountUnits(user2RepayBufferHubAmount, hubUsdcDecimals, bscUsdcDecimals);
  const relayerHubUsdcTopupAmount = parseUnits(relayerHubUsdcTopupUnits, hubUsdcDecimals);
  const maxUser1UsdcSupply = parseUnits(maxUser1UsdcSupplyUnits, worldUsdcDecimals);
  const maxUser2WethSupply = parseUnits(maxUser2WethSupplyUnits, worldWethDecimals);
  const maxUser2BorrowUsdc = parseUnits(maxUser2BorrowUsdcUnits, bscUsdcDecimals);
  const maxUser2RepayBufferHubAmount = parseUnits(maxUser2RepayBufferUsdcUnits, hubUsdcDecimals);
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
  if (user2RepayBufferHubAmount > maxUser2RepayBufferHubAmount) {
    throw new Error("USER2 repay buffer exceeds configured max-notional guardrail");
  }
  if (relayerHubUsdcTopupAmount > maxRelayerHubUsdcTopup) {
    throw new Error("Relayer top-up exceeds configured max-notional guardrail");
  }
  if (!Number.isFinite(user1WithdrawBps) || user1WithdrawBps <= 0 || user1WithdrawBps > 10_000) {
    throw new Error("E2E_USER1_WITHDRAW_BPS must be in range (0, 10000]");
  }
  if (!Number.isFinite(user2WithdrawBps) || user2WithdrawBps <= 0 || user2WithdrawBps > 10_000) {
    throw new Error("E2E_USER2_WITHDRAW_BPS must be in range (0, 10000]");
  }

  await ensureTokenBalance({
    publicClient: worldPublic,
    walletAddress: user1.address,
    tokenAddress: worldUsdc,
    minBalance: user1UsdcSupplyAmount,
    label: "USER1 world USDC supply",
    tokenSymbol: "USDC",
    tokenDecimals: worldUsdcDecimals,
    erc20Abi: ERC20Abi,
    funderWalletClient: worldDeployerWallet,
    funderPublicClient: worldPublic
  });

  const user2WorldNativeBalance = await worldPublic.getBalance({ address: user2.address });
  const user2WorldNativeRequired = parseEther(minWorldUserEth) + user2WethSupplyAmount;
  if (user2WorldNativeBalance < user2WorldNativeRequired) {
    await ensureNativeBalance(
      worldPublic,
      user2.address,
      user2WorldNativeRequired,
      "USER2 world native balance for WETH supply + gas reserve",
      {
        funderWalletClient: worldDeployerWallet,
        funderPublicClient: worldPublic,
        nativeSymbol: "ETH"
      }
    );
  }

  const evidence = {
    user1SupplyTx: "",
    user1AcrossSourceDepositId: "",
    user2SupplyTx: "",
    user2AcrossSourceDepositId: "",
    relayerLiquidityTopupTx: "",
    relayerLiquidityAcrossDepositId: "",
    user2BorrowDispatchTx: "",
    user2BorrowAcrossDepositId: "",
    user2BorrowFinalStatus: "",
    user2BorrowFillTx: "",
    user2BorrowFillAmount: "",
    user2BorrowFillFee: "",
    user2RepayTx: "",
    user2RepayAcrossDepositId: "",
    user2DebtBeforeRepay: "",
    user2DebtAfterRepay: "",
    user2RepayTopupTx: "",
    user2RepayTopupAcrossDepositId: "",
    user2RepayTopupAmount: "",
    user1WithdrawDispatchTx: "",
    user1WithdrawFinalStatus: "",
    user2WithdrawDispatchTx: "",
    user2WithdrawFinalStatus: ""
  };

  console.log(`[e2e-live] USER1 supply ${user1UsdcSupplyUnits} USDC from Worldchain`);
  const user1SupplyResult = await runInboundFromSpoke({
    label: "USER1 USDC supply",
    portalFunctionName: "initiateSupply",
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

  const user2SupplyResult = await runInboundFromSpoke({
    label: "USER2 WETH supply",
    portalFunctionName: "initiateSupply",
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
    sourceFunderWallet: worldDeployerWallet,
    sourceFunderPublic: worldPublic,
    sourceToken: worldUsdc,
    sourceTokenDecimals: worldUsdcDecimals,
    sourceTokenSymbol: "USDC",
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
  await ensureNativeBalance(
    hubPublic,
    deployer.address,
    parseEther(minHubFinalizerEth),
    "hub deployer (pre-borrow finalization)"
  );
  const borrowLogFromBlock = await bscPublic.getBlockNumber();

  console.log(`[e2e-live] USER2 borrow ${user2BorrowUsdcUnits} USDC to BSC`);
  const borrowSubmission = await submitOutboundIntent({
    label: "USER2 borrow",
    intentType: 3,
    amount: user2BorrowUsdcAmount,
    token: bscUsdc,
    userAccount: user2,
    spokeChainId: BigInt(deployments.spokes.bsc.chainId),
    hubChainId: Number(deployments.hub.chainId),
    intentInbox: deployments.hub.intentInbox,
    relayerApiUrl: RELAYER_API_URL
  });
  const borrowIntentId = borrowSubmission.intentId;
  const dispatchTx = borrowSubmission.dispatchTx;
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

  const borrowTerminalStatus = await waitForIntentTerminalStatus({
    indexerApiUrl: INDEXER_API_URL,
    intentId: borrowIntentId,
    acceptable: ["settled", "failed", "expired_unwound"],
    label: "borrow terminal status",
    timeoutMs: 900_000
  });
  evidence.user2BorrowFinalStatus = borrowTerminalStatus;

  if (borrowTerminalStatus !== "settled") {
    throw new Error(`USER2 borrow must settle for repay+withdraw flow, got ${borrowTerminalStatus}`);
  }

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

  const borrowExpectedNet = borrowFill.amount - borrowFill.fee;
  if (user2BscUsdcAfter - user2BscUsdcBefore < borrowExpectedNet) {
    throw new Error("expected USER2 BSC USDC balance increase from borrow fill");
  }

  const reservedDebtAfterBorrow = await hubPublic.readContract({
    abi: HubLockManagerOpsAbi,
    address: lockManager,
    functionName: "reservedDebt",
    args: [user2.address, usdcHub]
  });
  if (reservedDebtAfterBorrow !== 0n) {
    throw new Error(`borrow settled but reservedDebt > 0: ${reservedDebtAfterBorrow.toString()}`);
  }
  const reservedLiquidityAfterBorrow = await hubPublic.readContract({
    abi: HubLockManagerOpsAbi,
    address: lockManager,
    functionName: "reservedLiquidity",
    args: [usdcHub]
  });
  if (reservedLiquidityAfterBorrow !== 0n) {
    throw new Error(`borrow settled but reservedLiquidity > 0: ${reservedLiquidityAfterBorrow.toString()}`);
  }

  const user2DebtBeforeRepay = await hubPublic.readContract({
    abi: HubMoneyMarketAbi,
    address: moneyMarket,
    functionName: "getUserDebt",
    args: [user2.address, usdcHub]
  });
  evidence.user2DebtBeforeRepay = user2DebtBeforeRepay.toString();
  if (user2DebtBeforeRepay === 0n) {
    throw new Error("expected USER2 debt > 0 after settled borrow");
  }

  const repayTargetHubAmount = user2DebtBeforeRepay + user2RepayBufferHubAmount;
  const repayTargetBscAmount = scaleAmountUnits(repayTargetHubAmount, hubUsdcDecimals, bscUsdcDecimals);
  let user2BscUsdcForRepay = await bscPublic.readContract({
    abi: ERC20Abi,
    address: bscUsdc,
    functionName: "balanceOf",
    args: [user2.address]
  });
  if (user2BscUsdcForRepay < repayTargetBscAmount) {
    const topupResult = await ensureSpokeRecipientBalanceViaAcross({
      sourcePublic: worldPublic,
      destinationPublic: bscPublic,
      sourceWallet: worldUser1Wallet,
      sourceFunderWallet: worldDeployerWallet,
      sourceFunderPublic: worldPublic,
      sourceToken: worldUsdc,
      sourceTokenDecimals: worldUsdcDecimals,
      sourceTokenSymbol: "USDC",
      destinationToken: bscUsdc,
      sourceAcrossSpokePool: worldAcrossSpokePool,
      sourceChainId: BigInt(deployments.spokes.worldchain.chainId),
      destinationChainId: BigInt(deployments.spokes.bsc.chainId),
      recipient: user2.address,
      minDestinationBalance: repayTargetBscAmount,
      topupBufferAmount: user2RepayBufferBscAmount,
      erc20Abi: ERC20Abi,
      flowLabel: "USER2 repay top-up"
    });
    if (topupResult.txHash) {
      evidence.user2RepayTopupTx = topupResult.txHash;
      evidence.user2RepayTopupAcrossDepositId = topupResult.acrossDepositId;
      evidence.user2RepayTopupAmount = topupResult.inputAmount.toString();
    }
    user2BscUsdcForRepay = topupResult.balanceAfter;
  }
  if (user2BscUsdcForRepay < repayTargetBscAmount) {
    throw new Error(
      `USER2 BSC balance still below repay target after top-up: have ${user2BscUsdcForRepay.toString()} need ${repayTargetBscAmount.toString()}`
    );
  }

  console.log(
    `[e2e-live] USER2 repay target ${repayTargetBscAmount.toString()} BSC USDC (debt + buffer)`
  );
  const repayResult = await runInboundFromSpoke({
    label: "USER2 USDC repay",
    portalFunctionName: "initiateRepay",
    spokePublic: bscPublic,
    spokeWallet: bscUser2Wallet,
    portal: bscPortal,
    spokeToken: bscUsdc,
    hubToken: usdcHub,
    amount: repayTargetBscAmount,
    acrossSpokePool: bscAcrossSpokePool,
    destinationChainId: BigInt(deployments.hub.chainId),
    destinationReceiver: deployments.hub.hubAcrossReceiver,
    indexerApiUrl: INDEXER_API_URL,
    proverApiUrl: PROVER_API_URL,
    internalSecret: INTERNAL_API_AUTH_SECRET,
    erc20Abi: ERC20Abi,
    spokePortalAbi: SpokePortalAbi,
    sourceChainId: BigInt(deployments.spokes.bsc.chainId)
  });
  evidence.user2RepayTx = repayResult.txHash;
  evidence.user2RepayAcrossDepositId = repayResult.acrossDepositId;

  const user2DebtAfterRepay = await hubPublic.readContract({
    abi: HubMoneyMarketAbi,
    address: moneyMarket,
    functionName: "getUserDebt",
    args: [user2.address, usdcHub]
  });
  evidence.user2DebtAfterRepay = user2DebtAfterRepay.toString();
  if (user2DebtAfterRepay > user2RepayDebtDustHubAmount) {
    throw new Error(
      `expected USER2 debt <= dust after repay (${user2DebtAfterRepay.toString()} > ${user2RepayDebtDustHubAmount.toString()})`
    );
  }

  await stopChildren([stage.relayer, stage.prover]);

  console.log("[e2e-live] stage worldchain (withdraw): starting prover + relayer");
  stage = await startStageServices({
    name: WORLD_NETWORK,
    chainId: Number(deployments.spokes.worldchain.chainId),
    rpcUrl: deployments.spokes.worldchain.rpcUrl,
    relayerTrackingPath: path.join(dataDir, "relayer-worldchain-withdraw.json"),
    commonServiceEnv,
    spokeToHubMap: Object.fromEntries(
      Object.entries(deployments.tokens).map(([symbol, token]) => [token.spokes.worldchain.toLowerCase(), token.hub])
    )
  });

  const user1HubSupplyBeforeWithdraw = await hubPublic.readContract({
    abi: HubMoneyMarketAbi,
    address: moneyMarket,
    functionName: "getUserSupply",
    args: [user1.address, usdcHub]
  });
  if (user1HubSupplyBeforeWithdraw === 0n) {
    throw new Error("expected USER1 hub USDC supply > 0 before withdraw");
  }
  const user1WithdrawAmount = bpsAmount(user1HubSupplyBeforeWithdraw, user1WithdrawBps);
  if (user1WithdrawAmount === 0n) {
    throw new Error("USER1 withdraw amount resolved to zero");
  }
  const user1WorldUsdcBeforeWithdraw = await worldPublic.readContract({
    abi: ERC20Abi,
    address: worldUsdc,
    functionName: "balanceOf",
    args: [user1.address]
  });
  const user1WithdrawSubmission = await submitOutboundIntent({
    label: "USER1 withdraw USDC",
    intentType: 4,
    amount: user1WithdrawAmount,
    token: worldUsdc,
    userAccount: user1,
    spokeChainId: BigInt(deployments.spokes.worldchain.chainId),
    hubChainId: Number(deployments.hub.chainId),
    intentInbox: deployments.hub.intentInbox,
    relayerApiUrl: RELAYER_API_URL
  });
  evidence.user1WithdrawDispatchTx = user1WithdrawSubmission.dispatchTx;
  await postInternal(PROVER_API_URL, "/internal/flush", {}, INTERNAL_API_AUTH_SECRET);
  evidence.user1WithdrawFinalStatus = await waitForIntentTerminalStatus({
    indexerApiUrl: INDEXER_API_URL,
    intentId: user1WithdrawSubmission.intentId,
    acceptable: ["settled", "failed", "expired_unwound"],
    label: "USER1 withdraw terminal status",
    timeoutMs: 900_000
  });
  if (evidence.user1WithdrawFinalStatus !== "settled") {
    throw new Error(`expected USER1 withdraw settled status, got ${evidence.user1WithdrawFinalStatus}`);
  }
  const user1HubSupplyAfterWithdraw = await hubPublic.readContract({
    abi: HubMoneyMarketAbi,
    address: moneyMarket,
    functionName: "getUserSupply",
    args: [user1.address, usdcHub]
  });
  if (user1HubSupplyAfterWithdraw >= user1HubSupplyBeforeWithdraw) {
    throw new Error("expected USER1 hub supply to decrease after withdraw");
  }
  const user1WorldUsdcAfterWithdraw = await worldPublic.readContract({
    abi: ERC20Abi,
    address: worldUsdc,
    functionName: "balanceOf",
    args: [user1.address]
  });
  const user1WithdrawExpectedNet = user1WithdrawAmount - user1WithdrawSubmission.relayerFee;
  if (user1WorldUsdcAfterWithdraw - user1WorldUsdcBeforeWithdraw < user1WithdrawExpectedNet) {
    throw new Error("expected USER1 spoke USDC balance increase from withdraw fill");
  }

  const user2HubSupplyBeforeWithdraw = await hubPublic.readContract({
    abi: HubMoneyMarketAbi,
    address: moneyMarket,
    functionName: "getUserSupply",
    args: [user2.address, wethHub]
  });
  if (user2HubSupplyBeforeWithdraw === 0n) {
    throw new Error("expected USER2 hub WETH supply > 0 before withdraw");
  }
  const user2WithdrawAmount = bpsAmount(user2HubSupplyBeforeWithdraw, user2WithdrawBps);
  if (user2WithdrawAmount === 0n) {
    throw new Error("USER2 withdraw amount resolved to zero");
  }
  const user2WorldWethBeforeWithdraw = await worldPublic.readContract({
    abi: ERC20Abi,
    address: worldWeth,
    functionName: "balanceOf",
    args: [user2.address]
  });
  const user2WithdrawSubmission = await submitOutboundIntent({
    label: "USER2 withdraw WETH",
    intentType: 4,
    amount: user2WithdrawAmount,
    token: worldWeth,
    userAccount: user2,
    spokeChainId: BigInt(deployments.spokes.worldchain.chainId),
    hubChainId: Number(deployments.hub.chainId),
    intentInbox: deployments.hub.intentInbox,
    relayerApiUrl: RELAYER_API_URL
  });
  evidence.user2WithdrawDispatchTx = user2WithdrawSubmission.dispatchTx;
  await postInternal(PROVER_API_URL, "/internal/flush", {}, INTERNAL_API_AUTH_SECRET);
  evidence.user2WithdrawFinalStatus = await waitForIntentTerminalStatus({
    indexerApiUrl: INDEXER_API_URL,
    intentId: user2WithdrawSubmission.intentId,
    acceptable: ["settled", "failed", "expired_unwound"],
    label: "USER2 withdraw terminal status",
    timeoutMs: 900_000
  });
  if (evidence.user2WithdrawFinalStatus !== "settled") {
    throw new Error(`expected USER2 withdraw settled status, got ${evidence.user2WithdrawFinalStatus}`);
  }
  const user2HubSupplyAfterWithdraw = await hubPublic.readContract({
    abi: HubMoneyMarketAbi,
    address: moneyMarket,
    functionName: "getUserSupply",
    args: [user2.address, wethHub]
  });
  if (user2HubSupplyAfterWithdraw >= user2HubSupplyBeforeWithdraw) {
    throw new Error("expected USER2 hub supply to decrease after withdraw");
  }
  const user2WorldWethAfterWithdraw = await worldPublic.readContract({
    abi: ERC20Abi,
    address: worldWeth,
    functionName: "balanceOf",
    args: [user2.address]
  });
  const user2WithdrawExpectedNet = user2WithdrawAmount - user2WithdrawSubmission.relayerFee;
  if (user2WorldWethAfterWithdraw - user2WorldWethBeforeWithdraw < user2WithdrawExpectedNet) {
    throw new Error("expected USER2 spoke WETH balance increase from withdraw fill");
  }

  const reservedDebtAfter = await hubPublic.readContract({
    abi: HubLockManagerOpsAbi,
    address: lockManager,
    functionName: "reservedDebt",
    args: [user2.address, usdcHub]
  });
  if (reservedDebtAfter !== 0n) {
    throw new Error(`borrow terminal status left reservedDebt > 0: ${reservedDebtAfter.toString()}`);
  }

  const reservedLiquidityUsdcAfter = await hubPublic.readContract({
    abi: HubLockManagerOpsAbi,
    address: lockManager,
    functionName: "reservedLiquidity",
    args: [usdcHub]
  });
  if (reservedLiquidityUsdcAfter !== 0n) {
    throw new Error(`terminal status left USDC reservedLiquidity > 0: ${reservedLiquidityUsdcAfter.toString()}`);
  }
  const reservedLiquidityWethAfter = await hubPublic.readContract({
    abi: HubLockManagerOpsAbi,
    address: lockManager,
    functionName: "reservedLiquidity",
    args: [wethHub]
  });
  if (reservedLiquidityWethAfter !== 0n) {
    throw new Error(`terminal status left WETH reservedLiquidity > 0: ${reservedLiquidityWethAfter.toString()}`);
  }

  await stopChildren([stage.relayer, stage.prover]);

  console.log("[e2e-live] ==================================================");
  console.log("[e2e-live] PASS: Base hub live scenario (World supply + BSC borrow/repay + World withdraw)");
  console.log(
    `[e2e-live] checks: USER1 supplied ${user1UsdcSupplyUnits} USDC, USER2 supplied ${user2WethSupplyUnits} WETH, USER2 borrow+repay settled, USER1+USER2 withdraw settled, reserved debt/liquidity are zero`
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

async function runInboundFromSpoke({
  label,
  portalFunctionName,
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
    functionName: portalFunctionName,
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

async function submitOutboundIntent({
  label,
  intentType,
  amount,
  token,
  userAccount,
  spokeChainId,
  hubChainId,
  intentInbox,
  relayerApiUrl
}) {
  const quoteRes = await fetch(`${relayerApiUrl}/quote?intentType=${intentType}&amount=${amount.toString()}`);
  if (!quoteRes.ok) {
    throw new Error(`${label} quote failed: ${quoteRes.status} ${await quoteRes.text()}`);
  }
  const quote = await quoteRes.json();
  const relayerFee = BigInt(quote.fee);
  if (relayerFee >= amount) {
    throw new Error(`${label} relayer fee must be < intent amount (${relayerFee.toString()} >= ${amount.toString()})`);
  }

  const intent = {
    intentType,
    user: userAccount.address,
    inputChainId: spokeChainId,
    outputChainId: spokeChainId,
    inputToken: token,
    outputToken: token,
    amount,
    recipient: userAccount.address,
    maxRelayerFee: relayerFee,
    nonce: nextIntentNonce(),
    deadline: BigInt(Math.floor(Date.now() / 1000)) + 1800n
  };

  const signature = await userAccount.signTypedData({
    domain: {
      name: "ElHubIntentInbox",
      version: "1",
      chainId: hubChainId,
      verifyingContract: intentInbox
    },
    types: intentTypes,
    primaryType: "Intent",
    message: intent
  });

  const intentId = rawIntentId(intent);
  const submitRes = await fetch(`${relayerApiUrl}/intent/submit`, {
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
    throw new Error(`${label} submit failed: ${submitRes.status} ${await submitRes.text()}`);
  }
  const submitPayload = await submitRes.json();
  const dispatchTx = String(submitPayload.dispatchTx ?? "");
  if (!dispatchTx) {
    throw new Error(`${label} missing dispatchTx`);
  }

  return {
    intentId,
    dispatchTx,
    relayerFee
  };
}

async function waitForIntentTerminalStatus({ indexerApiUrl, intentId, acceptable, label, timeoutMs }) {
  let terminalStatus = "";
  await waitUntil(
    async () => {
      const res = await fetch(`${indexerApiUrl}/intents/${intentId}`);
      if (!res.ok) return false;
      const payload = await res.json();
      const status = String(payload.status ?? "");
      if (!status) return false;
      if (!acceptable.includes(status)) return false;
      terminalStatus = status;
      return true;
    },
    label,
    timeoutMs
  );
  return terminalStatus;
}

async function ensureSpokeRecipientBalanceViaAcross({
  sourcePublic,
  destinationPublic,
  sourceWallet,
  sourceFunderWallet,
  sourceFunderPublic,
  sourceToken,
  sourceTokenDecimals,
  sourceTokenSymbol,
  destinationToken,
  sourceAcrossSpokePool,
  sourceChainId,
  destinationChainId,
  recipient,
  minDestinationBalance,
  topupBufferAmount,
  erc20Abi,
  flowLabel
}) {
  const balanceBefore = await destinationPublic.readContract({
    abi: erc20Abi,
    address: destinationToken,
    functionName: "balanceOf",
    args: [recipient]
  });
  if (balanceBefore >= minDestinationBalance) {
    return {
      txHash: "",
      acrossDepositId: "",
      inputAmount: 0n,
      balanceBefore,
      balanceAfter: balanceBefore
    };
  }

  const shortfall = minDestinationBalance - balanceBefore;
  const inputAmount = shortfall + topupBufferAmount;
  const sourceBalance = await sourcePublic.readContract({
    abi: erc20Abi,
    address: sourceToken,
    functionName: "balanceOf",
    args: [sourceWallet.account.address]
  });
  if (sourceBalance < inputAmount) {
    await ensureTokenBalance({
      publicClient: sourcePublic,
      walletAddress: sourceWallet.account.address,
      tokenAddress: sourceToken,
      minBalance: inputAmount,
      label: `${flowLabel} source token`,
      tokenSymbol: sourceTokenSymbol,
      tokenDecimals: sourceTokenDecimals,
      erc20Abi,
      funderWalletClient: sourceFunderWallet,
      funderPublicClient: sourceFunderPublic ?? sourcePublic
    });
  }

  await writeAndWait(sourceWallet, sourcePublic, {
    abi: erc20Abi,
    address: sourceToken,
    functionName: "approve",
    args: [sourceAcrossSpokePool, inputAmount]
  });

  const quote = await fetchAcrossSuggestedFee({
    originChainId: sourceChainId,
    destinationChainId,
    inputToken: sourceToken,
    outputToken: destinationToken,
    amount: inputAmount,
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
      inputAmount,
      quote.outputAmount,
      destinationChainId,
      ZERO_ADDRESS,
      quote.quoteTimestamp,
      quote.fillDeadline,
      0,
      "0x"
    ]
  });

  const acrossMeta = await decodeAcrossFundsDeposited({
    sourcePublic,
    sourceAcrossSpokePool,
    sourceTxHash: txHash,
    expectedDestinationChainId: destinationChainId,
    flowLabel
  });

  await waitUntil(
    async () => {
      const current = await destinationPublic.readContract({
        abi: erc20Abi,
        address: destinationToken,
        functionName: "balanceOf",
        args: [recipient]
      });
      return current > balanceBefore;
    },
    `${flowLabel} fill`,
    900_000,
    5_000
  );

  const balanceAfter = await destinationPublic.readContract({
    abi: erc20Abi,
    address: destinationToken,
    functionName: "balanceOf",
    args: [recipient]
  });
  if (balanceAfter < minDestinationBalance) {
    throw new Error(
      `${flowLabel}: destination balance still below minimum after top-up (${balanceAfter.toString()} < ${minDestinationBalance.toString()})`
    );
  }

  return {
    txHash,
    acrossDepositId: acrossMeta.depositId.toString(),
    inputAmount,
    balanceBefore,
    balanceAfter
  };
}

async function ensureRelayerHubLiquidityViaAcross({
  hubPublic,
  sourcePublic,
  sourceWallet,
  sourceFunderWallet,
  sourceFunderPublic,
  sourceToken,
  sourceTokenDecimals,
  sourceTokenSymbol,
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
    await ensureTokenBalance({
      publicClient: sourcePublic,
      walletAddress: sourceWallet.account.address,
      tokenAddress: sourceToken,
      minBalance: topupInputAmount,
      label: "relayer top-up source token",
      tokenSymbol: sourceTokenSymbol,
      tokenDecimals: sourceTokenDecimals,
      erc20Abi,
      funderWalletClient: sourceFunderWallet,
      funderPublicClient: sourceFunderPublic ?? sourcePublic
    });
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
      "0x0000000000000000000000000000000000000000",
      quote.quoteTimestamp,
      quote.fillDeadline,
      0,
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
  const reservedBefore = await readReservedDebt({ hubPublic, lockManager, user, asset });
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

  let reservedAfter = await waitForReservedDebtAtMost({
    hubPublic,
    lockManager,
    user,
    asset,
    maxValue: 0n,
    attempts: 6,
    delayMs: 1_000
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
    reservedAfter = await waitForReservedDebtAtMost({
      hubPublic,
      lockManager,
      user,
      asset,
      maxValue: 0n,
      attempts: 8,
      delayMs: 1_500
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

async function readReservedDebt({ hubPublic, lockManager, user, asset }) {
  return hubPublic.readContract({
    abi: HubLockManagerOpsAbi,
    address: lockManager,
    functionName: "reservedDebt",
    args: [user, asset]
  });
}

async function waitForReservedDebtAtMost({ hubPublic, lockManager, user, asset, maxValue, attempts, delayMs }) {
  let current = await readReservedDebt({ hubPublic, lockManager, user, asset });
  for (let i = 0; i < attempts; i += 1) {
    if (current <= maxValue) return current;
    if (i + 1 < attempts) {
      await sleep(delayMs * (i + 1));
      current = await readReservedDebt({ hubPublic, lockManager, user, asset });
    }
  }
  return current;
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

  return {
    outputAmount,
    quoteTimestamp,
    fillDeadline,
    exclusivityDeadline: 0,
    exclusiveRelayer: ZERO_ADDRESS
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

function bpsAmount(amount, bps) {
  return amount * BigInt(bps) / 10_000n;
}

function nextIntentNonce() {
  intentNonceCursor += 1n;
  return intentNonceCursor;
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

async function ensureNativeBalance(publicClient, address, minBalanceWei, label, options = {}) {
  const current = await publicClient.getBalance({ address });
  if (current >= minBalanceWei) {
    return current;
  }

  const funderWalletClient = options.funderWalletClient;
  const funderPublicClient = options.funderPublicClient ?? publicClient;
  const nativeSymbol = options.nativeSymbol ?? "ETH";
  const shortfall = minBalanceWei - current;

  if (
    funderWalletClient
    && String(funderWalletClient.account.address).toLowerCase() !== String(address).toLowerCase()
  ) {
    const funderBalance = await funderPublicClient.getBalance({ address: funderWalletClient.account.address });
    if (funderBalance >= shortfall) {
      const txHash = await funderWalletClient.sendTransaction({
        account: funderWalletClient.account,
        to: address,
        value: shortfall
      });
      await funderPublicClient.waitForTransactionReceipt({ hash: txHash });
      const after = await publicClient.getBalance({ address });
      if (after >= minBalanceWei) {
        console.log(
          `[e2e-live] funded ${label} with ${formatEther(shortfall)} ${nativeSymbol} from deployer (tx=${txHash})`
        );
        return after;
      }
    }
  }

  throw new Error(
    `${label} has insufficient native balance (${formatEther(current)} < ${formatEther(minBalanceWei)})`
  );
}

async function ensureTokenBalance({
  publicClient,
  walletAddress,
  tokenAddress,
  minBalance,
  label,
  tokenSymbol,
  tokenDecimals,
  erc20Abi,
  funderWalletClient,
  funderPublicClient
}) {
  const current = await publicClient.readContract({
    abi: erc20Abi,
    address: tokenAddress,
    functionName: "balanceOf",
    args: [walletAddress]
  });
  if (current >= minBalance) {
    return current;
  }

  const shortfall = minBalance - current;
  if (
    funderWalletClient
    && String(funderWalletClient.account.address).toLowerCase() !== String(walletAddress).toLowerCase()
  ) {
    const sourceBalance = await publicClient.readContract({
      abi: erc20Abi,
      address: tokenAddress,
      functionName: "balanceOf",
      args: [funderWalletClient.account.address]
    });
    if (sourceBalance >= shortfall) {
      const txHash = await writeAndWait(funderWalletClient, funderPublicClient ?? publicClient, {
        abi: erc20Abi,
        address: tokenAddress,
        functionName: "transfer",
        args: [walletAddress, shortfall]
      });
      const after = await publicClient.readContract({
        abi: erc20Abi,
        address: tokenAddress,
        functionName: "balanceOf",
        args: [walletAddress]
      });
      if (after >= minBalance) {
        const formattedShortfall = typeof tokenDecimals === "number"
          ? formatUnits(shortfall, tokenDecimals)
          : shortfall.toString();
        console.log(
          `[e2e-live] funded ${label} with ${formattedShortfall} ${tokenSymbol ?? "token"} from deployer (tx=${txHash})`
        );
        return after;
      }
    }
  }

  throw new Error(
    `${label} is insufficient (have ${current.toString()} need ${minBalance.toString()})`
  );
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
