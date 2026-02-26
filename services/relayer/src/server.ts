import fs from "node:fs";
import path from "node:path";
import { createHash, createHmac, randomUUID } from "node:crypto";
import express from "express";
import { z } from "zod";
import {
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  decodeEventLog,
  defineChain,
  encodeAbiParameters,
  http,
  keccak256,
  parseAbi,
  parseAbiItem,
  type Address,
  type Hex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HubLockManagerAbi } from "@elhub/abis";

type RequestWithMeta = express.Request & { requestId?: string };
type Intent = {
  intentType: IntentType;
  user: Address;
  inputChainId: bigint;
  outputChainId: bigint;
  inputToken: Address;
  outputToken: Address;
  amount: bigint;
  recipient: Address;
  maxRelayerFee: bigint;
  nonce: bigint;
  deadline: bigint;
};

type AcrossQuoteParams = {
  outputAmount: bigint;
  quoteTimestamp: number;
  fillDeadline: number;
  exclusivityDeadline: number;
  exclusiveRelayer: Address;
};

enum IntentType {
  SUPPLY = 1,
  REPAY = 2,
  BORROW = 3,
  WITHDRAW = 4
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const NETWORKS = {
  ethereum: { envPrefix: "ETHEREUM", defaultChainId: 1 },
  base: { envPrefix: "BASE", defaultChainId: 8453 },
  bsc: { envPrefix: "BSC", defaultChainId: 56 },
  worldchain: { envPrefix: "WORLDCHAIN", defaultChainId: 480 }
} as const;
type NetworkName = keyof typeof NETWORKS;

const runtimeEnv = (process.env.ZKHUB_ENV ?? process.env.NODE_ENV ?? "development").toLowerCase();
const isProduction = runtimeEnv === "production";
const isLiveMode = (process.env.LIVE_MODE ?? "0") !== "0";
const corsAllowOrigin = process.env.CORS_ALLOW_ORIGIN ?? "*";
const internalAuthSecret =
  process.env.INTERNAL_API_AUTH_SECRET
  ?? (isProduction ? "" : "dev-internal-auth-secret");
const internalCallerHeader = "x-elhub-internal-service";
const internalServiceName = process.env.INTERNAL_API_SERVICE_NAME?.trim() || "relayer";

const app = express();
app.set("json replacer", (_key: string, value: unknown) => (
  typeof value === "bigint" ? value.toString() : value
));
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  const requestId = req.header("x-request-id")?.trim() || randomUUID();
  (req as RequestWithMeta).requestId = requestId;
  res.setHeader("x-request-id", requestId);
  next();
});
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", corsAllowOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type,x-request-id");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

const port = Number(process.env.RELAYER_PORT ?? 3040);
const hubNetwork = normalizeNetwork(process.env.HUB_NETWORK ?? "ethereum");
const spokeNetwork = resolveSpokeNetwork(process.env.SPOKE_NETWORKS ?? process.env.SPOKE_NETWORK ?? "base");
const hubConfig = NETWORKS[hubNetwork];
const spokeConfig = NETWORKS[spokeNetwork];
const hubRpc = process.env.HUB_RPC_URL ?? resolveNetworkRpc(hubNetwork, "http://127.0.0.1:8545");
const spokeRpc = process.env.SPOKE_RPC_URL ?? resolveNetworkRpc(spokeNetwork, "http://127.0.0.1:9545");
const hubChainId = BigInt(
  process.env.HUB_CHAIN_ID
  ?? process.env[`${hubConfig.envPrefix}_CHAIN_ID`]
  ?? String(hubConfig.defaultChainId)
);
const spokeChainId = BigInt(
  process.env.SPOKE_CHAIN_ID
  ?? process.env[`${spokeConfig.envPrefix}_CHAIN_ID`]
  ?? String(spokeConfig.defaultChainId)
);

const lockManagerAddress = process.env.HUB_LOCK_MANAGER_ADDRESS as Address;
const custodyAddress = process.env.HUB_CUSTODY_ADDRESS as Address;
const acrossReceiverAddress = process.env.HUB_ACROSS_RECEIVER_ADDRESS as Address;
const acrossBorrowDispatcherAddress = process.env.HUB_ACROSS_BORROW_DISPATCHER_ADDRESS as Address;
const acrossBorrowFinalizerAddress = process.env.HUB_ACROSS_BORROW_FINALIZER_ADDRESS as Address;
const spokeAcrossSpokePoolAddress = resolveSpokeAddress(spokeConfig.envPrefix, "ACROSS_SPOKE_POOL_ADDRESS");
const spokeBorrowReceiverAddress = resolveSpokeAddress(spokeConfig.envPrefix, "BORROW_RECEIVER_ADDRESS");

const relayerKey = process.env.RELAYER_PRIVATE_KEY as Hex;

const indexerApi = process.env.INDEXER_API_URL ?? "http://127.0.0.1:3030";
const proverApi = process.env.PROVER_API_URL ?? "http://127.0.0.1:3050";
const relayerInitialBackfillBlocks = BigInt(process.env.RELAYER_INITIAL_BACKFILL_BLOCKS ?? "2000");
const relayerMaxLogRange = BigInt(process.env.RELAYER_MAX_LOG_RANGE ?? "2000");
const relayerBridgeFinalityBlocks = BigInt(process.env.RELAYER_BRIDGE_FINALITY_BLOCKS ?? "0");
const relayerSpokeFinalityBlocks = BigInt(
  process.env.RELAYER_SPOKE_FINALITY_BLOCKS ?? relayerBridgeFinalityBlocks.toString()
);
const relayerHubFinalityBlocks = BigInt(
  process.env.RELAYER_HUB_FINALITY_BLOCKS ?? relayerBridgeFinalityBlocks.toString()
);
const apiRateWindowMs = Number(process.env.API_RATE_WINDOW_MS ?? "60000");
const apiRateMaxRequests = Number(process.env.API_RATE_MAX_REQUESTS ?? "1200");
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
const acrossApiBaseUrl = process.env.ACROSS_API_URL ?? "https://app.across.to/api";
const acrossAllowUnmatchedDecimals = (process.env.ACROSS_ALLOW_UNMATCHED_DECIMALS ?? "1") !== "0";
const acrossQuoteMaxAttempts = Number(process.env.ACROSS_QUOTE_MAX_ATTEMPTS ?? "3");

const spokeToHub = JSON.parse(process.env.SPOKE_TO_HUB_TOKEN_MAP ?? "{}") as Record<string, Address>;

if (
  !lockManagerAddress
  || !custodyAddress
  || !acrossReceiverAddress
  || !acrossBorrowDispatcherAddress
  || !acrossBorrowFinalizerAddress
  || !spokeAcrossSpokePoolAddress
  || !spokeBorrowReceiverAddress
  || !relayerKey
) {
  throw new Error("Missing required relayer env vars for deployed addresses/private key");
}

validateStartupConfig();

if (!isProduction && internalAuthSecret === "dev-internal-auth-secret") {
  console.warn("Relayer is using default INTERNAL_API_AUTH_SECRET. Override it before production.");
}

const relayerAccount = privateKeyToAccount(relayerKey);

const hubChain = defineChain({
  id: Number(hubChainId),
  name: "Hub",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [hubRpc] } }
});
const spokeChain = defineChain({
  id: Number(spokeChainId),
  name: "Spoke",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [spokeRpc] } }
});

const hubPublic = createPublicClient({ chain: hubChain, transport: http(hubRpc) });
const spokePublic = createPublicClient({ chain: spokeChain, transport: http(spokeRpc) });
const hubWallet = createWalletClient({ account: relayerAccount, chain: hubChain, transport: http(hubRpc) });

