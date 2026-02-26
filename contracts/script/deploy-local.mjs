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
  parseEther,
  parseUnits,
  isAddress,
  formatEther,
  encodeFunctionData
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");
const contractsDir = path.resolve(rootDir, "contracts");
const outDir = path.resolve(contractsDir, "out");
const deploymentsDir = path.resolve(contractsDir, "deployments");

const NETWORK_DEFAULTS = {
  ethereum: { label: "Ethereum", envPrefix: "ETHEREUM", chainId: 1, rpcUrl: "http://127.0.0.1:8545" },
  base: { label: "Base", envPrefix: "BASE", chainId: 8453, rpcUrl: "http://127.0.0.1:9545" },
  bsc: { label: "BSC", envPrefix: "BSC", chainId: 56, rpcUrl: "" },
  worldchain: { label: "Worldchain", envPrefix: "WORLDCHAIN", chainId: 480, rpcUrl: "" }
};

const HUB_NETWORK = normalizeNetwork(process.env.HUB_NETWORK ?? "ethereum");
const HUB_NETWORK_CONFIG = NETWORK_DEFAULTS[HUB_NETWORK];
const HUB_ENV_PREFIX = HUB_NETWORK_CONFIG.envPrefix;
const HUB_RPC_URL =
  process.env.HUB_RPC_URL
  ?? process.env[`${HUB_ENV_PREFIX}_TENDERLY_RPC_URL`]
  ?? process.env[`${HUB_ENV_PREFIX}_RPC_URL`]
  ?? HUB_NETWORK_CONFIG.rpcUrl;
const HUB_CHAIN_ID = Number(process.env.HUB_CHAIN_ID ?? process.env[`${HUB_ENV_PREFIX}_CHAIN_ID`] ?? HUB_NETWORK_CONFIG.chainId);
const SPOKE_NETWORKS = String(process.env.SPOKE_NETWORKS ?? process.env.SPOKE_NETWORK ?? "base");
const SPOKE_NETWORK = normalizeNetwork(SPOKE_NETWORKS.split(",")[0]?.trim() || "base");
const SPOKE_ENV_PREFIX = SPOKE_NETWORK.toUpperCase();
const SPOKE_NETWORK_CONFIG = NETWORK_DEFAULTS[SPOKE_NETWORK];
const SPOKE_CHAIN_ID = Number(
  process.env[`${SPOKE_ENV_PREFIX}_CHAIN_ID`]
  ?? process.env[`SPOKE_${SPOKE_ENV_PREFIX}_CHAIN_ID`]
  ?? SPOKE_NETWORK_CONFIG.chainId
);
const SPOKE_RPC_URL =
  process.env[`${SPOKE_ENV_PREFIX}_TENDERLY_RPC_URL`]
  ?? process.env[`${SPOKE_ENV_PREFIX}_RPC_URL`]
  ?? process.env[`SPOKE_${SPOKE_ENV_PREFIX}_RPC_URL`]
  ?? SPOKE_NETWORK_CONFIG.rpcUrl;
const runtimeEnv = (process.env.ZKHUB_ENV ?? process.env.NODE_ENV ?? "development").toLowerCase();
const isProduction = runtimeEnv === "production";
const HUB_VERIFIER_DEV_MODE = (process.env.HUB_VERIFIER_DEV_MODE ?? "1") !== "0";
const HUB_DEV_PROOF_TEXT = process.env.HUB_DEV_PROOF_TEXT ?? "ZKHUB_DEV_PROOF";
const HUB_GROTH16_VERIFIER_ADDRESS = process.env.HUB_GROTH16_VERIFIER_ADDRESS ?? "";
const INTERNAL_API_AUTH_SECRET = process.env.INTERNAL_API_AUTH_SECRET ?? "dev-internal-auth-secret";

if (!Number.isInteger(SPOKE_CHAIN_ID) || SPOKE_CHAIN_ID <= 0) {
  throw new Error(
    `Invalid ${SPOKE_ENV_PREFIX}_CHAIN_ID for SPOKE_NETWORK=${SPOKE_NETWORK}: ${SPOKE_CHAIN_ID}`
  );
}
if (!SPOKE_RPC_URL) {
  throw new Error(
    `Missing ${SPOKE_ENV_PREFIX}_TENDERLY_RPC_URL or ${SPOKE_ENV_PREFIX}_RPC_URL for SPOKE_NETWORK=${SPOKE_NETWORK}`
  );
}
if (isProduction && HUB_VERIFIER_DEV_MODE) {
  throw new Error("HUB_VERIFIER_DEV_MODE must be 0 when ZKHUB_ENV/NODE_ENV is production");
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

const hubChain = defineChain({
  id: HUB_CHAIN_ID,
  name: "Ethereum Mainnet Local",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [HUB_RPC_URL] } }
});