const acrossReceiverAbi = parseAbi([
  "function finalizePendingDeposit(bytes32 pendingId,bytes proof,(uint256 sourceChainId,uint256 depositId,uint8 intentType,address user,address spokeToken,address hubAsset,uint256 amount,bytes32 sourceTxHash,uint256 sourceLogIndex,bytes32 messageHash) witness)"
]);
const acrossBorrowDispatcherAbi = parseAbi([
  "function dispatchBorrowFill(bytes32 intentId,uint8 intentType,address user,address recipient,address outputToken,uint256 amount,uint256 outputChainId,uint256 relayerFee,uint256 maxRelayerFee,address hubAsset,(uint256 outputAmount,uint32 quoteTimestamp,uint32 fillDeadline,uint32 exclusivityDeadline,address exclusiveRelayer) quote) returns (bytes32)"
]);
const acrossBorrowFinalizerAbi = parseAbi([
  "function finalizeBorrowFill(bytes proof,(uint256 sourceChainId,bytes32 intentId,uint8 intentType,address user,address recipient,address spokeToken,address hubAsset,uint256 amount,uint256 fee,address relayer,bytes32 sourceTxHash,uint256 sourceLogIndex,bytes32 messageHash) witness)"
]);
const erc20Abi = parseAbi([
  "function approve(address spender,uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)"
]);
const tokenRegistryReadAbi = parseAbi([
  "function getConfigByHub(address hubToken) view returns ((address hubToken,address spokeToken,uint8 decimals,(uint256 ltvBps,uint256 liquidationThresholdBps,uint256 liquidationBonusBps,uint256 supplyCap,uint256 borrowCap) risk,bytes32 bridgeAdapterId,bool enabled))",
  "function getSpokeDecimalsByHub(uint256 destinationChainId,address hubToken) view returns (uint8)"
]);
const spokeV3FundsDepositedEvent = parseAbiItem(
  "event FundsDeposited(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint256 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 indexed depositor, bytes32 recipient, bytes32 exclusiveRelayer, bytes message)"
);
const spokeBorrowFillRecordedEvent = parseAbiItem(
  "event BorrowFillRecorded(bytes32 indexed intentId,uint8 indexed intentType,address indexed user,address recipient,address spokeToken,address hubAsset,uint256 amount,uint256 fee,address relayer,uint256 destinationChainId,address hubFinalizer,bytes32 messageHash)"
);
const hubPendingDepositRecordedEvent = parseAbiItem(
  "event PendingDepositRecorded(bytes32 indexed pendingId,uint256 indexed sourceChainId,uint256 indexed depositId,uint8 intentType,address user,address spokeToken,address hubAsset,uint256 amount,address tokenReceived,uint256 amountReceived,address relayer,bytes32 messageHash)"
);
const hubBridgedDepositRegisteredEvent = parseAbiItem(
  "event BridgedDepositRegistered(uint256 indexed depositId, uint8 indexed intentType, address indexed user, address hubAsset, uint256 amount, uint256 originChainId, bytes32 originTxHash, uint256 originLogIndex, bytes32 attestationKey)"
);

const trackingPath = process.env.RELAYER_TRACKING_PATH ?? path.join(process.cwd(), "data", "relayer-tracking.json");
const tracking = loadTracking(trackingPath);
let isPollingCanonicalBridge = false;
let cachedTokenRegistryAddress: Address | undefined;
const hubDecimalsCache = new Map<string, number>();
const spokeDecimalsCache = new Map<string, number>();

const submitSchema = z.object({
  intent: z.object({
    intentType: z.number().int().min(1).max(4),
    user: z.string().startsWith("0x"),
    inputChainId: z.string(),
    outputChainId: z.string(),
    inputToken: z.string().startsWith("0x"),
    outputToken: z.string().startsWith("0x"),
    amount: z.string(),
    recipient: z.string().startsWith("0x"),
    maxRelayerFee: z.string(),
    nonce: z.string(),
    deadline: z.string()
  }),
  signature: z.string().startsWith("0x"),
  relayerFee: z.string()
});

app.use(rateLimitMiddleware);

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    relayer: relayerAccount.address,
    hubRpc,
    spokeRpc,
    hubChainId: hubChainId.toString(),
    acrossReceiverAddress,
    acrossBorrowDispatcherAddress,
    acrossBorrowFinalizerAddress,
    spokeAcrossSpokePoolAddress,
    spokeBorrowReceiverAddress,
    bridgeFinalityBlocks: relayerSpokeFinalityBlocks.toString(),
    spokeFinalityBlocks: relayerSpokeFinalityBlocks.toString(),
    hubFinalityBlocks: relayerHubFinalityBlocks.toString(),
    tracking: {
      lastSpokeBlock: tracking.lastSpokeBlock.toString(),
      lastHubBlock: tracking.lastHubBlock.toString()
    }
  });
});

app.get("/quote", (req, res) => {
  const amount = BigInt(String(req.query.amount ?? "0"));
  const intentType = Number(req.query.intentType ?? IntentType.BORROW);

  if (amount <= 0n) {
    res.status(400).json({ error: "invalid amount" });
    return;
  }

  // MVP quote model: static 30 bps fee for outbound intents.
  const feeBps = intentType === IntentType.BORROW || intentType === IntentType.WITHDRAW ? 30n : 0n;
  const fee = (amount * feeBps) / 10_000n;

  res.json({ feeBps: Number(feeBps), fee: fee.toString() });
});

app.post("/intent/submit", async (req, res) => {
  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success) {
    auditLog(req as RequestWithMeta, "submit_rejected", { reason: "invalid_payload" });
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  try {
    const intent = parseIntent(parsed.data.intent);
    const signature = parsed.data.signature as Hex;
    const relayerFee = BigInt(parsed.data.relayerFee);

    if (!toOutboundIntentKind(intent.intentType)) {
      auditLog(req as RequestWithMeta, "submit_rejected", { reason: "unsupported_intent_type", intentType: intent.intentType });
      res.status(400).json({ error: "only borrow/withdraw are relayed in this endpoint" });
      return;
    }

    const intentId = rawIntentId(intent);

    const hubAsset = spokeToHub[intent.outputToken.toLowerCase()];
    if (!hubAsset) {
      throw new Error(`No spoke->hub token mapping for ${intent.outputToken}`);
    }

    const previewLockAmount = await previewHubLockAmount(intent.outputChainId, hubAsset, intent.amount);
    if (previewLockAmount <= 0n) {
      throw new Error(`preview lock amount must be > 0 for intent ${intentId}`);
    }

    let acrossQuote = await resolveBorrowDispatchQuote({
      originChainId: hubChainId,
      destinationChainId: intent.outputChainId,
      inputToken: hubAsset,
      outputToken: intent.outputToken,
      amount: previewLockAmount,
      recipient: spokeBorrowReceiverAddress
    });

    await upsertIntent(intentId, intent, "pending_lock", {
      relayerFee: relayerFee.toString(),
      relayer: relayerAccount.address
    });

    const lockTx = await hubWallet.writeContract({
      abi: HubLockManagerAbi,
      address: lockManagerAddress,
      functionName: "lock",
      args: [intent, signature],
      account: relayerAccount
    });
    const lockReceipt = await hubPublic.waitForTransactionReceipt({ hash: lockTx });
    let lockAmount = extractLockAmountFromReceipt(lockReceipt, intentId);
    if (lockAmount === undefined) {
      try {
        lockAmount = await fetchLockAmount(intentId, lockReceipt.blockNumber);
      } catch (error) {
        if (!isUnknownBlockReadError(error)) throw error;
        lockAmount = await fetchLockAmount(intentId);
      }
    }
    if (lockAmount <= 0n) {
      throw new Error(`lock amount must be > 0 for intent ${intentId}`);
    }
    if (lockAmount !== previewLockAmount) {
      acrossQuote = await resolveBorrowDispatchQuote({
        originChainId: hubChainId,
        destinationChainId: intent.outputChainId,
        inputToken: hubAsset,
        outputToken: intent.outputToken,
        amount: lockAmount,
        recipient: spokeBorrowReceiverAddress
      });
    }

    const relayerHubBalance = await hubPublic.readContract({
      abi: erc20Abi,
      address: hubAsset,
      functionName: "balanceOf",
      args: [relayerAccount.address]
    });
    if (relayerHubBalance < lockAmount) {
      throw new Error(
        `insufficient relayer hub liquidity for ${hubAsset}: need ${lockAmount.toString()} have ${relayerHubBalance.toString()}`
      );
    }

    let dispatchTx: Hex;
    try {
      await hubWallet.writeContract({
        abi: erc20Abi,
        address: hubAsset,
        functionName: "approve",
        args: [acrossBorrowDispatcherAddress, lockAmount],
        account: relayerAccount
      });

      dispatchTx = await hubWallet.writeContract({
        abi: acrossBorrowDispatcherAbi,
        address: acrossBorrowDispatcherAddress,
        functionName: "dispatchBorrowFill",
        args: [
          intentId,
          intent.intentType,
          intent.user,
          intent.recipient,
          intent.outputToken,
          lockAmount,
          intent.outputChainId,
          relayerFee,
          intent.maxRelayerFee,
          hubAsset,
          acrossQuote
        ],
        account: relayerAccount
      });
      await hubPublic.waitForTransactionReceipt({ hash: dispatchTx });
    } catch (dispatchError) {
      const cancelTx = await cancelLockBestEffort(intentId);
      await updateIntentStatus(intentId, "failed", {
        lockTx,
        lockAmount: lockAmount.toString(),
        lockCancelTx: cancelTx,
        error: (dispatchError as Error).message
      }).catch((statusError) => {
        console.warn("Failed to persist intent failure status", statusError);
      });
      throw dispatchError;
    }

    await updateIntentStatus(intentId, "locked", { lockTx, dispatchTx, lockAmount: lockAmount.toString() });

    auditLog(req as RequestWithMeta, "submit_ok", {
      intentId,
      intentType: intent.intentType,
      lockTx,
      dispatchTx
    });

    res.json({
      intentId,
      status: "locked",
      lockTx,
      dispatchTx
    });
  } catch (error) {
    auditLog(req as RequestWithMeta, "submit_error", { message: (error as Error).message });
    res.status(500).json({ error: (error as Error).message });
  }
});

app.listen(port, () => {
  console.log(`Relayer API listening on :${port}`);
  setInterval(() => {
    pollAcrossBridge().catch((error) => {
      console.error("Relayer poll error", error);
    });
  }, 5_000);
});

async function pollAcrossBridge() {
  if (isPollingCanonicalBridge) return;
  isPollingCanonicalBridge = true;
  try {
    await pollSpokeDeposits();
    await pollHubDeposits();
  } finally {
    isPollingCanonicalBridge = false;
  }
}

function rawIntentId(intent: Intent): Hex {
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

async function pollSpokeDeposits() {
  const latestBlock = await spokePublic.getBlockNumber();
  if (latestBlock < tracking.lastSpokeBlock) {
    // Local anvil restarts can rewind chain height; restart scanning from genesis.
    tracking.lastSpokeBlock = 0n;
  }

  const finalizedToBlock = latestBlock > relayerSpokeFinalityBlocks
    ? latestBlock - relayerSpokeFinalityBlocks
    : 0n;
  if (finalizedToBlock === 0n) return;

  if (tracking.lastSpokeBlock === 0n && finalizedToBlock > relayerInitialBackfillBlocks) {
    tracking.lastSpokeBlock = finalizedToBlock - relayerInitialBackfillBlocks;
  }

  const fromBlock = tracking.lastSpokeBlock + 1n;
  if (finalizedToBlock < fromBlock) return;
  const rangeToBlock = fromBlock + relayerMaxLogRange - 1n < finalizedToBlock
    ? fromBlock + relayerMaxLogRange - 1n
    : finalizedToBlock;

  auditLog(undefined, "poll_spoke_range", {
    fromBlock: fromBlock.toString(),
    toBlock: rangeToBlock.toString(),
    latest: latestBlock.toString(),
    finalizedToBlock: finalizedToBlock.toString()
  });

  const acrossDepositLogs = await spokePublic.getLogs({
    address: spokeAcrossSpokePoolAddress,
    event: spokeV3FundsDepositedEvent,
    fromBlock,
    toBlock: rangeToBlock
  });

  for (const log of acrossDepositLogs) {
    await handleAcrossDepositLog(log, finalizedToBlock);
  }

  const borrowFillLogs = await spokePublic.getLogs({
    address: spokeBorrowReceiverAddress,
    event: spokeBorrowFillRecordedEvent,
    fromBlock,
    toBlock: rangeToBlock
  });

  for (const log of borrowFillLogs) {
    await handleSpokeBorrowFillLog(log, finalizedToBlock);
  }

  tracking.lastSpokeBlock = rangeToBlock;
  saveTracking(trackingPath, tracking);
}

async function handleAcrossDepositLog(log: {
  args: Record<string, unknown>;
  transactionHash?: Hex;
  logIndex?: bigint | number | undefined;
  blockNumber?: bigint | undefined;
}, finalizedToBlock: bigint) {
  const message = log.args.message as Hex | undefined;
  const outputToken = bytes32ToAddress(log.args.outputToken);
  const recipient = bytes32ToAddress(log.args.recipient);
  const outputAmount = asBigInt(log.args.outputAmount);
  const destinationChainId = asBigInt(log.args.destinationChainId);
  const originTxHash = log.transactionHash;
  const spokeObservedBlock = log.blockNumber ?? 0n;
  const originLogIndex = typeof log.logIndex === "bigint" ? log.logIndex : BigInt(log.logIndex ?? 0);

  if (!message || !outputToken || !recipient || outputAmount === undefined || destinationChainId === undefined || !originTxHash) {
    console.warn("Skipping Across deposit log with missing fields");
    return;
  }

  if (recipient.toLowerCase() !== acrossReceiverAddress.toLowerCase()) {
    return;
  }

  const decoded = decodeAcrossDepositMessage(message);
  if (!decoded) {
    console.warn("Skipping Across deposit log with undecodable message payload");
    return;
  }

  const {
    depositId,
    intentType,
    user,
    spokeToken,
    hubAsset,
    amount,
    sourceChainId,
    destinationChainId: messageDestinationChainId
  } = decoded;
  if (intentType !== IntentType.SUPPLY && intentType !== IntentType.REPAY) {
    return;
  }
  if (messageDestinationChainId !== hubChainId || destinationChainId !== hubChainId) {
    console.warn(
      `Skipping deposit ${depositId.toString()} due to destination chain mismatch`
    );
    return;
  }
  if (sourceChainId !== spokeChainId) {
    console.warn(`Skipping deposit ${depositId.toString()} due to source chain mismatch`);
    return;
  }
  if (amount !== outputAmount) {
    console.warn(`Skipping deposit ${depositId.toString()} due to amount mismatch in Across message`);
    return;
  }
  if (hubAsset.toLowerCase() !== outputToken.toLowerCase()) {
    console.warn(
      `Skipping deposit ${depositId.toString()} due to hub token mismatch in Across message`
    );
    return;
  }
  const mappedHubToken = spokeToHub[spokeToken.toLowerCase()];
  if (mappedHubToken && mappedHubToken.toLowerCase() !== hubAsset.toLowerCase()) {
    console.warn(`Skipping deposit ${depositId.toString()} due to spoke->hub token map mismatch`);
    return;
  }

  const existing = await fetchDeposit(sourceChainId, depositId);
  if (existing?.status === "settled" || existing?.status === "bridged") {
    return;
  }
  const sourceBlock = await spokePublic.getBlock({ blockNumber: spokeObservedBlock });
  const sourceBlockHash = asHexString(sourceBlock.hash);
  const sourceReceiptsRoot = asHexString(sourceBlock.receiptsRoot as string | undefined);
  if (!sourceBlockHash || !sourceReceiptsRoot) {
    console.warn(`Skipping deposit ${depositId.toString()} due to missing source block hash/receipts root`);
    return;
  }

  const messageHash = keccak256(message);
  const nextStatus = existing?.status === "pending_fill" ? "pending_fill" : "initiated";

  await postInternal(indexerApi, "/internal/deposits/upsert", {
    sourceChainId: Number(sourceChainId),
    depositId: Number(depositId),
    user,
    intentType: intentType as IntentType.SUPPLY | IntentType.REPAY,
    token: hubAsset,
    amount: amount.toString(),
    status: nextStatus,
    metadata: {
      acrossSourceTx: originTxHash,
      acrossSourceLogIndex: originLogIndex.toString(),
      acrossSourceSpokePool: spokeAcrossSpokePoolAddress,
      acrossSpokeToken: spokeToken,
      originChainId: sourceChainId.toString(),
      acrossMessageHash: messageHash,
      acrossSourceBlockNumber: spokeObservedBlock.toString(),
      acrossSourceBlockHash: sourceBlockHash,
      acrossSourceReceiptsRoot: sourceReceiptsRoot,
      spokeObservedBlock: spokeObservedBlock.toString(),
      spokeFinalizedToBlock: finalizedToBlock.toString()
    }
  });

  if (nextStatus !== "pending_fill") {
    return;
  }

  const pendingId = asHexString(metadataString(existing?.metadata, "pendingId"));
  if (!pendingId) {
    return;
  }

  const witness: DepositWitness = {
    sourceChainId,
    depositId,
    intentType,
    user,
    spokeToken,
    hubAsset,
    amount,
    sourceTxHash: originTxHash,
    sourceLogIndex: originLogIndex,
    messageHash
  };
  const sourceEvidence: SourceDepositEvidence = {
    sourceBlockNumber: spokeObservedBlock,
    sourceBlockHash,
    sourceReceiptsRoot,
    sourceSpokePool: spokeAcrossSpokePoolAddress
  };

  await attemptFinalizePendingDeposit(
    pendingId,
    witness,
    sourceEvidence,
    depositId,
    user,
    intentType as IntentType.SUPPLY | IntentType.REPAY,
    hubAsset,
    amount
  );
}

async function handleSpokeBorrowFillLog(log: {
  args: Record<string, unknown>;
  transactionHash?: Hex;
  logIndex?: bigint | number | undefined;
  blockNumber?: bigint | undefined;
}, finalizedToBlock: bigint) {
  const intentId = log.args.intentId as Hex | undefined;
  const rawIntentType = asBigInt(log.args.intentType);
  const user = log.args.user as Address | undefined;
  const recipient = log.args.recipient as Address | undefined;
  const spokeToken = log.args.spokeToken as Address | undefined;
  const hubAsset = log.args.hubAsset as Address | undefined;
  const amount = asBigInt(log.args.amount);
  const fee = asBigInt(log.args.fee);
  const relayer = log.args.relayer as Address | undefined;
  const destinationChainId = asBigInt(log.args.destinationChainId);
  const hubFinalizer = log.args.hubFinalizer as Address | undefined;
  const messageHash = log.args.messageHash as Hex | undefined;
  const sourceTxHash = log.transactionHash;
  const sourceLogIndex = typeof log.logIndex === "bigint" ? log.logIndex : BigInt(log.logIndex ?? 0);
  const spokeObservedBlock = log.blockNumber ?? 0n;

  if (
    !intentId
    || rawIntentType === undefined
    || !user
    || !recipient
    || !spokeToken
    || !hubAsset
    || amount === undefined
    || fee === undefined
    || !relayer
    || destinationChainId === undefined
    || !hubFinalizer
    || !messageHash
    || !sourceTxHash
  ) {
    console.warn("Skipping outbound fill log with missing fields");
    return;
  }

  const intentType = Number(rawIntentType);
  const outboundKind = toOutboundIntentKind(intentType);
  if (!outboundKind) return;
  if (fee >= amount) {
    console.warn(`Skipping outbound fill ${intentId} due to invalid fee`);
    return;
  }
  if (destinationChainId !== spokeChainId) {
    console.warn(`Skipping outbound fill ${intentId} due to chain mismatch`);
    return;
  }
  if (hubFinalizer.toLowerCase() !== acrossBorrowFinalizerAddress.toLowerCase()) {
    console.warn(`Skipping outbound fill ${intentId} due to hub finalizer mismatch`);
    return;
  }

  const existing = await fetchIntent(intentId);
  if (existing?.status === "settled" || existing?.status === "awaiting_settlement") {
    return;
  }
  if (existing) {
    if (existing.intentType !== intentType) {
      console.warn(`Skipping outbound fill ${intentId} due to intent type mismatch`);
      return;
    }
    if (existing.user.toLowerCase() !== user.toLowerCase()) {
      console.warn(`Skipping outbound fill ${intentId} due to user mismatch`);
      return;
    }
    if (existing.token.toLowerCase() !== spokeToken.toLowerCase()) {
      console.warn(`Skipping outbound fill ${intentId} due to spoke token mismatch`);
      return;
    }
    const lockedAmount = asBigInt(existing.amount);
    if (lockedAmount === undefined || amount > lockedAmount) {
      console.warn(`Skipping outbound fill ${intentId} due to amount exceeding lock`);
      return;
    }
  }

  const sourceBlock = await spokePublic.getBlock({ blockNumber: spokeObservedBlock });
  const sourceBlockHash = asHexString(sourceBlock.hash);
  const sourceReceiptsRoot = asHexString(sourceBlock.receiptsRoot as string | undefined);
  if (!sourceBlockHash || !sourceReceiptsRoot) {
    console.warn(`Skipping outbound fill ${intentId} due to missing source block hash/receipts root`);
    return;
  }
  const hubFill = await convertSpokeFillToHubUnits(spokeChainId, hubAsset, amount, fee).catch((error) => {
    console.warn(`Skipping outbound fill ${intentId} due to conversion failure: ${(error as Error).message}`);
    return undefined;
  });
  if (!hubFill || hubFill.amount === 0n || hubFill.fee >= hubFill.amount) {
    console.warn(`Skipping outbound fill ${intentId} due to invalid hub-unit conversion`);
    return;
  }

  const lockAmount = await fetchLockAmount(intentId).catch(() => undefined);
  if (lockAmount !== undefined && hubFill.amount > lockAmount) {
    console.warn(`Skipping outbound fill ${intentId} because converted amount exceeds lock`);
    return;
  }

  const witness: BorrowFillWitness = {
    sourceChainId: spokeChainId,
    intentId,
    intentType,
    user,
    recipient,
    spokeToken,
    hubAsset,
    amount,
    fee,
    relayer,
    sourceTxHash,
    sourceLogIndex,
    messageHash
  };
  const sourceEvidence: SourceBorrowFillEvidence = {
    sourceBlockNumber: spokeObservedBlock,
    sourceBlockHash,
    sourceReceiptsRoot,
    sourceReceiver: spokeBorrowReceiverAddress
  };

  const finalizeTx = await attemptFinalizeBorrowFill(witness, sourceEvidence, intentId).catch((error) => {
    console.warn(`Outbound fill finalization failed for intent ${intentId}: ${(error as Error).message}`);
    return undefined;
  });
  if (!finalizeTx) return;

  await updateIntentStatus(intentId, "filled", {
    spokeBorrowFillTx: sourceTxHash,
    spokeBorrowFillLogIndex: sourceLogIndex.toString(),
    spokeObservedBlock: spokeObservedBlock.toString(),
    spokeFinalizedToBlock: finalizedToBlock.toString(),
    borrowFillFinalizeTx: finalizeTx
  });

  await enqueueProverAction({
    kind: outboundKind,
    intentId,
    user,
    hubAsset,
    amount: hubFill.amount.toString(),
    fee: hubFill.fee.toString(),
    relayer
  });

  await updateIntentStatus(intentId, "awaiting_settlement", {
    spokeBorrowFillTx: sourceTxHash,
    borrowFillFinalizeTx: finalizeTx
  });
}

async function pollHubDeposits() {
  const latestBlock = await hubPublic.getBlockNumber();
  if (latestBlock < tracking.lastHubBlock) {
    tracking.lastHubBlock = 0n;
  }

  const finalizedToBlock = latestBlock > relayerHubFinalityBlocks
    ? latestBlock - relayerHubFinalityBlocks
    : 0n;
  if (finalizedToBlock === 0n) return;

  if (tracking.lastHubBlock === 0n && finalizedToBlock > relayerInitialBackfillBlocks) {
    tracking.lastHubBlock = finalizedToBlock - relayerInitialBackfillBlocks;
  }

  const fromBlock = tracking.lastHubBlock + 1n;
  if (finalizedToBlock < fromBlock) return;
  const rangeToBlock = fromBlock + relayerMaxLogRange - 1n < finalizedToBlock
    ? fromBlock + relayerMaxLogRange - 1n
    : finalizedToBlock;

  auditLog(undefined, "poll_hub_range", {
    fromBlock: fromBlock.toString(),
    toBlock: rangeToBlock.toString(),
    latest: latestBlock.toString(),
    finalizedToBlock: finalizedToBlock.toString()
  });

  const pendingLogs = await hubPublic.getLogs({
    address: acrossReceiverAddress,
    event: hubPendingDepositRecordedEvent,
    fromBlock,
    toBlock: rangeToBlock
  });

  for (const log of pendingLogs) {
    await handleHubPendingDepositLog(log, finalizedToBlock);
  }

  const bridgedLogs = await hubPublic.getLogs({
    address: custodyAddress,
    event: hubBridgedDepositRegisteredEvent,
    fromBlock,
    toBlock: rangeToBlock
  });

  for (const log of bridgedLogs) {
    await handleHubBridgedDepositLog(log, finalizedToBlock);
  }

  tracking.lastHubBlock = rangeToBlock;
  saveTracking(trackingPath, tracking);
}

async function handleHubPendingDepositLog(log: {
  args: Record<string, unknown>;
  transactionHash?: Hex;
  blockNumber?: bigint | undefined;
}, finalizedToBlock: bigint) {
  const pendingId = log.args.pendingId as Hex | undefined;
  const sourceChainId = asBigInt(log.args.sourceChainId);
  const depositId = asBigInt(log.args.depositId);
  const rawIntentType = asBigInt(log.args.intentType);
  const user = log.args.user as Address | undefined;
  const spokeToken = log.args.spokeToken as Address | undefined;
  const hubAsset = log.args.hubAsset as Address | undefined;
  const amount = asBigInt(log.args.amount);
  const tokenReceived = log.args.tokenReceived as Address | undefined;
  const amountReceived = asBigInt(log.args.amountReceived);
  const messageHash = log.args.messageHash as Hex | undefined;
  const hubObservedBlock = log.blockNumber ?? 0n;

  if (
    !pendingId
    || sourceChainId === undefined
    || depositId === undefined
    || rawIntentType === undefined
    || !user
    || !spokeToken
    || !hubAsset
    || amount === undefined
    || !tokenReceived
    || amountReceived === undefined
    || !messageHash
  ) {
    console.warn("Skipping pending deposit log with missing fields");
    return;
  }

  const intentType = Number(rawIntentType);
  if (intentType !== IntentType.SUPPLY && intentType !== IntentType.REPAY) {
    return;
  }
  if (tokenReceived.toLowerCase() !== hubAsset.toLowerCase() || amountReceived !== amount) {
    console.warn(`Skipping pending deposit ${depositId.toString()} due to fill mismatch`);
    return;
  }

  const existing = await fetchDeposit(sourceChainId, depositId);
  if (existing?.status === "settled" || existing?.status === "bridged") {
    return;
  }

  if (existing) {
    if (existing.user.toLowerCase() !== user.toLowerCase()) {
      console.warn(`Skipping pending deposit ${depositId.toString()} due to user mismatch`);
      return;
    }
    if (existing.intentType !== intentType) {
      console.warn(`Skipping pending deposit ${depositId.toString()} due to intent type mismatch`);
      return;
    }
    if (existing.token.toLowerCase() !== hubAsset.toLowerCase()) {
      console.warn(`Skipping pending deposit ${depositId.toString()} due to hub token mismatch`);
      return;
    }
    if (existing.amount !== amount.toString()) {
      console.warn(`Skipping pending deposit ${depositId.toString()} due to amount mismatch`);
      return;
    }

    const expectedSpokeToken = metadataString(existing.metadata, "acrossSpokeToken");
    if (expectedSpokeToken && expectedSpokeToken.toLowerCase() !== spokeToken.toLowerCase()) {
      console.warn(`Skipping pending deposit ${depositId.toString()} due to spoke token mismatch`);
      return;
    }
  }

  const expectedOriginChainId = metadataBigInt(existing?.metadata, "originChainId");
  if (expectedOriginChainId !== undefined && expectedOriginChainId !== sourceChainId) {
    console.warn(`Skipping pending deposit ${depositId.toString()} due to origin chain mismatch`);
    return;
  }

  await postInternal(indexerApi, "/internal/deposits/upsert", {
    sourceChainId: Number(sourceChainId),
    depositId: Number(depositId),
    user,
    intentType: intentType as IntentType.SUPPLY | IntentType.REPAY,
    token: hubAsset,
    amount: amount.toString(),
    status: "pending_fill",
    metadata: {
      pendingId,
      acrossMessageHash: messageHash,
      hubPendingFillTx: log.transactionHash ?? "0x",
      hubObservedBlock: hubObservedBlock.toString(),
      hubFinalizedToBlock: finalizedToBlock.toString()
    }
  });

  const sourceTxHash = asHexString(metadataString(existing?.metadata, "acrossSourceTx"));
  const sourceLogIndex = metadataBigInt(existing?.metadata, "acrossSourceLogIndex");
  const sourceBlockNumber = metadataBigInt(existing?.metadata, "acrossSourceBlockNumber");
  const sourceBlockHash = asHexString(metadataString(existing?.metadata, "acrossSourceBlockHash"));
  const sourceReceiptsRoot = asHexString(metadataString(existing?.metadata, "acrossSourceReceiptsRoot"));
  const sourceSpokePool = asAddress(metadataString(existing?.metadata, "acrossSourceSpokePool"));
  if (
    !sourceTxHash
    || sourceLogIndex === undefined
    || sourceBlockNumber === undefined
    || !sourceBlockHash
    || !sourceReceiptsRoot
    || !sourceSpokePool
  ) {
    console.warn(
      `Pending deposit ${depositId.toString()} is missing source proof metadata; waiting for spoke source observation`
    );
    return;
  }

  const witness: DepositWitness = {
    sourceChainId,
    depositId,
    intentType,
    user,
    spokeToken,
    hubAsset,
    amount,
    sourceTxHash,
    sourceLogIndex,
    messageHash
  };
  const sourceEvidence: SourceDepositEvidence = {
    sourceBlockNumber,
    sourceBlockHash,
    sourceReceiptsRoot,
    sourceSpokePool
  };
  await attemptFinalizePendingDeposit(
    pendingId,
    witness,
    sourceEvidence,
    depositId,
    user,
    intentType as IntentType.SUPPLY | IntentType.REPAY,
    hubAsset,
    amount
  );
}

async function handleHubBridgedDepositLog(log: {
  args: Record<string, unknown>;
  transactionHash?: Hex;
  blockNumber?: bigint | undefined;
}, finalizedToBlock: bigint) {
  const depositId = asBigInt(log.args.depositId);
  const rawIntentType = asBigInt(log.args.intentType);
  const user = log.args.user as Address | undefined;
  const hubAsset = log.args.hubAsset as Address | undefined;
  const amount = asBigInt(log.args.amount);
  const originChainId = asBigInt(log.args.originChainId);
  const originTxHash = log.args.originTxHash as Hex | undefined;
  const originLogIndex = asBigInt(log.args.originLogIndex);
  const attestationKey = log.args.attestationKey as Hex | undefined;
  const hubObservedBlock = log.blockNumber ?? 0n;

  if (
    depositId === undefined
    || rawIntentType === undefined
    || !user
    || !hubAsset
    || amount === undefined
    || originChainId === undefined
    || !originTxHash
    || originLogIndex === undefined
  ) {
    console.warn("Skipping bridged deposit log with missing fields");
    return;
  }

  const intentType = Number(rawIntentType);
  if (intentType !== IntentType.SUPPLY && intentType !== IntentType.REPAY) {
    return;
  }

  const existing = await fetchDeposit(originChainId, depositId);
  if (existing?.status === "settled") {
    return;
  }

  if (existing) {
    if (existing.user.toLowerCase() !== user.toLowerCase()) {
      console.warn(`Skipping bridged deposit ${depositId.toString()} due to user mismatch`);
      return;
    }
    if (existing.intentType !== intentType) {
      console.warn(`Skipping bridged deposit ${depositId.toString()} due to intent type mismatch`);
      return;
    }
    if (existing.token.toLowerCase() !== hubAsset.toLowerCase()) {
      console.warn(`Skipping bridged deposit ${depositId.toString()} due to hub token mismatch`);
      return;
    }
    if (existing.amount !== amount.toString()) {
      console.warn(`Skipping bridged deposit ${depositId.toString()} due to amount mismatch`);
      return;
    }

    const expectedOriginChainId = metadataBigInt(existing.metadata, "originChainId");
    if (expectedOriginChainId !== undefined && expectedOriginChainId !== originChainId) {
      console.warn(`Skipping bridged deposit ${depositId.toString()} due to origin chain mismatch`);
      return;
    }

    const expectedOriginTxHash = metadataString(existing.metadata, "acrossSourceTx");
    if (expectedOriginTxHash && expectedOriginTxHash.toLowerCase() !== originTxHash.toLowerCase()) {
      console.warn(`Skipping bridged deposit ${depositId.toString()} due to origin tx mismatch`);
      return;
    }

    const expectedOriginLogIndex = metadataBigInt(existing.metadata, "acrossSourceLogIndex");
    if (expectedOriginLogIndex !== undefined && expectedOriginLogIndex !== originLogIndex) {
      console.warn(`Skipping bridged deposit ${depositId.toString()} due to origin log index mismatch`);
      return;
    }
  }

  await postInternal(indexerApi, "/internal/deposits/upsert", {
    sourceChainId: Number(originChainId),
    depositId: Number(depositId),
    user,
    intentType: intentType as IntentType.SUPPLY | IntentType.REPAY,
    token: hubAsset,
    amount: amount.toString(),
    status: "bridged",
    metadata: {
      hubBridgeReceiveTx: log.transactionHash ?? "0x",
      acrossSourceTx: originTxHash,
      acrossSourceLogIndex: originLogIndex.toString(),
      acrossSourceSpokePool: spokeAcrossSpokePoolAddress,
      originChainId: originChainId.toString(),
      attestationKey,
      hubObservedBlock: hubObservedBlock.toString(),
      hubFinalizedToBlock: finalizedToBlock.toString()
    }
  });

  await enqueueProverAction({
    kind: intentType === IntentType.SUPPLY ? "supply" : "repay",
    sourceChainId: originChainId.toString(),
    depositId: depositId.toString(),
    user,
    hubAsset,
    amount: amount.toString()
  });
}

type IndexedDeposit = {
  status: string;
  user: Address;
  intentType: number;
  token: Address;
  amount: string;
  metadata?: Record<string, unknown>;
};

type IndexedIntent = {
  status: string;
  user: Address;
  intentType: number;
  token: Address;
  amount: string;
  metadata?: Record<string, unknown>;
};

async function fetchDeposit(sourceChainId: bigint, depositId: bigint): Promise<IndexedDeposit | undefined> {
  const scoped = await fetch(`${indexerApi}/deposits/${sourceChainId.toString()}/${depositId.toString()}`).catch(() => null);
  if (scoped?.ok) {
    return (await scoped.json()) as IndexedDeposit;
  }

  const legacy = await fetch(`${indexerApi}/deposits/${depositId.toString()}`).catch(() => null);
  if (!legacy || !legacy.ok) return undefined;
  return (await legacy.json()) as IndexedDeposit;
}

async function fetchIntent(intentId: Hex): Promise<IndexedIntent | undefined> {
  const existing = await fetch(`${indexerApi}/intents/${intentId}`).catch(() => null);
  if (!existing || !existing.ok) return undefined;
  return (await existing.json()) as IndexedIntent;
}

async function fetchLockAmount(intentId: Hex, blockNumber?: bigint): Promise<bigint> {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const lock = await hubPublic.readContract({
      abi: HubLockManagerAbi,
      address: lockManagerAddress,
      functionName: "locks",
      args: [intentId],
      ...(blockNumber !== undefined ? { blockNumber } : {})
    });

    const amount = asBigInt(
      (lock as { amount?: unknown }).amount
      ?? (Array.isArray(lock) ? lock[4] : undefined)
    );
    if (amount !== undefined && amount > 0n) {
      return amount;
    }
    if (amount !== undefined && blockNumber !== undefined) {
      // Receipt block should already include the lock write, but some RPC backends can lag briefly.
      await sleep(200 * attempt);
      continue;
    }
    if (amount !== undefined) return amount;
    await sleep(100 * attempt);
  }
  throw new Error(`unable to read lock amount for ${intentId}`);
}