const spokeChain = defineChain({
  id: SPOKE_CHAIN_ID,
  name: `${SPOKE_NETWORK_CONFIG.label} Local`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [SPOKE_RPC_URL] } }
});

const hubPublic = createPublicClient({ chain: hubChain, transport: http(HUB_RPC_URL) });
const spokePublic = createPublicClient({ chain: spokeChain, transport: http(SPOKE_RPC_URL) });
const hubWallet = createWalletClient({ account: deployer, chain: hubChain, transport: http(HUB_RPC_URL) });
const spokeWallet = createWalletClient({ account: deployer, chain: spokeChain, transport: http(SPOKE_RPC_URL) });
const bridgeHubWallet = createWalletClient({ account: bridge, chain: hubChain, transport: http(HUB_RPC_URL) });

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function loadArtifact(contractName) {
  const artifactPath = path.join(outDir, `${contractName}.sol`, `${contractName}.json`);
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Missing artifact ${artifactPath}. Run forge build first.`);
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  return {
    abi: artifact.abi,
    bytecode: artifact.bytecode.object
  };
}

async function deploy(client, publicClient, contractName, args = []) {
  const { abi, bytecode } = loadArtifact(contractName);
  const hash = await client.deployContract({ abi, bytecode, args, account: client.account });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress || !isAddress(receipt.contractAddress)) {
    throw new Error(`Deployment failed for ${contractName}`);
  }
  return receipt.contractAddress;
}

async function deployUUPS(client, publicClient, contractName, implementationArgs, initArgs = []) {
  const implementation = await deploy(client, publicClient, contractName, implementationArgs);
  const { abi } = loadArtifact(contractName);
  const data = encodeFunctionData({
    abi,
    functionName: "initializeProxy",
    args: initArgs
  });
  const proxy = await deploy(client, publicClient, "UUPSProxy", [implementation, data]);
  return { implementation, proxy, abi };
}

async function write(client, publicClient, { address, abi, functionName, args }) {
  const hash = await client.writeContract({ address, abi, functionName, args, account: client.account });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

async function ensureNativeBalance(walletClient, publicClient, target, minBalanceWei, label) {
  if (target.toLowerCase() === walletClient.account.address.toLowerCase()) return;

  const current = await publicClient.getBalance({ address: target });
  if (current >= minBalanceWei) return;

  const topUp = minBalanceWei - current;
  const senderBalance = await publicClient.getBalance({ address: walletClient.account.address });
  if (senderBalance <= topUp) {
    throw new Error(
      `Insufficient deployer balance to fund ${label}. ` +
      `needed=${formatEther(topUp)} ETH sender=${formatEther(senderBalance)} ETH`
    );
  }

  const tx = await walletClient.sendTransaction({
    to: target,
    value: topUp,
    account: walletClient.account
  });
  await publicClient.waitForTransactionReceipt({ hash: tx });
}

async function waitForChains() {
  for (let i = 0; i < 30; i++) {
    try {
      await Promise.all([hubPublic.getBlockNumber(), spokePublic.getBlockNumber()]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw new Error("Could not connect to local anvil nodes");
}

async function ensureContractCode(publicClient, address, label) {
  const code = await publicClient.getBytecode({ address });
  if (!code || code === "0x") {
    throw new Error(
      `${label} ${address} has no bytecode on HUB_RPC_URL=${HUB_RPC_URL}. ` +
      "Use a verifier deployed on this same chain/fork."
    );
  }
}

async function main() {
  await waitForChains();
  fs.mkdirSync(deploymentsDir, { recursive: true });

  // Ensure operator accounts can pay gas on both chains during E2E flows.
  const minOperatorGas = parseEther(process.env.E2E_MIN_OPERATOR_GAS_ETH ?? "0.05");
  await ensureNativeBalance(hubWallet, hubPublic, relayer.address, minOperatorGas, "hub relayer");
  await ensureNativeBalance(hubWallet, hubPublic, bridge.address, minOperatorGas, "hub bridge");
  await ensureNativeBalance(hubWallet, hubPublic, prover.address, minOperatorGas, "hub prover");
  await ensureNativeBalance(spokeWallet, spokePublic, relayer.address, minOperatorGas, "spoke relayer");
  await ensureNativeBalance(spokeWallet, spokePublic, bridge.address, minOperatorGas, "spoke bridge");
  await ensureNativeBalance(spokeWallet, spokePublic, prover.address, minOperatorGas, "spoke prover");

  console.log("Deploying hub tokens...");
  const hubWeth = await deploy(hubWallet, hubPublic, "MockERC20", ["Wrapped Ether", "WETH", 18]);
  const hubUsdc = await deploy(hubWallet, hubPublic, "MockERC20", ["USD Coin", "USDC", 6]);
  const hubWars = await deploy(hubWallet, hubPublic, "MockERC20", ["Wrapped ARS", "wARS", 18]);
  const hubWbrl = await deploy(hubWallet, hubPublic, "MockERC20", ["Wrapped BRL", "wBRL", 18]);

  console.log("Deploying spoke tokens...");
  const spokeWeth = await deploy(spokeWallet, spokePublic, "MockERC20", ["Wrapped Ether", "WETH", 18]);
  const spokeUsdc = await deploy(spokeWallet, spokePublic, "MockERC20", ["USD Coin", "USDC", 6]);
  const spokeWars = await deploy(spokeWallet, spokePublic, "MockERC20", ["Wrapped ARS", "wARS", 18]);
  const spokeWbrl = await deploy(spokeWallet, spokePublic, "MockERC20", ["Wrapped BRL", "wBRL", 18]);

  console.log("Deploying hub protocol (UUPS proxies)...");
  const tokenRegistryDeployment = await deployUUPS(
    hubWallet,
    hubPublic,
    "TokenRegistry",
    [deployer.address],
    [deployer.address]
  );
  const tokenRegistry = tokenRegistryDeployment.proxy;
  const oracle = await deploy(hubWallet, hubPublic, "MockOracle", [deployer.address]);
  const rateModelDeployment = await deployUUPS(
    hubWallet,
    hubPublic,
    "KinkInterestRateModel",
    [
      deployer.address,
      3_170_979_198_000_000_000n,
      6_341_958_396_000_000_000n,
      19_025_875_190_000_000_000n,
      800_000_000_000_000_000_000_000_000n,
      100_000_000_000_000_000_000_000_000n
    ],
    [
      deployer.address,
      3_170_979_198_000_000_000n,
      6_341_958_396_000_000_000n,
      19_025_875_190_000_000_000n,
      800_000_000_000_000_000_000_000_000n,
      100_000_000_000_000_000_000_000_000n
    ]
  );
  const rateModel = rateModelDeployment.proxy;
  const moneyMarketDeployment = await deployUUPS(hubWallet, hubPublic, "HubMoneyMarket", [
    deployer.address,
    tokenRegistry,
    rateModel
  ], [deployer.address]);
  const moneyMarket = moneyMarketDeployment.proxy;
  const riskManagerDeployment = await deployUUPS(hubWallet, hubPublic, "HubRiskManager", [
    deployer.address,
    tokenRegistry,
    moneyMarket,
    oracle
  ], [deployer.address]);
  const riskManager = riskManagerDeployment.proxy;
  const intentInboxDeployment = await deployUUPS(
    hubWallet,
    hubPublic,
    "HubIntentInbox",
    [deployer.address],
    [deployer.address]
  );
  const intentInbox = intentInboxDeployment.proxy;
  const lockManagerDeployment = await deployUUPS(hubWallet, hubPublic, "HubLockManager", [
    deployer.address,
    intentInbox,
    tokenRegistry,
    riskManager,
    moneyMarket
  ], [deployer.address]);
  const lockManager = lockManagerDeployment.proxy;
  const custodyDeployment = await deployUUPS(
    hubWallet,
    hubPublic,
    "HubCustody",
    [deployer.address],
    [deployer.address]
  );
  const custody = custodyDeployment.proxy;

  let groth16Verifier = ZERO_ADDRESS;
  let groth16VerifierAdapter = ZERO_ADDRESS;
  let groth16VerifierAdapterImplementation = ZERO_ADDRESS;
  let verifierImplementation = ZERO_ADDRESS;
  let verifier;

  if (HUB_VERIFIER_DEV_MODE) {
    const verifierDeployment = await deployUUPS(
      hubWallet,
      hubPublic,
      "Verifier",
      [
        deployer.address,
        true,
        keccak256(stringToHex(HUB_DEV_PROOF_TEXT)),
        ZERO_ADDRESS,
        4n
      ],
      [deployer.address, ZERO_ADDRESS]
    );
    verifier = verifierDeployment.proxy;
    verifierImplementation = verifierDeployment.implementation;
  } else {
    if (!isAddress(HUB_GROTH16_VERIFIER_ADDRESS) || HUB_GROTH16_VERIFIER_ADDRESS === ZERO_ADDRESS) {
      throw new Error("HUB_GROTH16_VERIFIER_ADDRESS must be set to deployed generated verifier when HUB_VERIFIER_DEV_MODE=0");
    }

    await ensureContractCode(hubPublic, HUB_GROTH16_VERIFIER_ADDRESS, "HUB_GROTH16_VERIFIER_ADDRESS");
    groth16Verifier = HUB_GROTH16_VERIFIER_ADDRESS;
    const groth16VerifierAdapterDeployment = await deployUUPS(
      hubWallet,
      hubPublic,
      "Groth16VerifierAdapter",
      [deployer.address, groth16Verifier],
      [deployer.address, groth16Verifier]
    );
    groth16VerifierAdapter = groth16VerifierAdapterDeployment.proxy;
    groth16VerifierAdapterImplementation = groth16VerifierAdapterDeployment.implementation;

    const verifierDeployment = await deployUUPS(
      hubWallet,
      hubPublic,
      "Verifier",
      [
        deployer.address,
        false,
        "0x0000000000000000000000000000000000000000000000000000000000000000",
        groth16VerifierAdapter,
        4n
      ],
      [deployer.address, groth16VerifierAdapter]
    );
    verifier = verifierDeployment.proxy;
    verifierImplementation = verifierDeployment.implementation;
  }

  const settlementDeployment = await deployUUPS(hubWallet, hubPublic, "HubSettlement", [
    deployer.address,
    verifier,
    moneyMarket,
    custody,
    lockManager
  ], [deployer.address, verifier, moneyMarket, custody, lockManager]);
  const settlement = settlementDeployment.proxy;
  const lightClientVerifier = await deploy(hubWallet, hubPublic, "MockLightClientVerifier", []);
  const acrossDepositEventVerifier = await deploy(hubWallet, hubPublic, "MockAcrossDepositEventVerifier", []);
  const depositProofBackendDeployment = await deployUUPS(hubWallet, hubPublic, "AcrossDepositProofBackend", [
    deployer.address,
    lightClientVerifier,
    acrossDepositEventVerifier
  ], [deployer.address]);
  const depositProofBackend = depositProofBackendDeployment.proxy;
  const depositProofVerifier = await deploy(hubWallet, hubPublic, "DepositProofVerifier", [depositProofBackend]);
  const acrossBorrowFillEventVerifier = await deploy(hubWallet, hubPublic, "MockAcrossBorrowFillEventVerifier", []);
  const borrowFillProofBackendDeployment = await deployUUPS(hubWallet, hubPublic, "AcrossBorrowFillProofBackend", [
    deployer.address,
    lightClientVerifier,
    acrossBorrowFillEventVerifier
  ], [deployer.address]);
  const borrowFillProofBackend = borrowFillProofBackendDeployment.proxy;
  const borrowFillProofVerifier = await deploy(hubWallet, hubPublic, "BorrowFillProofVerifier", [borrowFillProofBackend]);
  const hubAcrossBorrowFinalizerDeployment = await deployUUPS(hubWallet, hubPublic, "HubAcrossBorrowFinalizer", [
    deployer.address,
    settlement,
    borrowFillProofVerifier
  ], [deployer.address, borrowFillProofVerifier]);
  const hubAcrossBorrowFinalizer = hubAcrossBorrowFinalizerDeployment.proxy;
  const hubAcrossBorrowDispatcherDeployment = await deployUUPS(hubWallet, hubPublic, "HubAcrossBorrowDispatcher", [
    deployer.address,
    hubAcrossBorrowFinalizer
  ], [deployer.address, hubAcrossBorrowFinalizer]);
  const hubAcrossBorrowDispatcher = hubAcrossBorrowDispatcherDeployment.proxy;
  const hubAcrossSpokePool = await deploy(hubWallet, hubPublic, "MockAcrossSpokePool", []);
  const hubAcrossReceiverDeployment = await deployUUPS(hubWallet, hubPublic, "HubAcrossReceiver", [
    deployer.address,
    custody,
    depositProofVerifier,
    hubAcrossSpokePool
  ], [deployer.address, depositProofVerifier, hubAcrossSpokePool]);
  const hubAcrossReceiver = hubAcrossReceiverDeployment.proxy;

  console.log("Deploying spoke protocol (UUPS proxies)...");
  const spokePortalDeployment = await deployUUPS(spokeWallet, spokePublic, "SpokePortal", [deployer.address, BigInt(HUB_CHAIN_ID)], [deployer.address]);
  const spokePortal = spokePortalDeployment.proxy;
  const spokeAcrossSpokePool = await deploy(spokeWallet, spokePublic, "MockAcrossSpokePool", []);
  const spokeBorrowReceiverDeployment = await deployUUPS(spokeWallet, spokePublic, "SpokeAcrossBorrowReceiver", [
    deployer.address,
    spokeAcrossSpokePool
  ], [deployer.address, spokeAcrossSpokePool]);
  const spokeBorrowReceiver = spokeBorrowReceiverDeployment.proxy;
  const spokeBridgeAdapterDeployment = await deployUUPS(
    spokeWallet,
    spokePublic,
    "AcrossBridgeAdapter",
    [deployer.address, BigInt(HUB_CHAIN_ID)],
    [deployer.address]
  );
  const spokeBridgeAdapter = spokeBridgeAdapterDeployment.proxy;

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
  const erc20Abi = loadArtifact("MockERC20").abi;
  const oracleAbi = loadArtifact("MockOracle").abi;

  const bridgeAdapterId = keccak256(stringToHex("across-v3"));
  const riskBase = [7500n, 8000n, 10500n];

  const tokenRows = [
    { symbol: "WETH", hub: hubWeth, spoke: spokeWeth, decimals: 18, supplyCap: parseUnits("100000000", 18), borrowCap: parseUnits("80000000", 18), priceE8: 3500_00000000n },
    { symbol: "USDC", hub: hubUsdc, spoke: spokeUsdc, decimals: 6, supplyCap: parseUnits("100000000", 6), borrowCap: parseUnits("80000000", 6), priceE8: 1_00000000n },
    { symbol: "wARS", hub: hubWars, spoke: spokeWars, decimals: 18, supplyCap: parseUnits("100000000", 18), borrowCap: parseUnits("80000000", 18), priceE8: 1_00000000n },
    { symbol: "wBRL", hub: hubWbrl, spoke: spokeWbrl, decimals: 18, supplyCap: parseUnits("100000000", 18), borrowCap: parseUnits("80000000", 18), priceE8: 20_000000n }
  ];

  console.log("Configuring registry/risk/markets...");
  for (const row of tokenRows) {
    await write(hubWallet, hubPublic, {
      address: tokenRegistry,
      abi: tokenRegistryAbi,
      functionName: "setTokenBehavior",
      args: [row.hub, 1]
    });
    await write(hubWallet, hubPublic, {
      address: tokenRegistry,
      abi: tokenRegistryAbi,
      functionName: "setTokenBehavior",
      args: [row.spoke, 1]
    });

    await write(hubWallet, hubPublic, {
      address: tokenRegistry,
      abi: tokenRegistryAbi,
      functionName: "registerTokenFlat",
      args: [
        row.hub,
        row.spoke,
        row.decimals,
        riskBase[0],
        riskBase[1],
        riskBase[2],
        row.supplyCap,
        row.borrowCap,
        bridgeAdapterId,
        true
      ]
    });

    await write(hubWallet, hubPublic, {
      address: riskManager,
      abi: riskAbi,
      functionName: "setRiskParamsFlat",
      args: [row.hub, riskBase[0], riskBase[1], riskBase[2], row.supplyCap, row.borrowCap]
    });

    await write(hubWallet, hubPublic, {
      address: moneyMarket,
      abi: marketAbi,
      functionName: "initializeMarket",
      args: [row.hub]
    });

    await write(hubWallet, hubPublic, {
      address: oracle,
      abi: oracleAbi,
      functionName: "setPrice",
      args: [row.hub, row.priceE8]
    });
  }

  await write(hubWallet, hubPublic, { address: moneyMarket, abi: marketAbi, functionName: "setRiskManager", args: [riskManager] });
  await write(hubWallet, hubPublic, { address: moneyMarket, abi: marketAbi, functionName: "setSettlement", args: [settlement] });
  await write(hubWallet, hubPublic, { address: riskManager, abi: riskAbi, functionName: "setLockManager", args: [lockManager] });
  await write(hubWallet, hubPublic, { address: intentInbox, abi: inboxAbi, functionName: "setConsumer", args: [lockManager, true] });
  await write(hubWallet, hubPublic, { address: lockManager, abi: lockAbi, functionName: "setSettlement", args: [settlement] });

  const CANONICAL_BRIDGE_RECEIVER_ROLE = keccak256(stringToHex("CANONICAL_BRIDGE_RECEIVER_ROLE"));
  const SETTLEMENT_ROLE = keccak256(stringToHex("SETTLEMENT_ROLE"));
  const PROOF_FILL_ROLE = keccak256(stringToHex("PROOF_FILL_ROLE"));

  await write(hubWallet, hubPublic, {
    address: custody,
    abi: custodyAbi,
    functionName: "grantRole",
    args: [CANONICAL_BRIDGE_RECEIVER_ROLE, hubAcrossReceiver]
  });
  await write(hubWallet, hubPublic, { address: custody, abi: custodyAbi, functionName: "grantRole", args: [SETTLEMENT_ROLE, settlement] });
  await write(hubWallet, hubPublic, {
    address: settlement,
    abi: settlementAbi,
    functionName: "grantRole",
    args: [PROOF_FILL_ROLE, hubAcrossBorrowFinalizer]
  });

  await write(spokeWallet, spokePublic, { address: spokePortal, abi: portalAbi, functionName: "setBridgeAdapter", args: [spokeBridgeAdapter] });
  await write(spokeWallet, spokePublic, { address: spokePortal, abi: portalAbi, functionName: "setHubRecipient", args: [hubAcrossReceiver] });
  await write(spokeWallet, spokePublic, {
    address: spokeBridgeAdapter,
    abi: acrossBridgeAdapterAbi,
    functionName: "setAllowedCaller",
    args: [spokePortal, true]
  });
  for (const row of tokenRows) {
    await write(spokeWallet, spokePublic, {
      address: spokeBridgeAdapter,
      abi: acrossBridgeAdapterAbi,
      functionName: "setRoute",
      args: [row.spoke, spokeAcrossSpokePool, row.hub, ZERO_ADDRESS, 300_000, true]
    });
  }
  await write(hubWallet, hubPublic, {
    address: depositProofBackend,
    abi: depositProofBackendAbi,
    functionName: "setSourceSpokePool",
    args: [BigInt(SPOKE_CHAIN_ID), spokeAcrossSpokePool]
  });
  await write(hubWallet, hubPublic, {
    address: borrowFillProofBackend,
    abi: borrowFillProofBackendAbi,
    functionName: "setSourceReceiver",
    args: [BigInt(SPOKE_CHAIN_ID), spokeBorrowReceiver]
  });
  await write(hubWallet, hubPublic, {
    address: hubAcrossBorrowDispatcher,
    abi: hubAcrossBorrowDispatcherAbi,
    functionName: "setAllowedCaller",
    args: [relayer.address, true]
  });
  for (const row of tokenRows) {
    await write(hubWallet, hubPublic, {
      address: hubAcrossBorrowDispatcher,
      abi: hubAcrossBorrowDispatcherAbi,
      functionName: "setRoute",
      args: [row.hub, hubAcrossSpokePool, row.spoke, spokeBorrowReceiver, ZERO_ADDRESS, 300_000, true]
    });
  }

  console.log("Seeding liquidity + relayer inventory...");
  for (const row of tokenRows) {
    await write(hubWallet, hubPublic, {
      address: row.hub,
      abi: erc20Abi,
      functionName: "mint",
      args: [moneyMarket, parseUnits("1000000", row.decimals)]
    });
    await write(hubWallet, hubPublic, {
      address: row.hub,
      abi: erc20Abi,
      functionName: "mint",
      args: [custody, parseUnits("1000000", row.decimals)]
    });
    await write(hubWallet, hubPublic, {
      address: row.hub,
      abi: erc20Abi,
      functionName: "mint",
      args: [hubAcrossSpokePool, parseUnits("1000000", row.decimals)]
    });
    await write(hubWallet, hubPublic, {
      address: row.hub,
      abi: erc20Abi,
      functionName: "mint",
      args: [relayer.address, parseUnits("1000000", row.decimals)]
    });

    await write(spokeWallet, spokePublic, {
      address: row.spoke,
      abi: erc20Abi,
      functionName: "mint",
      args: [relayer.address, parseUnits("1000000", row.decimals)]
    });
    await write(spokeWallet, spokePublic, {
      address: row.spoke,
      abi: erc20Abi,
      functionName: "mint",
      args: [spokeAcrossSpokePool, parseUnits("1000000", row.decimals)]
    });
  }

  const deploymentJson = {
    implementations: {
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
        groth16VerifierAdapter: groth16VerifierAdapterImplementation,
        verifier: verifierImplementation,
        settlement: settlementDeployment.implementation
      },
      spoke: {
        portal: spokePortalDeployment.implementation,
        bridgeAdapter: spokeBridgeAdapterDeployment.implementation,
        borrowReceiver: spokeBorrowReceiverDeployment.implementation
      }
    },
    hub: {
      chainId: HUB_CHAIN_ID,
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
      lightClientVerifier,
      acrossDepositEventVerifier,
      depositProofBackend,
      depositProofVerifier,
      acrossBorrowFillEventVerifier,
      borrowFillProofBackend,
      borrowFillProofVerifier,
      hubAcrossBorrowFinalizer,
      hubAcrossBorrowDispatcher,
      verifierDevMode: HUB_VERIFIER_DEV_MODE,
      groth16Verifier,
      groth16VerifierAdapter,
      verifier,
      settlement
    },
    spoke: {
      network: SPOKE_NETWORK,
      chainId: SPOKE_CHAIN_ID,
      portal: spokePortal,
      bridgeAdapter: spokeBridgeAdapter,
      acrossSpokePool: spokeAcrossSpokePool,
      borrowReceiver: spokeBorrowReceiver
    },
    tokens: {
      WETH: { hub: hubWeth, spoke: spokeWeth, decimals: 18 },
      USDC: { hub: hubUsdc, spoke: spokeUsdc, decimals: 6 },
      wARS: { hub: hubWars, spoke: spokeWars, decimals: 18 },
      wBRL: { hub: hubWbrl, spoke: spokeWbrl, decimals: 18 }
    },
    operators: {
      deployer: deployer.address,
      relayer: relayer.address,
      bridge: bridge.address,
      prover: prover.address
    }
  };

  const spokeToHubMap = Object.fromEntries(
    tokenRows.map((row) => [row.spoke.toLowerCase(), row.hub])
  );

  fs.writeFileSync(path.join(deploymentsDir, "local.json"), JSON.stringify(deploymentJson, null, 2));

  const localEnv = `HUB_NETWORK=${HUB_NETWORK}
SPOKE_NETWORKS=${SPOKE_NETWORK}
HUB_RPC_URL=${HUB_RPC_URL}
SPOKE_RPC_URL=${SPOKE_RPC_URL}
HUB_CHAIN_ID=${HUB_CHAIN_ID}
SPOKE_CHAIN_ID=${SPOKE_CHAIN_ID}
SPOKE_NETWORK=${SPOKE_NETWORK}
${HUB_ENV_PREFIX}_CHAIN_ID=${HUB_CHAIN_ID}
${HUB_ENV_PREFIX}_RPC_URL=${HUB_RPC_URL}
${HUB_ENV_PREFIX}_TENDERLY_RPC_URL=${HUB_RPC_URL}
${SPOKE_ENV_PREFIX}_CHAIN_ID=${SPOKE_CHAIN_ID}
${SPOKE_ENV_PREFIX}_RPC_URL=${SPOKE_RPC_URL}
${SPOKE_ENV_PREFIX}_TENDERLY_RPC_URL=${SPOKE_RPC_URL}
SPOKE_${SPOKE_ENV_PREFIX}_RPC_URL=${SPOKE_RPC_URL}
SPOKE_${SPOKE_ENV_PREFIX}_CHAIN_ID=${SPOKE_CHAIN_ID}

HUB_LOCK_MANAGER_ADDRESS=${lockManager}
HUB_SETTLEMENT_ADDRESS=${settlement}
HUB_CUSTODY_ADDRESS=${custody}
HUB_ACROSS_RECEIVER_ADDRESS=${hubAcrossReceiver}
HUB_ACROSS_SPOKE_POOL_ADDRESS=${hubAcrossSpokePool}
HUB_LIGHT_CLIENT_VERIFIER_ADDRESS=${lightClientVerifier}
HUB_ACROSS_DEPOSIT_EVENT_VERIFIER_ADDRESS=${acrossDepositEventVerifier}
HUB_DEPOSIT_PROOF_BACKEND_ADDRESS=${depositProofBackend}
HUB_DEPOSIT_PROOF_VERIFIER_ADDRESS=${depositProofVerifier}
HUB_ACROSS_BORROW_EVENT_VERIFIER_ADDRESS=${acrossBorrowFillEventVerifier}
HUB_BORROW_FILL_PROOF_BACKEND_ADDRESS=${borrowFillProofBackend}
HUB_BORROW_FILL_PROOF_VERIFIER_ADDRESS=${borrowFillProofVerifier}
HUB_ACROSS_BORROW_FINALIZER_ADDRESS=${hubAcrossBorrowFinalizer}
HUB_ACROSS_BORROW_DISPATCHER_ADDRESS=${hubAcrossBorrowDispatcher}
SPOKE_PORTAL_ADDRESS=${spokePortal}
SPOKE_ACROSS_SPOKE_POOL_ADDRESS=${spokeAcrossSpokePool}
SPOKE_BORROW_RECEIVER_ADDRESS=${spokeBorrowReceiver}

RELAYER_PRIVATE_KEY=${RELAYER_PRIVATE_KEY}
BRIDGE_PRIVATE_KEY=${BRIDGE_PRIVATE_KEY}
PROVER_PRIVATE_KEY=${PROVER_PRIVATE_KEY}
RELAYER_BRIDGE_FINALITY_BLOCKS=0

SPOKE_TO_HUB_TOKEN_MAP=${JSON.stringify(spokeToHubMap)}

NEXT_PUBLIC_PROTOCOL_CONFIG_JSON=${JSON.stringify(deploymentJson)}
NEXT_PUBLIC_HUB_RPC_URL=${HUB_RPC_URL}
NEXT_PUBLIC_SPOKE_RPC_URL=${SPOKE_RPC_URL}
NEXT_PUBLIC_HUB_CHAIN_ID=${HUB_CHAIN_ID}
NEXT_PUBLIC_SPOKE_CHAIN_ID=${SPOKE_CHAIN_ID}
NEXT_PUBLIC_SPOKE_NETWORK=${SPOKE_NETWORK}
NEXT_PUBLIC_RELAYER_API_URL=http://127.0.0.1:3040
NEXT_PUBLIC_INDEXER_API_URL=http://127.0.0.1:3030
INTERNAL_API_AUTH_SECRET=${INTERNAL_API_AUTH_SECRET}
HUB_VERIFIER_DEV_MODE=${HUB_VERIFIER_DEV_MODE ? "1" : "0"}
HUB_DEV_PROOF_TEXT=${HUB_DEV_PROOF_TEXT}
HUB_GROTH16_VERIFIER_ADDRESS=${groth16Verifier}
HUB_GROTH16_VERIFIER_ADAPTER_ADDRESS=${groth16VerifierAdapter}
`;

  fs.writeFileSync(path.join(deploymentsDir, "local.env"), localEnv);

  const webDeploymentPath = path.join(rootDir, "apps", "web", "public", "deployments", "local.json");
  fs.mkdirSync(path.dirname(webDeploymentPath), { recursive: true });
  fs.writeFileSync(webDeploymentPath, JSON.stringify(deploymentJson, null, 2));

  const hubBalance = await hubPublic.getBalance({ address: deployer.address });
  console.log(`Deployment complete. Deployer hub balance: ${formatEther(hubBalance)} ETH`);
  console.log(`- deployments/local.json`);
  console.log(`- deployments/local.env`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

function normalizeNetwork(value) {
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "mainnet") return "ethereum";
  if (normalized === "bnb") return "bsc";
  if (normalized === "world") return "worldchain";
  if (normalized in NETWORK_DEFAULTS) return normalized;

  throw new Error(
    `Unsupported network=${value}. Use one of: ${Object.keys(NETWORK_DEFAULTS).join(", ")}`
  );
}