async function cancelLockBestEffort(intentId: Hex): Promise<Hex | undefined> {
  try {
    const cancelTx = await hubWallet.writeContract({
      abi: HubLockManagerAbi,
      address: lockManagerAddress,
      functionName: "cancelLock",
      args: [intentId],
      account: relayerAccount
    });
    await hubPublic.waitForTransactionReceipt({ hash: cancelTx });
    return cancelTx;
  } catch (error) {
    console.warn(`Failed to cancel active lock ${intentId}`, error);
    return undefined;
  }
}

function extractLockAmountFromReceipt(
  receipt: { logs: Array<{ address: Address; data: Hex; topics: readonly Hex[] }> },
  intentId: Hex
): bigint | undefined {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== lockManagerAddress.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: HubLockManagerAbi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]]
      }) as { eventName: string; args: Record<string, unknown> };
      if (decoded.eventName !== "BorrowLocked" && decoded.eventName !== "WithdrawLocked") continue;
      const loggedIntentId = asHexString(String(decoded.args.intentId));
      if (!loggedIntentId || loggedIntentId.toLowerCase() !== intentId.toLowerCase()) continue;
      const amount = asBigInt(decoded.args.amount);
      if (amount !== undefined) return amount;
    } catch {
      continue;
    }
  }
  return undefined;
}

async function previewHubLockAmount(outputChainId: bigint, hubAsset: Address, outputAmount: bigint): Promise<bigint> {
  const { hubDecimals, spokeDecimals } = await resolveRouteDecimals(outputChainId, hubAsset);
  return scaleAmountUnits(outputAmount, spokeDecimals, hubDecimals);
}

async function resolveTokenRegistryAddress(): Promise<Address> {
  if (cachedTokenRegistryAddress) return cachedTokenRegistryAddress;
  const tokenRegistry = await hubPublic.readContract({
    abi: HubLockManagerAbi,
    address: lockManagerAddress,
    functionName: "tokenRegistry"
  }) as Address;
  cachedTokenRegistryAddress = tokenRegistry;
  return tokenRegistry;
}

async function resolveRouteDecimals(sourceChainId: bigint, hubAsset: Address): Promise<{ hubDecimals: number; spokeDecimals: number }> {
  const normalizedHub = hubAsset.toLowerCase();
  const hubCached = hubDecimalsCache.get(normalizedHub);
  const spokeCacheKey = `${sourceChainId.toString()}:${normalizedHub}`;
  const spokeCached = spokeDecimalsCache.get(spokeCacheKey);
  if (hubCached !== undefined && spokeCached !== undefined) {
    return { hubDecimals: hubCached, spokeDecimals: spokeCached };
  }

  const tokenRegistryAddress = await resolveTokenRegistryAddress();

  let hubDecimals = hubCached;
  if (hubDecimals === undefined) {
    const cfg = await hubPublic.readContract({
      abi: tokenRegistryReadAbi,
      address: tokenRegistryAddress,
      functionName: "getConfigByHub",
      args: [hubAsset]
    });
    const parsed = asNumber((cfg as { decimals?: unknown }).decimals);
    if (parsed === undefined) {
      throw new Error(`unable to decode hub decimals for ${hubAsset}`);
    }
    hubDecimals = parsed;
    hubDecimalsCache.set(normalizedHub, hubDecimals);
  }

  let spokeDecimals = spokeCached;
  if (spokeDecimals === undefined) {
    const raw = await hubPublic.readContract({
      abi: tokenRegistryReadAbi,
      address: tokenRegistryAddress,
      functionName: "getSpokeDecimalsByHub",
      args: [sourceChainId, hubAsset]
    });
    const parsed = asNumber(raw);
    if (parsed === undefined) {
      throw new Error(`unable to decode spoke decimals for chain=${sourceChainId.toString()} hubAsset=${hubAsset}`);
    }
    spokeDecimals = parsed;
    spokeDecimalsCache.set(spokeCacheKey, spokeDecimals);
  }

  return { hubDecimals, spokeDecimals };
}

async function convertSpokeFillToHubUnits(
  sourceChainId: bigint,
  hubAsset: Address,
  amount: bigint,
  fee: bigint
): Promise<{ amount: bigint; fee: bigint }> {
  const { hubDecimals, spokeDecimals } = await resolveRouteDecimals(sourceChainId, hubAsset);
  return {
    amount: scaleAmountUnits(amount, spokeDecimals, hubDecimals),
    fee: scaleAmountUnits(fee, spokeDecimals, hubDecimals)
  };
}

async function enqueueProverAction(body: Record<string, unknown>) {
  await postInternal(proverApi, "/internal/enqueue", body);
}

async function fetchDepositProof(witness: DepositWitness, sourceEvidence: SourceDepositEvidence): Promise<Hex> {
  const response = await postInternal(proverApi, "/internal/deposit-proof", {
    sourceChainId: witness.sourceChainId.toString(),
    depositId: witness.depositId.toString(),
    intentType: witness.intentType,
    user: witness.user,
    spokeToken: witness.spokeToken,
    hubAsset: witness.hubAsset,
    amount: witness.amount.toString(),
    sourceTxHash: witness.sourceTxHash,
    sourceLogIndex: witness.sourceLogIndex.toString(),
    messageHash: witness.messageHash,
    sourceBlockNumber: sourceEvidence.sourceBlockNumber.toString(),
    sourceBlockHash: sourceEvidence.sourceBlockHash,
    sourceReceiptsRoot: sourceEvidence.sourceReceiptsRoot,
    sourceSpokePool: sourceEvidence.sourceSpokePool,
    destinationReceiver: acrossReceiverAddress,
    destinationChainId: hubChainId.toString()
  }) as { proof?: string } | undefined;

  const proof = asHexString(response?.proof);
  if (!proof) {
    throw new Error("prover response missing proof");
  }
  return proof;
}

async function fetchBorrowFillProof(witness: BorrowFillWitness, sourceEvidence: SourceBorrowFillEvidence): Promise<Hex> {
  const response = await postInternal(proverApi, "/internal/borrow-fill-proof", {
    sourceChainId: witness.sourceChainId.toString(),
    intentId: witness.intentId,
    intentType: witness.intentType,
    user: witness.user,
    recipient: witness.recipient,
    spokeToken: witness.spokeToken,
    hubAsset: witness.hubAsset,
    amount: witness.amount.toString(),
    fee: witness.fee.toString(),
    relayer: witness.relayer,
    sourceTxHash: witness.sourceTxHash,
    sourceLogIndex: witness.sourceLogIndex.toString(),
    messageHash: witness.messageHash,
    sourceBlockNumber: sourceEvidence.sourceBlockNumber.toString(),
    sourceBlockHash: sourceEvidence.sourceBlockHash,
    sourceReceiptsRoot: sourceEvidence.sourceReceiptsRoot,
    sourceReceiver: sourceEvidence.sourceReceiver,
    destinationFinalizer: acrossBorrowFinalizerAddress,
    destinationChainId: hubChainId.toString()
  }) as { proof?: string } | undefined;

  const proof = asHexString(response?.proof);
  if (!proof) {
    throw new Error("prover response missing outbound fill proof");
  }
  return proof;
}

async function attemptFinalizePendingDeposit(
  pendingId: Hex,
  witness: DepositWitness,
  sourceEvidence: SourceDepositEvidence,
  depositId: bigint,
  user: Address,
  intentType: IntentType.SUPPLY | IntentType.REPAY,
  hubAsset: Address,
  amount: bigint
) {
  let proof: Hex;
  try {
    proof = await fetchDepositProof(witness, sourceEvidence);
  } catch (error) {
    console.warn(`Deposit proof fetch failed for deposit ${depositId.toString()}: ${(error as Error).message}`);
    return;
  }

  try {
    const finalizeTx = await hubWallet.writeContract({
      abi: acrossReceiverAbi,
      address: acrossReceiverAddress,
      functionName: "finalizePendingDeposit",
      args: [pendingId, proof, witness],
      account: relayerAccount
    });
    await hubPublic.waitForTransactionReceipt({ hash: finalizeTx });

    await postInternal(indexerApi, "/internal/deposits/upsert", {
      sourceChainId: Number(witness.sourceChainId),
      depositId: Number(depositId),
      user,
      intentType,
      token: hubAsset,
      amount: amount.toString(),
      status: "pending_fill",
      metadata: {
        finalizeTx
      }
    });
  } catch (error) {
    console.warn(
      `Across pending finalization failed for deposit ${depositId.toString()}: ${(error as Error).message}`
    );
  }
}

async function attemptFinalizeBorrowFill(
  witness: BorrowFillWitness,
  sourceEvidence: SourceBorrowFillEvidence,
  intentId: Hex
): Promise<Hex> {
  const proof = await fetchBorrowFillProof(witness, sourceEvidence);

  const finalizeTx = await hubWallet.writeContract({
    abi: acrossBorrowFinalizerAbi,
    address: acrossBorrowFinalizerAddress,
    functionName: "finalizeBorrowFill",
    args: [proof, witness],
    account: relayerAccount
  });
  await hubPublic.waitForTransactionReceipt({ hash: finalizeTx });

  auditLog(undefined, "outbound_fill_finalized", {
    intentId,
    intentType: witness.intentType,
    finalizeTx,
    sourceTxHash: witness.sourceTxHash,
    sourceLogIndex: witness.sourceLogIndex.toString()
  });

  return finalizeTx;
}

async function upsertIntent(intentId: `0x${string}`, intent: Intent, status: string, metadata?: Record<string, unknown>) {
  await postInternal(indexerApi, "/internal/intents/upsert", {
    intentId,
    status,
    user: intent.user,
    intentType: intent.intentType,
    amount: intent.amount.toString(),
    token: intent.outputToken,
    metadata
  });
}

async function updateIntentStatus(intentId: `0x${string}`, status: string, metadata?: Record<string, unknown>) {
  await postInternal(indexerApi, `/internal/intents/${intentId}/status`, { status, metadata });
}

function parseIntent(payload: z.infer<typeof submitSchema>["intent"]): Intent {
  return {
    intentType: payload.intentType,
    user: payload.user as Address,
    inputChainId: BigInt(payload.inputChainId),
    outputChainId: BigInt(payload.outputChainId),
    inputToken: payload.inputToken as Address,
    outputToken: payload.outputToken as Address,
    amount: BigInt(payload.amount),
    recipient: payload.recipient as Address,
    maxRelayerFee: BigInt(payload.maxRelayerFee),
    nonce: BigInt(payload.nonce),
    deadline: BigInt(payload.deadline)
  };
}

async function resolveBorrowDispatchQuote(params: {
  originChainId: bigint;
  destinationChainId: bigint;
  inputToken: Address;
  outputToken: Address;
  amount: bigint;
  recipient: Address;
}): Promise<AcrossQuoteParams> {
  const fallback = defaultAcrossQuote(params.amount);
  if (!isLiveMode) return fallback;

  const search = new URLSearchParams({
    originChainId: params.originChainId.toString(),
    destinationChainId: params.destinationChainId.toString(),
    inputToken: params.inputToken,
    outputToken: params.outputToken,
    amount: params.amount.toString(),
    recipient: params.recipient
  });
  if (acrossAllowUnmatchedDecimals) {
    search.set("allowUnmatchedDecimals", "true");
  }
  // Required on BNB USDC routes to avoid hard-failing with AMOUNT_TOO_LOW and to surface limits/output explicitly.
  search.set("skipAmountLimit", "true");
  const url = `${acrossApiBaseUrl.replace(/\/+$/, "")}/suggested-fees?${search.toString()}`;

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= acrossQuoteMaxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      const rawBody = await res.text();
      if (!res.ok) {
        const code = parseAcrossErrorCode(rawBody);
        const failure = new Error(`Across quote HTTP ${res.status}: ${rawBody}`);
        lastError = failure;
        if (attempt < acrossQuoteMaxAttempts && (res.status >= 500 || res.status === 429 || code === "AMOUNT_TOO_LOW")) {
          await sleep(300 * attempt);
          continue;
        }
        throw failure;
      }

      const payload = parseAcrossPayload(rawBody);
      const outputAmount = parseAcrossOutputAmount(payload, params.amount);
      const quoteTimestamp = Number(payload.quoteTimestamp ?? payload.timestamp ?? 0);
      const fillDeadline = Number(payload.fillDeadline ?? 0);
      const exclusivityDeadline = Number(payload.exclusivityDeadline ?? 0);
      const exclusiveRelayer = asAddress(String(payload.exclusiveRelayer ?? ZERO_ADDRESS)) ?? (ZERO_ADDRESS as Address);
      const isAmountTooLow = payload.isAmountTooLow === true;

      if (outputAmount === undefined) {
        throw new Error("Across quote missing output amount");
      }
      if (outputAmount <= 0n || isAmountTooLow) {
        const minDeposit = asBigInt(
          (payload.limits as { minDeposit?: unknown } | undefined)?.minDeposit
        );
        const relayFee = asBigInt(
          (payload.totalRelayFee as { total?: unknown } | undefined)?.total
        );
        throw new Error(
          `Across quote amount too low for route amount=${params.amount.toString()} output=${outputAmount.toString()} minDeposit=${(minDeposit ?? 0n).toString()} relayFee=${(relayFee ?? 0n).toString()}`
        );
      }
      if (!Number.isInteger(quoteTimestamp) || quoteTimestamp <= 0) {
        throw new Error("Across quote missing quoteTimestamp");
      }
      if (!Number.isInteger(fillDeadline) || fillDeadline <= quoteTimestamp) {
        throw new Error("Across quote missing/invalid fillDeadline");
      }
      if (!Number.isInteger(exclusivityDeadline) || exclusivityDeadline < 0 || exclusivityDeadline > fillDeadline) {
        throw new Error("Across quote invalid exclusivityDeadline");
      }

      return {
        outputAmount,
        quoteTimestamp,
        fillDeadline,
        exclusivityDeadline,
        exclusiveRelayer
      };
    } catch (error) {
      const wrapped = new Error(`Across quote resolution failed: ${(error as Error).message}`);
      lastError = wrapped;
      if (attempt < acrossQuoteMaxAttempts && isRetryableAcrossQuoteError(error)) {
        await sleep(300 * attempt);
        continue;
      }
      throw wrapped;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError ?? new Error("Across quote resolution failed");
}

function parseAcrossOutputAmount(payload: Record<string, unknown>, inputAmount: bigint): bigint | undefined {
  const direct = asBigInt(payload.outputAmount ?? payload.expectedOutputAmount ?? payload.estimatedFillAmount ?? payload.amountToReceive);
  if (direct !== undefined) return direct;

  const totalRelayFee = asBigInt(
    (payload.totalRelayFee as { total?: unknown } | undefined)?.total
    ?? (payload.fees as { totalRelayFee?: { total?: unknown } } | undefined)?.totalRelayFee?.total
  );
  if (totalRelayFee !== undefined && totalRelayFee <= inputAmount) {
    return inputAmount - totalRelayFee;
  }
  return undefined;
}

function parseAcrossPayload(rawBody: string): Record<string, unknown> {
  if (!rawBody) return {};
  try {
    const parsed = JSON.parse(rawBody);
    return typeof parsed === "object" && parsed ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseAcrossErrorCode(rawBody: string): string | undefined {
  const payload = parseAcrossPayload(rawBody);
  return typeof payload.code === "string" ? payload.code : undefined;
}

function isRetryableAcrossQuoteError(error: unknown): boolean {
  const message = String((error as Error)?.message ?? "").toLowerCase();
  return (
    message.includes("timed out")
    || message.includes("timeout")
    || message.includes("aborted")
    || message.includes("fetch failed")
    || message.includes("network")
    || message.includes("502")
    || message.includes("503")
    || message.includes("504")
    || message.includes("429")
  );
}

function isUnknownBlockReadError(error: unknown): boolean {
  const message = String((error as Error)?.message ?? "").toLowerCase();
  return message.includes("unknown block");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultAcrossQuote(amount: bigint): AcrossQuoteParams {
  const now = Math.floor(Date.now() / 1000);
  return {
    outputAmount: amount,
    quoteTimestamp: now,
    fillDeadline: now + 2 * 60 * 60,
    exclusivityDeadline: 0,
    exclusiveRelayer: ZERO_ADDRESS as Address
  };
}

type TrackingState = {
  lastSpokeBlock: bigint;
  lastHubBlock: bigint;
};

function loadTracking(filePath: string): TrackingState {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    const initial = { lastSpokeBlock: 0n, lastHubBlock: 0n };
    saveTracking(filePath, initial);
    return initial;
  }
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as { lastSpokeBlock?: string; lastHubBlock?: string };
  return {
    lastSpokeBlock: BigInt(raw.lastSpokeBlock ?? "0"),
    lastHubBlock: BigInt(raw.lastHubBlock ?? "0")
  };
}

function saveTracking(filePath: string, state: TrackingState) {
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        lastSpokeBlock: state.lastSpokeBlock.toString(),
        lastHubBlock: state.lastHubBlock.toString()
      },
      null,
      2
    )
  );
}

async function postInternal(baseUrl: string, routePath: string, body: Record<string, unknown>): Promise<unknown> {
  const rawBody = JSON.stringify(body);
  const { timestamp, signature } = signInternalRequest("POST", routePath, rawBody);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(new URL(routePath, baseUrl).toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-elhub-internal-ts": timestamp,
        "x-elhub-internal-sig": signature,
        [internalCallerHeader]: internalServiceName
      },
      body: rawBody,
      signal: controller.signal
    });

    if (!res.ok) {
      throw new Error(`Failed internal call ${routePath}: ${res.status} ${await res.text()}`);
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return await res.json();
    }
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

function signInternalRequest(method: string, routePath: string, rawBody: string) {
  const timestamp = Date.now().toString();
  const signature = computeInternalSignature(
    internalAuthSecret,
    method,
    routePath,
    timestamp,
    internalServiceName,
    rawBody
  );
  return { timestamp, signature };
}

function computeInternalSignature(
  secret: string,
  method: string,
  routePath: string,
  timestamp: string,
  callerService: string,
  rawBody: string
): string {
  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  const payload = `${method.toUpperCase()}\n${routePath}\n${timestamp}\n${callerService}\n${bodyHash}`;
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function rateLimitMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  const now = Date.now();
  const bucketKey = `public:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`;
  const existing = rateBuckets.get(bucketKey);

  if (!existing || existing.resetAt <= now) {
    rateBuckets.set(bucketKey, { count: 1, resetAt: now + apiRateWindowMs });
    next();
    return;
  }

  if (existing.count >= apiRateMaxRequests) {
    auditLog(req as RequestWithMeta, "rate_limit_rejected", { bucketKey });
    res.status(429).json({ error: "rate_limited" });
    return;
  }

  existing.count += 1;
  next();
}

function auditLog(req: RequestWithMeta | undefined, action: string, fields?: Record<string, unknown>) {
  const payload: Record<string, unknown> = {
    ts: new Date().toISOString(),
    service: "relayer",
    action
  };
  if (req) {
    payload.requestId = req.requestId ?? "unknown";
    payload.method = req.method;
    payload.path = req.originalUrl.split("?")[0] ?? req.path;
  }
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      payload[key] = value;
    }
  }
  console.log(JSON.stringify(payload));
}

function asBigInt(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && value.length > 0) {
    try {
      return BigInt(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  const asInt = asBigInt(value);
  if (asInt === undefined) return undefined;
  const num = Number(asInt);
  if (!Number.isInteger(num)) return undefined;
  return num;
}

function scaleAmountUnits(amount: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (fromDecimals === toDecimals) return amount;
  if (fromDecimals < 0 || toDecimals < 0 || fromDecimals > 77 || toDecimals > 77) {
    throw new Error(`unsupported decimals conversion ${fromDecimals}->${toDecimals}`);
  }
  const delta = BigInt(Math.abs(fromDecimals - toDecimals));
  const factor = 10n ** delta;
  if (fromDecimals > toDecimals) {
    return amount / factor;
  }
  return amount * factor;
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return value.toString();
  return undefined;
}

function asHexString(value: string | undefined): Hex | undefined {
  if (!value || typeof value !== "string") return undefined;
  if (!value.startsWith("0x")) return undefined;
  return value as Hex;
}

function asAddress(value: string | undefined): Address | undefined {
  if (!value || typeof value !== "string") return undefined;
  if (!value.startsWith("0x") || value.length !== 42) return undefined;
  return value as Address;
}

function bytes32ToAddress(value: unknown): Address | undefined {
  if (typeof value !== "string") return undefined;
  if (!value.startsWith("0x") || value.length !== 66) return undefined;
  return `0x${value.slice(-40)}` as Address;
}

function metadataBigInt(metadata: Record<string, unknown> | undefined, key: string): bigint | undefined {
  const value = metadataString(metadata, key);
  if (!value) return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

function toOutboundIntentKind(intentType: number): "borrow" | "withdraw" | undefined {
  if (intentType === IntentType.BORROW) return "borrow";
  if (intentType === IntentType.WITHDRAW) return "withdraw";
  return undefined;
}

type AcrossDepositMessage = {
  depositId: bigint;
  intentType: number;
  user: Address;
  spokeToken: Address;
  hubAsset: Address;
  amount: bigint;
  sourceChainId: bigint;
  destinationChainId: bigint;
};

type DepositWitness = {
  sourceChainId: bigint;
  depositId: bigint;
  intentType: number;
  user: Address;
  spokeToken: Address;
  hubAsset: Address;
  amount: bigint;
  sourceTxHash: Hex;
  sourceLogIndex: bigint;
  messageHash: Hex;
};

type SourceDepositEvidence = {
  sourceBlockNumber: bigint;
  sourceBlockHash: Hex;
  sourceReceiptsRoot: Hex;
  sourceSpokePool: Address;
};

type BorrowFillWitness = {
  sourceChainId: bigint;
  intentId: Hex;
  intentType: number;
  user: Address;
  recipient: Address;
  spokeToken: Address;
  hubAsset: Address;
  amount: bigint;
  fee: bigint;
  relayer: Address;
  sourceTxHash: Hex;
  sourceLogIndex: bigint;
  messageHash: Hex;
};

type SourceBorrowFillEvidence = {
  sourceBlockNumber: bigint;
  sourceBlockHash: Hex;
  sourceReceiptsRoot: Hex;
  sourceReceiver: Address;
};

function decodeAcrossDepositMessage(message: Hex): AcrossDepositMessage | undefined {
  try {
    const decoded = decodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "depositId", type: "uint256" },
            { name: "intentType", type: "uint8" },
            { name: "user", type: "address" },
            { name: "spokeToken", type: "address" },
            { name: "hubAsset", type: "address" },
            { name: "amount", type: "uint256" },
            { name: "sourceChainId", type: "uint256" },
            { name: "destinationChainId", type: "uint256" }
          ]
        }
      ],
      message
    ) as readonly [AcrossDepositMessage];
    return decoded[0];
  } catch {
    return undefined;
  }
}

function normalizeNetwork(value: string): NetworkName {
  const normalized = value.trim().toLowerCase();
  if (normalized === "mainnet") return "ethereum";
  if (normalized === "world") return "worldchain";
  if (normalized === "bnb") return "bsc";
  if (normalized in NETWORKS) return normalized as NetworkName;
  throw new Error(`Unsupported network=${value}. Use one of: ${Object.keys(NETWORKS).join(", ")}`);
}

function resolveSpokeNetwork(value: string): NetworkName {
  const first = value
    .split(",")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return normalizeNetwork(first ?? "base");
}

function resolveNetworkRpc(network: NetworkName, fallback: string): string {
  const config = NETWORKS[network];
  const tenderly = process.env[`${config.envPrefix}_TENDERLY_RPC_URL`];
  const rpc = process.env[`${config.envPrefix}_RPC_URL`];
  if (isLiveMode && tenderly) {
    throw new Error(`LIVE_MODE forbids ${config.envPrefix}_TENDERLY_RPC_URL`);
  }
  return rpc ?? tenderly ?? fallback;
}

function resolveSpokeAddress(spokeEnvPrefix: string, suffix: string): Address {
  return (
    process.env[`SPOKE_${spokeEnvPrefix}_${suffix}`]
    ?? process.env[`SPOKE_${suffix}`]
    ?? ""
  ) as Address;
}

function validateStartupConfig() {
  if (!internalAuthSecret) {
    throw new Error("Missing INTERNAL_API_AUTH_SECRET");
  }
  if (!internalServiceName) {
    throw new Error("INTERNAL_API_SERVICE_NAME cannot be empty");
  }
  if (isProduction && internalAuthSecret === "dev-internal-auth-secret") {
    throw new Error("INTERNAL_API_AUTH_SECRET cannot use dev default in production");
  }
  if (isProduction && corsAllowOrigin.trim() === "*") {
    throw new Error("CORS_ALLOW_ORIGIN cannot be '*' in production");
  }
  if (isLiveMode) {
    if (corsAllowOrigin.trim() === "*") {
      throw new Error("CORS_ALLOW_ORIGIN cannot be '*' in LIVE_MODE");
    }
    if (internalAuthSecret === "dev-internal-auth-secret") {
      throw new Error("INTERNAL_API_AUTH_SECRET cannot use dev default in LIVE_MODE");
    }
  }
  if (relayerSpokeFinalityBlocks < 0n) {
    throw new Error("RELAYER_SPOKE_FINALITY_BLOCKS cannot be negative");
  }
  if (relayerHubFinalityBlocks < 0n) {
    throw new Error("RELAYER_HUB_FINALITY_BLOCKS cannot be negative");
  }
  if (!Number.isInteger(acrossQuoteMaxAttempts) || acrossQuoteMaxAttempts <= 0) {
    throw new Error("ACROSS_QUOTE_MAX_ATTEMPTS must be a positive integer");
  }
  if (!acrossReceiverAddress) {
    throw new Error("Missing HUB_ACROSS_RECEIVER_ADDRESS");
  }
  if (!acrossBorrowDispatcherAddress) {
    throw new Error("Missing HUB_ACROSS_BORROW_DISPATCHER_ADDRESS");
  }
  if (!acrossBorrowFinalizerAddress) {
    throw new Error("Missing HUB_ACROSS_BORROW_FINALIZER_ADDRESS");
  }
  if (!spokeAcrossSpokePoolAddress) {
    throw new Error(
      `Missing SPOKE_${spokeConfig.envPrefix}_ACROSS_SPOKE_POOL_ADDRESS or SPOKE_ACROSS_SPOKE_POOL_ADDRESS`
    );
  }
  if (!spokeBorrowReceiverAddress) {
    throw new Error(
      `Missing SPOKE_${spokeConfig.envPrefix}_BORROW_RECEIVER_ADDRESS or SPOKE_BORROW_RECEIVER_ADDRESS`
    );
  }
}
