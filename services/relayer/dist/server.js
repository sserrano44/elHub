import path from "node:path";
import { createHash, createHmac, randomUUID } from "node:crypto";
import express from "express";
import { z } from "zod";
import { createPublicClient, createWalletClient, decodeAbiParameters, defineChain, encodeAbiParameters, http, keccak256, parseAbi, parseAbiItem } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HubLockManagerAbi } from "@elhub/abis";
import { collectNormalizedSpokeDepositLogs, spokeFundsDepositedEvent, spokeV3FundsDepositedEvent } from "./spoke-deposit-log";
import { loadRelayerState, saveRelayerState } from "./finalization-state";
var IntentType;
(function (IntentType) {
    IntentType[IntentType["SUPPLY"] = 1] = "SUPPLY";
    IntentType[IntentType["REPAY"] = 2] = "REPAY";
    IntentType[IntentType["BORROW"] = 3] = "BORROW";
    IntentType[IntentType["WITHDRAW"] = 4] = "WITHDRAW";
})(IntentType || (IntentType = {}));
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const NETWORKS = {
    ethereum: { envPrefix: "ETHEREUM", defaultChainId: 1 },
    base: { envPrefix: "BASE", defaultChainId: 8453 },
    bsc: { envPrefix: "BSC", defaultChainId: 56 },
    worldchain: { envPrefix: "WORLDCHAIN", defaultChainId: 480 }
};
const runtimeEnv = (process.env.ZKHUB_ENV ?? process.env.NODE_ENV ?? "development").toLowerCase();
const isProduction = runtimeEnv === "production";
const isLiveMode = (process.env.LIVE_MODE ?? "0") !== "0";
const corsAllowOrigin = process.env.CORS_ALLOW_ORIGIN ?? "*";
const internalAuthSecret = process.env.INTERNAL_API_AUTH_SECRET
    ?? (isProduction ? "" : "dev-internal-auth-secret");
const internalCallerHeader = "x-elhub-internal-service";
const internalServiceName = process.env.INTERNAL_API_SERVICE_NAME?.trim() || "relayer";
const app = express();
app.set("json replacer", (_key, value) => (typeof value === "bigint" ? value.toString() : value));
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
    const requestId = req.header("x-request-id")?.trim() || randomUUID();
    req.requestId = requestId;
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
const hubChainId = BigInt(process.env.HUB_CHAIN_ID
    ?? process.env[`${hubConfig.envPrefix}_CHAIN_ID`]
    ?? String(hubConfig.defaultChainId));
const spokeChainId = BigInt(process.env.SPOKE_CHAIN_ID
    ?? process.env[`${spokeConfig.envPrefix}_CHAIN_ID`]
    ?? String(spokeConfig.defaultChainId));
const lockManagerAddress = process.env.HUB_LOCK_MANAGER_ADDRESS;
const custodyAddress = process.env.HUB_CUSTODY_ADDRESS;
const acrossReceiverAddress = process.env.HUB_ACROSS_RECEIVER_ADDRESS;
const acrossBorrowDispatcherAddress = process.env.HUB_ACROSS_BORROW_DISPATCHER_ADDRESS;
const acrossBorrowFinalizerAddress = process.env.HUB_ACROSS_BORROW_FINALIZER_ADDRESS;
const spokeAcrossSpokePoolAddress = resolveSpokeAddress(spokeConfig.envPrefix, "ACROSS_SPOKE_POOL_ADDRESS");
const spokeBorrowReceiverAddress = resolveSpokeAddress(spokeConfig.envPrefix, "BORROW_RECEIVER_ADDRESS");
const relayerKey = process.env.RELAYER_PRIVATE_KEY;
const indexerApi = process.env.INDEXER_API_URL ?? "http://127.0.0.1:3030";
const proverApi = process.env.PROVER_API_URL ?? "http://127.0.0.1:3050";
const relayerInitialBackfillBlocks = BigInt(process.env.RELAYER_INITIAL_BACKFILL_BLOCKS ?? "2000");
const relayerMaxLogRange = BigInt(process.env.RELAYER_MAX_LOG_RANGE ?? "2000");
const relayerBridgeFinalityBlocks = BigInt(process.env.RELAYER_BRIDGE_FINALITY_BLOCKS ?? "0");
const relayerSpokeFinalityBlocks = BigInt(process.env.RELAYER_SPOKE_FINALITY_BLOCKS ?? relayerBridgeFinalityBlocks.toString());
const relayerHubFinalityBlocks = BigInt(process.env.RELAYER_HUB_FINALITY_BLOCKS ?? relayerBridgeFinalityBlocks.toString());
const apiRateWindowMs = Number(process.env.API_RATE_WINDOW_MS ?? "60000");
const apiRateMaxRequests = Number(process.env.API_RATE_MAX_REQUESTS ?? "1200");
const rateBuckets = new Map();
const acrossApiBaseUrl = process.env.ACROSS_API_URL ?? "https://app.across.to/api";
const acrossAllowUnmatchedDecimals = (process.env.ACROSS_ALLOW_UNMATCHED_DECIMALS ?? "1") !== "0";
const acrossQuoteMaxAttempts = Number(process.env.ACROSS_QUOTE_MAX_ATTEMPTS ?? "3");
const finalizationWorkerIntervalMs = Number(process.env.RELAYER_FINALIZATION_WORKER_INTERVAL_MS ?? "3000");
const finalizationRetryBaseDelayMs = Number(process.env.RELAYER_FINALIZATION_RETRY_BASE_MS ?? "2000");
const finalizationRetryMaxDelayMs = Number(process.env.RELAYER_FINALIZATION_RETRY_MAX_MS ?? "300000");
const finalizationMaxAttempts = Number(process.env.RELAYER_FINALIZATION_MAX_ATTEMPTS ?? "20");
const lockUnwindGraceSeconds = Number(process.env.RELAYER_LOCK_UNWIND_GRACE_SECONDS ?? "1800");
const spokeToHub = JSON.parse(process.env.SPOKE_TO_HUB_TOKEN_MAP ?? "{}");
if (!lockManagerAddress
    || !custodyAddress
    || !acrossReceiverAddress
    || !acrossBorrowDispatcherAddress
    || !acrossBorrowFinalizerAddress
    || !spokeAcrossSpokePoolAddress
    || !spokeBorrowReceiverAddress
    || !relayerKey) {
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
    "function dispatchBorrowFill(bytes32 intentId,uint8 intentType,address user,address recipient,address outputToken,uint256 amount,uint256 outputChainId,uint256 relayerFee,uint256 maxRelayerFee,address hubAsset,(uint256 outputAmount,uint32 quoteTimestamp,uint32 fillDeadline) quote) returns (bytes32)"
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
const spokeBorrowFillRecordedEvent = parseAbiItem("event BorrowFillRecorded(bytes32 indexed intentId,uint8 indexed intentType,address indexed user,address recipient,address spokeToken,address hubAsset,uint256 amount,uint256 fee,address relayer,uint256 sourceChainId,uint256 destinationChainId,address hubDispatcher,address hubFinalizer,bytes32 messageHash)");
const hubPendingDepositRecordedEvent = parseAbiItem("event PendingDepositRecorded(bytes32 indexed pendingId,uint256 indexed sourceChainId,uint256 indexed depositId,uint8 intentType,address user,address spokeToken,address hubAsset,uint256 amount,address tokenReceived,uint256 amountReceived,address relayer,bytes32 messageHash)");
const hubBridgedDepositRegisteredEvent = parseAbiItem("event BridgedDepositRegistered(uint256 indexed depositId, uint8 indexed intentType, address indexed user, address hubAsset, uint256 amount, uint256 originChainId, bytes32 originTxHash, uint256 originLogIndex, bytes32 attestationKey)");
const hubPendingDepositExpiredEvent = parseAbiItem("event PendingDepositExpired(bytes32 indexed pendingId,uint256 indexed sourceChainId,uint256 indexed depositId,uint256 finalizeDeadline,address caller)");
const hubPendingDepositSweptEvent = parseAbiItem("event PendingDepositSwept(bytes32 indexed pendingId,uint256 indexed sourceChainId,uint256 indexed depositId,address token,uint256 amount,address recoveryVault,address caller)");
const statePath = process.env.RELAYER_TRACKING_PATH ?? path.join(process.cwd(), "data", "relayer-tracking.json");
const relayerState = loadRelayerState(statePath);
let isPollingCanonicalBridge = false;
let isProcessingFinalizationQueue = false;
let cachedTokenRegistryAddress;
const hubDecimalsCache = new Map();
const spokeDecimalsCache = new Map();
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
            lastSpokeBlock: relayerState.lastSpokeBlock.toString(),
            lastHubBlock: relayerState.lastHubBlock.toString()
        },
        queue: {
            total: Object.keys(relayerState.tasks).length,
            pending: Object.values(relayerState.tasks).filter((task) => !task.terminal).length,
            terminal: Object.values(relayerState.tasks).filter((task) => task.terminal).length
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
    const fee = (amount * feeBps) / 10000n;
    res.json({ feeBps: Number(feeBps), fee: fee.toString() });
});
app.post("/intent/submit", async (req, res) => {
    const parsed = submitSchema.safeParse(req.body);
    if (!parsed.success) {
        auditLog(req, "submit_rejected", { reason: "invalid_payload" });
        res.status(400).json({ error: parsed.error.flatten() });
        return;
    }
    try {
        const intent = parseIntent(parsed.data.intent);
        const signature = parsed.data.signature;
        const relayerFee = BigInt(parsed.data.relayerFee);
        if (!toOutboundIntentKind(intent.intentType)) {
            auditLog(req, "submit_rejected", { reason: "unsupported_intent_type", intentType: intent.intentType });
            res.status(400).json({ error: "only borrow/withdraw are relayed in this endpoint" });
            return;
        }
        const intentId = rawIntentId(intent);
        const hubAsset = spokeToHub[intent.outputToken.toLowerCase()];
        if (!hubAsset) {
            throw new Error(`No spoke->hub token mapping for ${intent.outputToken}`);
        }
        const preview = await previewHubLock(intent);
        if (preview.asset.toLowerCase() !== hubAsset.toLowerCase()) {
            throw new Error(`preview lock asset mismatch for ${intentId}: expected=${hubAsset} got=${preview.asset}`);
        }
        if (preview.hubAmount <= 0n) {
            throw new Error(`preview lock amount must be > 0 for intent ${intentId}`);
        }
        const acrossQuote = await resolveBorrowDispatchQuote({
            originChainId: hubChainId,
            destinationChainId: intent.outputChainId,
            inputToken: hubAsset,
            outputToken: intent.outputToken,
            amount: preview.hubAmount,
            recipient: spokeBorrowReceiverAddress
        });
        const expiryHint = computeLockExpiryHint(acrossQuote.fillDeadline);
        await upsertIntent(intentId, intent, "pending_lock", {
            relayerFee: relayerFee.toString(),
            relayer: relayerAccount.address,
            lockAmountPreview: preview.hubAmount.toString(),
            lockMaxExpiry: preview.maxExpiry.toString(),
            fillDeadline: acrossQuote.fillDeadline
        });
        const lockTx = await hubWallet.writeContract({
            abi: HubLockManagerAbi,
            address: lockManagerAddress,
            functionName: "lock",
            args: [intent, signature, expiryHint],
            account: relayerAccount
        });
        const lockReceipt = await hubPublic.waitForTransactionReceipt({ hash: lockTx });
        const lockState = await fetchLockState(intentId, lockReceipt.blockNumber).catch(async (error) => {
            if (!isUnknownBlockReadError(error))
                throw error;
            return fetchLockState(intentId);
        });
        const lockAmount = lockState.amount;
        const lockExpiry = lockState.expiry;
        if (lockAmount <= 0n) {
            throw new Error(`lock amount must be > 0 for intent ${intentId}`);
        }
        const relayerHubBalance = await hubPublic.readContract({
            abi: erc20Abi,
            address: hubAsset,
            functionName: "balanceOf",
            args: [relayerAccount.address]
        });
        if (relayerHubBalance < lockAmount) {
            throw new Error(`insufficient relayer hub liquidity for ${hubAsset}: need ${lockAmount.toString()} have ${relayerHubBalance.toString()}`);
        }
        let dispatchTx;
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
        }
        catch (dispatchError) {
            const cancelTx = await cancelLockBestEffort(intentId);
            await updateIntentStatus(intentId, "failed", {
                lockTx,
                lockAmount: lockAmount.toString(),
                lockCancelTx: cancelTx,
                error: dispatchError.message
            }).catch((statusError) => {
                console.warn("Failed to persist intent failure status", statusError);
            });
            throw dispatchError;
        }
        await updateIntentStatus(intentId, "locked", {
            lockTx,
            dispatchTx,
            lockAmount: lockAmount.toString(),
            lockExpiry: lockExpiry.toString(),
            lockExpiryIso: new Date(Number(lockExpiry) * 1000).toISOString(),
            quoteTimestamp: acrossQuote.quoteTimestamp,
            fillDeadline: acrossQuote.fillDeadline,
            fillDeadlineIso: new Date(acrossQuote.fillDeadline * 1000).toISOString(),
            lockExpiryHint: expiryHint.toString()
        });
        enqueueLockUnwindTask({
            intentId,
            lockAmount,
            lockExpiry,
            fillDeadline: BigInt(acrossQuote.fillDeadline),
            hubAsset,
            lockTx,
            dispatchTx
        });
        saveRelayerRuntimeState();
        auditLog(req, "submit_ok", {
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
    }
    catch (error) {
        auditLog(req, "submit_error", { message: error.message });
        res.status(500).json({ error: error.message });
    }
});
app.listen(port, () => {
    console.log(`Relayer API listening on :${port}`);
    setInterval(() => {
        pollAcrossBridge().catch((error) => {
            console.error("Relayer poll error", error);
        });
    }, 5_000);
    setInterval(() => {
        processFinalizationQueue().catch((error) => {
            console.error("Relayer finalization queue error", error);
        });
    }, finalizationWorkerIntervalMs);
});
async function pollAcrossBridge() {
    if (isPollingCanonicalBridge)
        return;
    isPollingCanonicalBridge = true;
    try {
        await pollSpokeDeposits();
        await pollHubDeposits();
    }
    finally {
        isPollingCanonicalBridge = false;
    }
}
function rawIntentId(intent) {
    return keccak256(encodeAbiParameters([
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
    ], [intent]));
}
async function pollSpokeDeposits() {
    const latestBlock = await spokePublic.getBlockNumber();
    if (latestBlock < relayerState.lastSpokeBlock) {
        // Local anvil restarts can rewind chain height; restart scanning from genesis.
        relayerState.lastSpokeBlock = 0n;
    }
    const finalizedToBlock = latestBlock > relayerSpokeFinalityBlocks
        ? latestBlock - relayerSpokeFinalityBlocks
        : 0n;
    if (finalizedToBlock === 0n)
        return;
    if (relayerState.lastSpokeBlock === 0n && finalizedToBlock > relayerInitialBackfillBlocks) {
        relayerState.lastSpokeBlock = finalizedToBlock - relayerInitialBackfillBlocks;
    }
    const fromBlock = relayerState.lastSpokeBlock + 1n;
    if (finalizedToBlock < fromBlock)
        return;
    const rangeToBlock = fromBlock + relayerMaxLogRange - 1n < finalizedToBlock
        ? fromBlock + relayerMaxLogRange - 1n
        : finalizedToBlock;
    auditLog(undefined, "poll_spoke_range", {
        fromBlock: fromBlock.toString(),
        toBlock: rangeToBlock.toString(),
        latest: latestBlock.toString(),
        finalizedToBlock: finalizedToBlock.toString()
    });
    const canonicalAcrossDepositLogs = await spokePublic.getLogs({
        address: spokeAcrossSpokePoolAddress,
        event: spokeFundsDepositedEvent,
        fromBlock,
        toBlock: rangeToBlock
    });
    const mockAcrossDepositLogs = await spokePublic.getLogs({
        address: spokeAcrossSpokePoolAddress,
        event: spokeV3FundsDepositedEvent,
        fromBlock,
        toBlock: rangeToBlock
    });
    const acrossDepositLogs = collectNormalizedSpokeDepositLogs({
        canonicalLogs: canonicalAcrossDepositLogs,
        mockLogs: mockAcrossDepositLogs
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
    relayerState.lastSpokeBlock = rangeToBlock;
    saveRelayerRuntimeState();
}
async function handleAcrossDepositLog(log, finalizedToBlock) {
    const { message, outputToken, recipient, outputAmount, destinationChainId, originTxHash, spokeObservedBlock, originLogIndex } = log;
    if (recipient.toLowerCase() !== acrossReceiverAddress.toLowerCase()) {
        return;
    }
    const decoded = decodeAcrossDepositMessage(message);
    if (!decoded) {
        console.warn("Skipping Across deposit log with undecodable message payload");
        return;
    }
    const { depositId, intentType, user, spokeToken, hubAsset, amount, sourceChainId, destinationChainId: messageDestinationChainId } = decoded;
    if (intentType !== IntentType.SUPPLY && intentType !== IntentType.REPAY) {
        return;
    }
    if (messageDestinationChainId !== hubChainId || destinationChainId !== hubChainId) {
        console.warn(`Skipping deposit ${depositId.toString()} due to destination chain mismatch`);
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
        console.warn(`Skipping deposit ${depositId.toString()} due to hub token mismatch in Across message`);
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
    const sourceReceiptsRoot = asHexString(sourceBlock.receiptsRoot);
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
        intentType: intentType,
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
    const witness = {
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
    const sourceEvidence = {
        sourceBlockNumber: spokeObservedBlock,
        sourceBlockHash,
        sourceReceiptsRoot,
        sourceSpokePool: spokeAcrossSpokePoolAddress
    };
    enqueueDepositFinalizationTask({
        pendingId,
        witness,
        sourceEvidence,
        sourceChainId,
        depositId,
        intentType: intentType,
        user,
        hubAsset,
        amount
    });
}
async function handleSpokeBorrowFillLog(log, finalizedToBlock) {
    const intentId = log.args.intentId;
    const rawIntentType = asBigInt(log.args.intentType);
    const user = log.args.user;
    const recipient = log.args.recipient;
    const spokeToken = log.args.spokeToken;
    const hubAsset = log.args.hubAsset;
    const amount = asBigInt(log.args.amount);
    const fee = asBigInt(log.args.fee);
    const relayer = log.args.relayer;
    const destinationChainId = asBigInt(log.args.destinationChainId);
    const hubDispatcher = log.args.hubDispatcher;
    const hubFinalizer = log.args.hubFinalizer;
    const messageHash = log.args.messageHash;
    const sourceTxHash = log.transactionHash;
    const sourceLogIndex = typeof log.logIndex === "bigint" ? log.logIndex : BigInt(log.logIndex ?? 0);
    const spokeObservedBlock = log.blockNumber ?? 0n;
    if (!intentId
        || rawIntentType === undefined
        || !user
        || !recipient
        || !spokeToken
        || !hubAsset
        || amount === undefined
        || fee === undefined
        || !relayer
        || destinationChainId === undefined
        || !hubDispatcher
        || !hubFinalizer
        || !messageHash
        || !sourceTxHash) {
        console.warn("Skipping outbound fill log with missing fields");
        return;
    }
    const intentType = Number(rawIntentType);
    const outboundKind = toOutboundIntentKind(intentType);
    if (!outboundKind)
        return;
    if (fee >= amount) {
        console.warn(`Skipping outbound fill ${intentId} due to invalid fee`);
        return;
    }
    if (destinationChainId !== spokeChainId) {
        console.warn(`Skipping outbound fill ${intentId} due to chain mismatch`);
        return;
    }
    if (hubDispatcher.toLowerCase() !== acrossBorrowDispatcherAddress.toLowerCase()) {
        console.warn(`Skipping outbound fill ${intentId} due to hub dispatcher mismatch`);
        return;
    }
    if (hubFinalizer.toLowerCase() !== acrossBorrowFinalizerAddress.toLowerCase()) {
        console.warn(`Skipping outbound fill ${intentId} due to hub finalizer mismatch`);
        return;
    }
    const existing = await fetchIntent(intentId);
    if (existing?.status === "settled" || existing?.status === "awaiting_settlement") {
        delete relayerState.tasks[lockUnwindTaskId(intentId)];
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
    const sourceReceiptsRoot = asHexString(sourceBlock.receiptsRoot);
    if (!sourceBlockHash || !sourceReceiptsRoot) {
        console.warn(`Skipping outbound fill ${intentId} due to missing source block hash/receipts root`);
        return;
    }
    const hubFill = await convertSpokeFillToHubUnits(spokeChainId, hubAsset, amount, fee).catch((error) => {
        console.warn(`Skipping outbound fill ${intentId} due to conversion failure: ${error.message}`);
        return undefined;
    });
    if (!hubFill || hubFill.amount === 0n || hubFill.fee >= hubFill.amount) {
        console.warn(`Skipping outbound fill ${intentId} due to invalid hub-unit conversion`);
        return;
    }
    const lockState = await fetchLockState(intentId).catch(() => undefined);
    if (lockState && hubFill.amount > lockState.amount) {
        console.warn(`Skipping outbound fill ${intentId} because converted amount exceeds lock`);
        return;
    }
    const witness = {
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
    const sourceEvidence = {
        sourceBlockNumber: spokeObservedBlock,
        sourceBlockHash,
        sourceReceiptsRoot,
        sourceReceiver: spokeBorrowReceiverAddress
    };
    delete relayerState.tasks[lockUnwindTaskId(intentId)];
    enqueueBorrowFillFinalizationTask({
        intentId,
        outboundKind,
        witness,
        sourceEvidence,
        user,
        hubAsset,
        hubAmount: hubFill.amount,
        hubFee: hubFill.fee,
        relayer,
        sourceTxHash,
        sourceLogIndex,
        spokeObservedBlock,
        spokeFinalizedToBlock: finalizedToBlock
    });
}
async function pollHubDeposits() {
    const latestBlock = await hubPublic.getBlockNumber();
    if (latestBlock < relayerState.lastHubBlock) {
        relayerState.lastHubBlock = 0n;
    }
    const finalizedToBlock = latestBlock > relayerHubFinalityBlocks
        ? latestBlock - relayerHubFinalityBlocks
        : 0n;
    if (finalizedToBlock === 0n)
        return;
    if (relayerState.lastHubBlock === 0n && finalizedToBlock > relayerInitialBackfillBlocks) {
        relayerState.lastHubBlock = finalizedToBlock - relayerInitialBackfillBlocks;
    }
    const fromBlock = relayerState.lastHubBlock + 1n;
    if (finalizedToBlock < fromBlock)
        return;
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
    const expiredLogs = await hubPublic.getLogs({
        address: acrossReceiverAddress,
        event: hubPendingDepositExpiredEvent,
        fromBlock,
        toBlock: rangeToBlock
    });
    for (const log of expiredLogs) {
        await handleHubPendingDepositExpiredLog(log);
    }
    const sweptLogs = await hubPublic.getLogs({
        address: acrossReceiverAddress,
        event: hubPendingDepositSweptEvent,
        fromBlock,
        toBlock: rangeToBlock
    });
    for (const log of sweptLogs) {
        await handleHubPendingDepositSweptLog(log);
    }
    relayerState.lastHubBlock = rangeToBlock;
    saveRelayerRuntimeState();
}
function depositFinalizationTaskId(pendingId) {
    return `deposit:${pendingId.toLowerCase()}`;
}
function borrowFillFinalizationTaskId(witness) {
    return [
        "borrow",
        witness.intentId.toLowerCase(),
        witness.sourceTxHash.toLowerCase(),
        witness.sourceLogIndex.toString(),
        witness.messageHash.toLowerCase()
    ].join(":");
}
function lockUnwindTaskId(intentId) {
    return `lock-unwind:${intentId.toLowerCase()}`;
}
function enqueueDepositFinalizationTask(input) {
    const id = depositFinalizationTaskId(input.pendingId);
    const now = Date.now();
    const existing = relayerState.tasks[id];
    if (existing?.terminal)
        return;
    const payload = {
        pendingId: input.pendingId,
        witness: toDepositWitnessWire(input.witness),
        sourceEvidence: toSourceDepositEvidenceWire(input.sourceEvidence),
        sourceChainId: input.sourceChainId.toString(),
        depositId: input.depositId.toString(),
        intentType: input.intentType,
        user: input.user,
        hubAsset: input.hubAsset,
        amount: input.amount.toString()
    };
    relayerState.tasks[id] = {
        id,
        kind: "deposit_finalization",
        payload,
        attempts: existing?.attempts ?? 0,
        nextAttemptAt: existing ? Math.min(existing.nextAttemptAt, now) : now,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
    };
}
function enqueueBorrowFillFinalizationTask(input) {
    const id = borrowFillFinalizationTaskId(input.witness);
    const now = Date.now();
    const existing = relayerState.tasks[id];
    if (existing?.terminal)
        return;
    const payload = {
        intentId: input.intentId,
        outboundKind: input.outboundKind,
        witness: toBorrowFillWitnessWire(input.witness),
        sourceEvidence: toSourceBorrowFillEvidenceWire(input.sourceEvidence),
        user: input.user,
        hubAsset: input.hubAsset,
        hubAmount: input.hubAmount.toString(),
        hubFee: input.hubFee.toString(),
        relayer: input.relayer,
        sourceTxHash: input.sourceTxHash,
        sourceLogIndex: input.sourceLogIndex.toString(),
        spokeObservedBlock: input.spokeObservedBlock.toString(),
        spokeFinalizedToBlock: input.spokeFinalizedToBlock.toString()
    };
    relayerState.tasks[id] = {
        id,
        kind: "borrow_fill_finalization",
        payload,
        attempts: existing?.attempts ?? 0,
        nextAttemptAt: existing ? Math.min(existing.nextAttemptAt, now) : now,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
    };
}
function enqueueLockUnwindTask(input) {
    const id = lockUnwindTaskId(input.intentId);
    const now = Date.now();
    const existing = relayerState.tasks[id];
    if (existing?.terminal)
        return;
    const nextAttemptAt = bigintTimestampToMs(input.lockExpiry);
    const payload = {
        intentId: input.intentId,
        lockAmount: input.lockAmount.toString(),
        lockExpiry: input.lockExpiry.toString(),
        fillDeadline: input.fillDeadline.toString(),
        hubAsset: input.hubAsset,
        lockTx: input.lockTx,
        dispatchTx: input.dispatchTx
    };
    relayerState.tasks[id] = {
        id,
        kind: "lock_unwind",
        payload,
        attempts: existing?.attempts ?? 0,
        nextAttemptAt: existing ? Math.min(existing.nextAttemptAt, nextAttemptAt) : nextAttemptAt,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
    };
}
async function processFinalizationQueue() {
    if (isProcessingFinalizationQueue)
        return;
    isProcessingFinalizationQueue = true;
    try {
        const now = Date.now();
        const due = Object.values(relayerState.tasks)
            .filter((task) => !task.terminal && task.nextAttemptAt <= now)
            .sort((a, b) => (a.nextAttemptAt - b.nextAttemptAt
            || a.createdAt - b.createdAt));
        for (const task of due) {
            await processFinalizationTask(task);
        }
    }
    finally {
        isProcessingFinalizationQueue = false;
    }
}
async function processFinalizationTask(task) {
    const now = Date.now();
    task.attempts += 1;
    task.updatedAt = now;
    try {
        if (task.kind === "deposit_finalization") {
            await runDepositFinalizationTask(task);
        }
        else if (task.kind === "borrow_fill_finalization") {
            await runBorrowFillFinalizationTask(task);
        }
        else if (task.kind === "lock_unwind") {
            await runLockUnwindTask(task);
        }
        else {
            task.terminal = true;
            task.terminalReason = "unknown_task_kind";
            task.lastError = `unsupported task kind ${task.kind ?? "unknown"}`;
        }
    }
    catch (error) {
        const message = error.message;
        const terminalFailure = task.kind === "deposit_finalization"
            ? isTerminalDepositFinalizationError(message)
            : task.kind === "borrow_fill_finalization"
                ? isTerminalBorrowFinalizationError(message)
                : isTerminalLockUnwindError(message);
        if (terminalFailure || task.attempts >= finalizationMaxAttempts) {
            task.terminal = true;
            task.terminalReason = terminalFailure ? "terminal_contract_failure" : "max_attempts_exhausted";
            task.lastError = message;
            task.updatedAt = Date.now();
            if (task.kind === "deposit_finalization") {
                const payload = task.payload;
                await upsertDepositFinalizationStatus(payload, "finalization_failed", {
                    terminalReason: task.terminalReason,
                    retryCount: task.attempts,
                    lastError: message
                }).catch((statusError) => {
                    console.warn(`Failed to persist terminal deposit status ${payload.depositId}`, statusError);
                });
            }
            else if (task.kind === "borrow_fill_finalization") {
                const payload = task.payload;
                const cancelTx = await cancelLockBestEffort(payload.intentId);
                await updateIntentStatus(payload.intentId, "failed", {
                    error: message,
                    lockCancelTx: cancelTx,
                    retryCount: task.attempts,
                    terminalReason: task.terminalReason
                }).catch((statusError) => {
                    console.warn(`Failed to persist borrow terminal failure ${payload.intentId}`, statusError);
                });
                delete relayerState.tasks[lockUnwindTaskId(payload.intentId)];
            }
            else if (task.kind === "lock_unwind") {
                const payload = task.payload;
                await updateIntentStatus(payload.intentId, "failed", {
                    error: message,
                    retryCount: task.attempts,
                    terminalReason: task.terminalReason,
                    lockExpiry: payload.lockExpiry
                }).catch((statusError) => {
                    console.warn(`Failed to persist unwind terminal failure ${payload.intentId}`, statusError);
                });
            }
        }
        else {
            task.lastError = message;
            task.nextAttemptAt = now + computeRetryDelayMs(task.attempts);
            task.updatedAt = Date.now();
            if (task.kind === "deposit_finalization") {
                const payload = task.payload;
                await upsertDepositFinalizationStatus(payload, "finalization_retry", {
                    retryCount: task.attempts,
                    nextRetryAt: new Date(task.nextAttemptAt).toISOString(),
                    lastError: message
                }).catch((statusError) => {
                    console.warn(`Failed to persist retry deposit status ${payload.depositId}`, statusError);
                });
            }
        }
    }
    finally {
        saveRelayerRuntimeState();
    }
}
async function runDepositFinalizationTask(task) {
    const payload = task.payload;
    const witness = fromDepositWitnessWire(payload.witness);
    const sourceEvidence = fromSourceDepositEvidenceWire(payload.sourceEvidence);
    try {
        const finalizeTx = await attemptFinalizePendingDeposit(payload.pendingId, witness, sourceEvidence);
        auditLog(undefined, "deposit_fill_finalized", {
            taskId: task.id,
            pendingId: payload.pendingId,
            finalizeTx,
            depositId: payload.depositId
        });
        delete relayerState.tasks[task.id];
    }
    catch (error) {
        const message = error.message.toLowerCase();
        if (message.includes("pendingalreadyfinalized") || message.includes("finalizationreplay")) {
            delete relayerState.tasks[task.id];
            return;
        }
        throw error;
    }
}
async function runBorrowFillFinalizationTask(task) {
    const payload = task.payload;
    delete relayerState.tasks[lockUnwindTaskId(payload.intentId)];
    const witness = fromBorrowFillWitnessWire(payload.witness);
    const sourceEvidence = fromSourceBorrowFillEvidenceWire(payload.sourceEvidence);
    let finalizeTx;
    try {
        finalizeTx = await attemptFinalizeBorrowFill(witness, sourceEvidence, payload.intentId);
    }
    catch (error) {
        const message = error.message.toLowerCase();
        if (!message.includes("finalizationreplay")) {
            throw error;
        }
    }
    await updateIntentStatus(payload.intentId, "filled", {
        spokeBorrowFillTx: payload.sourceTxHash,
        spokeBorrowFillLogIndex: payload.sourceLogIndex,
        spokeObservedBlock: payload.spokeObservedBlock,
        spokeFinalizedToBlock: payload.spokeFinalizedToBlock,
        borrowFillFinalizeTx: finalizeTx
    });
    await enqueueProverAction({
        kind: payload.outboundKind,
        intentId: payload.intentId,
        user: payload.user,
        hubAsset: payload.hubAsset,
        amount: payload.hubAmount,
        fee: payload.hubFee,
        relayer: payload.relayer
    });
    await updateIntentStatus(payload.intentId, "awaiting_settlement", {
        spokeBorrowFillTx: payload.sourceTxHash,
        borrowFillFinalizeTx: finalizeTx
    });
    delete relayerState.tasks[task.id];
}
async function runLockUnwindTask(task) {
    const payload = task.payload;
    const current = await fetchIntent(payload.intentId).catch(() => undefined);
    if (current && shouldDropLockUnwindTask(current.status)) {
        delete relayerState.tasks[task.id];
        return;
    }
    const lockExpiry = BigInt(payload.lockExpiry);
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    if (nowSec < lockExpiry) {
        task.nextAttemptAt = bigintTimestampToMs(lockExpiry);
        task.updatedAt = Date.now();
        return;
    }
    try {
        const cancelTx = await cancelExpiredLockBestEffort(payload.intentId);
        if (!cancelTx) {
            delete relayerState.tasks[task.id];
            return;
        }
        await updateIntentStatus(payload.intentId, "expired_unwound", {
            lockCancelTx: cancelTx,
            lockExpiry: payload.lockExpiry,
            fillDeadline: payload.fillDeadline,
            lockAmount: payload.lockAmount,
            hubAsset: payload.hubAsset,
            lockTx: payload.lockTx,
            dispatchTx: payload.dispatchTx
        });
        auditLog(undefined, "lock_expiry_unwound", {
            taskId: task.id,
            intentId: payload.intentId,
            cancelTx,
            lockExpiry: payload.lockExpiry
        });
        delete relayerState.tasks[task.id];
    }
    catch (error) {
        const message = String(error.message ?? "").toLowerCase();
        if (message.includes("locknotexpired")) {
            task.nextAttemptAt = Date.now() + 15_000;
            task.updatedAt = Date.now();
            return;
        }
        if (message.includes("locknotactive") || message.includes("locknotfound")) {
            delete relayerState.tasks[task.id];
            return;
        }
        throw error;
    }
}
async function handleHubPendingDepositLog(log, finalizedToBlock) {
    const pendingId = log.args.pendingId;
    const sourceChainId = asBigInt(log.args.sourceChainId);
    const depositId = asBigInt(log.args.depositId);
    const rawIntentType = asBigInt(log.args.intentType);
    const user = log.args.user;
    const spokeToken = log.args.spokeToken;
    const hubAsset = log.args.hubAsset;
    const amount = asBigInt(log.args.amount);
    const tokenReceived = log.args.tokenReceived;
    const amountReceived = asBigInt(log.args.amountReceived);
    const messageHash = log.args.messageHash;
    const hubObservedBlock = log.blockNumber ?? 0n;
    if (!pendingId
        || sourceChainId === undefined
        || depositId === undefined
        || rawIntentType === undefined
        || !user
        || !spokeToken
        || !hubAsset
        || amount === undefined
        || !tokenReceived
        || amountReceived === undefined
        || !messageHash) {
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
        intentType: intentType,
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
    if (!sourceTxHash
        || sourceLogIndex === undefined
        || sourceBlockNumber === undefined
        || !sourceBlockHash
        || !sourceReceiptsRoot
        || !sourceSpokePool) {
        console.warn(`Pending deposit ${depositId.toString()} is missing source proof metadata; waiting for spoke source observation`);
        return;
    }
    const witness = {
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
    const sourceEvidence = {
        sourceBlockNumber,
        sourceBlockHash,
        sourceReceiptsRoot,
        sourceSpokePool
    };
    enqueueDepositFinalizationTask({
        pendingId,
        witness,
        sourceEvidence,
        sourceChainId,
        depositId,
        intentType: intentType,
        user,
        hubAsset,
        amount
    });
}
async function handleHubBridgedDepositLog(log, finalizedToBlock) {
    const depositId = asBigInt(log.args.depositId);
    const rawIntentType = asBigInt(log.args.intentType);
    const user = log.args.user;
    const hubAsset = log.args.hubAsset;
    const amount = asBigInt(log.args.amount);
    const originChainId = asBigInt(log.args.originChainId);
    const originTxHash = log.args.originTxHash;
    const originLogIndex = asBigInt(log.args.originLogIndex);
    const attestationKey = log.args.attestationKey;
    const hubObservedBlock = log.blockNumber ?? 0n;
    if (depositId === undefined
        || rawIntentType === undefined
        || !user
        || !hubAsset
        || amount === undefined
        || originChainId === undefined
        || !originTxHash
        || originLogIndex === undefined) {
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
        intentType: intentType,
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
async function handleHubPendingDepositExpiredLog(log) {
    const pendingId = log.args.pendingId;
    const sourceChainId = asBigInt(log.args.sourceChainId);
    const depositId = asBigInt(log.args.depositId);
    const finalizeDeadline = asBigInt(log.args.finalizeDeadline);
    if (!pendingId || sourceChainId === undefined || depositId === undefined)
        return;
    const existing = await fetchDeposit(sourceChainId, depositId);
    if (!existing || existing.status === "bridged" || existing.status === "settled" || existing.status === "swept") {
        return;
    }
    await postInternal(indexerApi, "/internal/deposits/upsert", {
        sourceChainId: Number(sourceChainId),
        depositId: Number(depositId),
        user: existing.user,
        intentType: existing.intentType,
        token: existing.token,
        amount: existing.amount,
        status: "expired",
        metadata: {
            pendingId,
            expiredTx: log.transactionHash ?? "0x",
            finalizeDeadline: finalizeDeadline?.toString()
        }
    });
}
async function handleHubPendingDepositSweptLog(log) {
    const pendingId = log.args.pendingId;
    const sourceChainId = asBigInt(log.args.sourceChainId);
    const depositId = asBigInt(log.args.depositId);
    const token = log.args.token;
    const amount = asBigInt(log.args.amount);
    const recoveryVault = log.args.recoveryVault;
    if (!pendingId || sourceChainId === undefined || depositId === undefined)
        return;
    delete relayerState.tasks[depositFinalizationTaskId(pendingId)];
    const existing = await fetchDeposit(sourceChainId, depositId);
    if (!existing || existing.status === "bridged" || existing.status === "settled") {
        return;
    }
    await postInternal(indexerApi, "/internal/deposits/upsert", {
        sourceChainId: Number(sourceChainId),
        depositId: Number(depositId),
        user: existing.user,
        intentType: existing.intentType,
        token: existing.token,
        amount: existing.amount,
        status: "swept",
        metadata: {
            pendingId,
            sweptTx: log.transactionHash ?? "0x",
            sweptToken: token,
            sweptAmount: amount?.toString(),
            recoveryVault
        }
    });
}
async function fetchDeposit(sourceChainId, depositId) {
    const scoped = await fetch(`${indexerApi}/deposits/${sourceChainId.toString()}/${depositId.toString()}`).catch(() => null);
    if (scoped?.ok) {
        return (await scoped.json());
    }
    const legacy = await fetch(`${indexerApi}/deposits/${depositId.toString()}`).catch(() => null);
    if (!legacy || !legacy.ok)
        return undefined;
    return (await legacy.json());
}
async function fetchIntent(intentId) {
    const existing = await fetch(`${indexerApi}/intents/${intentId}`).catch(() => null);
    if (!existing || !existing.ok)
        return undefined;
    return (await existing.json());
}
async function upsertDepositFinalizationStatus(payload, status, metadata) {
    const sourceChainId = BigInt(payload.sourceChainId);
    const depositId = BigInt(payload.depositId);
    const existing = await fetchDeposit(sourceChainId, depositId);
    if (existing?.status === "bridged" || existing?.status === "settled" || existing?.status === "swept") {
        return;
    }
    await postInternal(indexerApi, "/internal/deposits/upsert", {
        sourceChainId: Number(sourceChainId),
        depositId: Number(depositId),
        user: payload.user,
        intentType: payload.intentType,
        token: payload.hubAsset,
        amount: payload.amount,
        status,
        metadata: {
            pendingId: payload.pendingId,
            ...metadata
        }
    });
}
async function fetchLockState(intentId, blockNumber) {
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const lock = await hubPublic.readContract({
            abi: HubLockManagerAbi,
            address: lockManagerAddress,
            functionName: "locks",
            args: [intentId],
            ...(blockNumber !== undefined ? { blockNumber } : {})
        });
        const amount = asBigInt(lock.amount
            ?? (Array.isArray(lock) ? lock[4] : undefined));
        const expiry = asBigInt(lock.expiry
            ?? (Array.isArray(lock) ? lock[7] : undefined));
        const status = asNumber(lock.status
            ?? (Array.isArray(lock) ? lock[8] : undefined));
        if (amount !== undefined && amount > 0n && expiry !== undefined && status !== undefined) {
            return { amount, expiry, status };
        }
        if ((amount !== undefined || expiry !== undefined || status !== undefined) && blockNumber !== undefined) {
            // Receipt block should already include the lock write, but some RPC backends can lag briefly.
            await sleep(200 * attempt);
            continue;
        }
        if (amount !== undefined && expiry !== undefined && status !== undefined) {
            return { amount, expiry, status };
        }
        await sleep(100 * attempt);
    }
    throw new Error(`unable to read lock state for ${intentId}`);
}
async function cancelLockBestEffort(intentId) {
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
    }
    catch (error) {
        console.warn(`Failed to cancel active lock ${intentId}`, error);
        return undefined;
    }
}
async function cancelExpiredLockBestEffort(intentId) {
    const existing = await fetchLockState(intentId).catch(() => undefined);
    if (!existing || existing.status !== 1)
        return undefined;
    try {
        const cancelTx = await hubWallet.writeContract({
            abi: HubLockManagerAbi,
            address: lockManagerAddress,
            functionName: "cancelExpiredLock",
            args: [intentId],
            account: relayerAccount
        });
        await hubPublic.waitForTransactionReceipt({ hash: cancelTx });
        return cancelTx;
    }
    catch (error) {
        console.warn(`Failed to cancel expired lock ${intentId}`, error);
        throw error;
    }
}
async function previewHubLock(intent) {
    const preview = await hubPublic.readContract({
        abi: HubLockManagerAbi,
        address: lockManagerAddress,
        functionName: "previewLock",
        args: [intent]
    });
    const asset = asAddress(preview.asset
        ?? (Array.isArray(preview) ? preview[0] : undefined));
    const hubAmount = asBigInt(preview.hubAmount
        ?? (Array.isArray(preview) ? preview[1] : undefined));
    const maxExpiry = asBigInt(preview.maxExpiry
        ?? (Array.isArray(preview) ? preview[2] : undefined));
    if (!asset || hubAmount === undefined || maxExpiry === undefined) {
        throw new Error("unable to decode lock preview");
    }
    return { asset, hubAmount, maxExpiry };
}
async function resolveTokenRegistryAddress() {
    if (cachedTokenRegistryAddress)
        return cachedTokenRegistryAddress;
    const tokenRegistry = await hubPublic.readContract({
        abi: HubLockManagerAbi,
        address: lockManagerAddress,
        functionName: "tokenRegistry"
    });
    cachedTokenRegistryAddress = tokenRegistry;
    return tokenRegistry;
}
async function resolveRouteDecimals(sourceChainId, hubAsset) {
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
        const parsed = asNumber(cfg.decimals);
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
async function convertSpokeFillToHubUnits(sourceChainId, hubAsset, amount, fee) {
    const { hubDecimals, spokeDecimals } = await resolveRouteDecimals(sourceChainId, hubAsset);
    return {
        amount: scaleAmountUnits(amount, spokeDecimals, hubDecimals),
        fee: scaleAmountUnits(fee, spokeDecimals, hubDecimals)
    };
}
async function enqueueProverAction(body) {
    await postInternal(proverApi, "/internal/enqueue", body);
}
async function fetchDepositProof(witness, sourceEvidence) {
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
    });
    const proof = asHexString(response?.proof);
    if (!proof) {
        throw new Error("prover response missing proof");
    }
    return proof;
}
async function fetchBorrowFillProof(witness, sourceEvidence) {
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
        destinationDispatcher: acrossBorrowDispatcherAddress,
        destinationFinalizer: acrossBorrowFinalizerAddress,
        destinationChainId: hubChainId.toString()
    });
    const proof = asHexString(response?.proof);
    if (!proof) {
        throw new Error("prover response missing outbound fill proof");
    }
    return proof;
}
async function attemptFinalizePendingDeposit(pendingId, witness, sourceEvidence) {
    const proof = await fetchDepositProof(witness, sourceEvidence);
    const finalizeTx = await hubWallet.writeContract({
        abi: acrossReceiverAbi,
        address: acrossReceiverAddress,
        functionName: "finalizePendingDeposit",
        args: [pendingId, proof, witness],
        account: relayerAccount
    });
    await hubPublic.waitForTransactionReceipt({ hash: finalizeTx });
    return finalizeTx;
}
async function attemptFinalizeBorrowFill(witness, sourceEvidence, intentId) {
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
async function upsertIntent(intentId, intent, status, metadata) {
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
async function updateIntentStatus(intentId, status, metadata) {
    await postInternal(indexerApi, `/internal/intents/${intentId}/status`, { status, metadata });
}
function parseIntent(payload) {
    return {
        intentType: payload.intentType,
        user: payload.user,
        inputChainId: BigInt(payload.inputChainId),
        outputChainId: BigInt(payload.outputChainId),
        inputToken: payload.inputToken,
        outputToken: payload.outputToken,
        amount: BigInt(payload.amount),
        recipient: payload.recipient,
        maxRelayerFee: BigInt(payload.maxRelayerFee),
        nonce: BigInt(payload.nonce),
        deadline: BigInt(payload.deadline)
    };
}
async function resolveBorrowDispatchQuote(params) {
    const fallback = defaultAcrossQuote(params.amount);
    if (!isLiveMode)
        return fallback;
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
    let lastError;
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
            const isAmountTooLow = payload.isAmountTooLow === true;
            if (outputAmount === undefined) {
                throw new Error("Across quote missing output amount");
            }
            if (outputAmount <= 0n || isAmountTooLow) {
                const minDeposit = asBigInt(payload.limits?.minDeposit);
                const relayFee = asBigInt(payload.totalRelayFee?.total);
                throw new Error(`Across quote amount too low for route amount=${params.amount.toString()} output=${outputAmount.toString()} minDeposit=${(minDeposit ?? 0n).toString()} relayFee=${(relayFee ?? 0n).toString()}`);
            }
            if (!Number.isInteger(quoteTimestamp) || quoteTimestamp <= 0) {
                throw new Error("Across quote missing quoteTimestamp");
            }
            if (!Number.isInteger(fillDeadline) || fillDeadline <= quoteTimestamp) {
                throw new Error("Across quote missing/invalid fillDeadline");
            }
            return {
                outputAmount,
                quoteTimestamp,
                fillDeadline
            };
        }
        catch (error) {
            const wrapped = new Error(`Across quote resolution failed: ${error.message}`);
            lastError = wrapped;
            if (attempt < acrossQuoteMaxAttempts && isRetryableAcrossQuoteError(error)) {
                await sleep(300 * attempt);
                continue;
            }
            throw wrapped;
        }
        finally {
            clearTimeout(timeout);
        }
    }
    throw lastError ?? new Error("Across quote resolution failed");
}
function parseAcrossOutputAmount(payload, inputAmount) {
    const direct = asBigInt(payload.outputAmount ?? payload.expectedOutputAmount ?? payload.estimatedFillAmount ?? payload.amountToReceive);
    if (direct !== undefined)
        return direct;
    const totalRelayFee = asBigInt(payload.totalRelayFee?.total
        ?? payload.fees?.totalRelayFee?.total);
    if (totalRelayFee !== undefined && totalRelayFee <= inputAmount) {
        return inputAmount - totalRelayFee;
    }
    return undefined;
}
function parseAcrossPayload(rawBody) {
    if (!rawBody)
        return {};
    try {
        const parsed = JSON.parse(rawBody);
        return typeof parsed === "object" && parsed ? parsed : {};
    }
    catch {
        return {};
    }
}
function parseAcrossErrorCode(rawBody) {
    const payload = parseAcrossPayload(rawBody);
    return typeof payload.code === "string" ? payload.code : undefined;
}
function isRetryableAcrossQuoteError(error) {
    const message = String(error?.message ?? "").toLowerCase();
    return (message.includes("timed out")
        || message.includes("timeout")
        || message.includes("aborted")
        || message.includes("fetch failed")
        || message.includes("network")
        || message.includes("502")
        || message.includes("503")
        || message.includes("504")
        || message.includes("429"));
}
function isTerminalDepositFinalizationError(message) {
    const normalized = message.toLowerCase();
    return (normalized.includes("invaliddepositproof")
        || normalized.includes("witnessmismatch")
        || normalized.includes("pendingfillmismatch")
        || normalized.includes("pendingnotfound")
        || normalized.includes("pendingalreadyswept")
        || normalized.includes("pendinginvalidstate"));
}
function isTerminalBorrowFinalizationError(message) {
    const normalized = message.toLowerCase();
    return (normalized.includes("invalidborrowfillproof")
        || normalized.includes("fillevidencelockexpired")
        || normalized.includes("fillevidencelocknotactive")
        || normalized.includes("fillevidencelockmismatch")
        || normalized.includes("lockexpired")
        || normalized.includes("locknotactive")
        || normalized.includes("pendingalreadyswept"));
}
function isTerminalLockUnwindError(message) {
    const normalized = message.toLowerCase();
    return normalized.includes("invalidintenttype") || normalized.includes("invalidlockexpiryhint");
}
function shouldDropLockUnwindTask(status) {
    return (status === "filled"
        || status === "awaiting_settlement"
        || status === "settled"
        || status === "failed"
        || status === "expired_unwound");
}
function computeRetryDelayMs(attempts) {
    const exp = Math.max(0, attempts - 1);
    const delay = finalizationRetryBaseDelayMs * (2 ** Math.min(exp, 10));
    return Math.min(finalizationRetryMaxDelayMs, delay);
}
function computeLockExpiryHint(fillDeadline) {
    if (!Number.isInteger(fillDeadline) || fillDeadline <= 0) {
        throw new Error("Across quote fillDeadline is invalid");
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const hint = BigInt(fillDeadline + lockUnwindGraceSeconds);
    if (hint <= BigInt(nowSec)) {
        throw new Error(`computed lock expiry hint is in the past (hint=${hint.toString()} now=${nowSec})`);
    }
    return hint;
}
function bigintTimestampToMs(value) {
    const ms = Number(value) * 1000;
    if (!Number.isFinite(ms) || ms <= 0)
        return Date.now();
    return ms;
}
function isUnknownBlockReadError(error) {
    const message = String(error?.message ?? "").toLowerCase();
    return message.includes("unknown block");
}
async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}
function defaultAcrossQuote(amount) {
    const now = Math.floor(Date.now() / 1000);
    return {
        outputAmount: amount,
        quoteTimestamp: now,
        fillDeadline: now + 2 * 60 * 60
    };
}
function saveRelayerRuntimeState() {
    saveRelayerState(statePath, relayerState);
}
async function postInternal(baseUrl, routePath, body) {
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
    }
    finally {
        clearTimeout(timeout);
    }
}
function signInternalRequest(method, routePath, rawBody) {
    const timestamp = Date.now().toString();
    const signature = computeInternalSignature(internalAuthSecret, method, routePath, timestamp, internalServiceName, rawBody);
    return { timestamp, signature };
}
function computeInternalSignature(secret, method, routePath, timestamp, callerService, rawBody) {
    const bodyHash = createHash("sha256").update(rawBody).digest("hex");
    const payload = `${method.toUpperCase()}\n${routePath}\n${timestamp}\n${callerService}\n${bodyHash}`;
    return createHmac("sha256", secret).update(payload).digest("hex");
}
function rateLimitMiddleware(req, res, next) {
    const now = Date.now();
    const bucketKey = `public:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`;
    const existing = rateBuckets.get(bucketKey);
    if (!existing || existing.resetAt <= now) {
        rateBuckets.set(bucketKey, { count: 1, resetAt: now + apiRateWindowMs });
        next();
        return;
    }
    if (existing.count >= apiRateMaxRequests) {
        auditLog(req, "rate_limit_rejected", { bucketKey });
        res.status(429).json({ error: "rate_limited" });
        return;
    }
    existing.count += 1;
    next();
}
function auditLog(req, action, fields) {
    const payload = {
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
function asBigInt(value) {
    if (typeof value === "bigint")
        return value;
    if (typeof value === "number" && Number.isInteger(value))
        return BigInt(value);
    if (typeof value === "string" && value.length > 0) {
        try {
            return BigInt(value);
        }
        catch {
            return undefined;
        }
    }
    return undefined;
}
function asNumber(value) {
    if (typeof value === "number" && Number.isInteger(value))
        return value;
    const asInt = asBigInt(value);
    if (asInt === undefined)
        return undefined;
    const num = Number(asInt);
    if (!Number.isInteger(num))
        return undefined;
    return num;
}
function scaleAmountUnits(amount, fromDecimals, toDecimals) {
    if (fromDecimals === toDecimals)
        return amount;
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
function metadataString(metadata, key) {
    const value = metadata?.[key];
    if (typeof value === "string")
        return value;
    if (typeof value === "number" || typeof value === "bigint")
        return value.toString();
    return undefined;
}
function asHexString(value) {
    if (!value || typeof value !== "string")
        return undefined;
    if (!value.startsWith("0x"))
        return undefined;
    return value;
}
function asAddress(value) {
    if (!value || typeof value !== "string")
        return undefined;
    if (!value.startsWith("0x") || value.length !== 42)
        return undefined;
    return value;
}
function bytes32ToAddress(value) {
    if (typeof value !== "string")
        return undefined;
    if (!value.startsWith("0x") || value.length !== 66)
        return undefined;
    return `0x${value.slice(-40)}`;
}
function metadataBigInt(metadata, key) {
    const value = metadataString(metadata, key);
    if (!value)
        return undefined;
    try {
        return BigInt(value);
    }
    catch {
        return undefined;
    }
}
function toOutboundIntentKind(intentType) {
    if (intentType === IntentType.BORROW)
        return "borrow";
    if (intentType === IntentType.WITHDRAW)
        return "withdraw";
    return undefined;
}
function toDepositWitnessWire(witness) {
    return {
        sourceChainId: witness.sourceChainId.toString(),
        depositId: witness.depositId.toString(),
        intentType: witness.intentType,
        user: witness.user,
        spokeToken: witness.spokeToken,
        hubAsset: witness.hubAsset,
        amount: witness.amount.toString(),
        sourceTxHash: witness.sourceTxHash,
        sourceLogIndex: witness.sourceLogIndex.toString(),
        messageHash: witness.messageHash
    };
}
function fromDepositWitnessWire(witness) {
    return {
        sourceChainId: BigInt(witness.sourceChainId),
        depositId: BigInt(witness.depositId),
        intentType: witness.intentType,
        user: witness.user,
        spokeToken: witness.spokeToken,
        hubAsset: witness.hubAsset,
        amount: BigInt(witness.amount),
        sourceTxHash: witness.sourceTxHash,
        sourceLogIndex: BigInt(witness.sourceLogIndex),
        messageHash: witness.messageHash
    };
}
function toSourceDepositEvidenceWire(sourceEvidence) {
    return {
        sourceBlockNumber: sourceEvidence.sourceBlockNumber.toString(),
        sourceBlockHash: sourceEvidence.sourceBlockHash,
        sourceReceiptsRoot: sourceEvidence.sourceReceiptsRoot,
        sourceSpokePool: sourceEvidence.sourceSpokePool
    };
}
function fromSourceDepositEvidenceWire(sourceEvidence) {
    return {
        sourceBlockNumber: BigInt(sourceEvidence.sourceBlockNumber),
        sourceBlockHash: sourceEvidence.sourceBlockHash,
        sourceReceiptsRoot: sourceEvidence.sourceReceiptsRoot,
        sourceSpokePool: sourceEvidence.sourceSpokePool
    };
}
function toBorrowFillWitnessWire(witness) {
    return {
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
        messageHash: witness.messageHash
    };
}
function fromBorrowFillWitnessWire(witness) {
    return {
        sourceChainId: BigInt(witness.sourceChainId),
        intentId: witness.intentId,
        intentType: witness.intentType,
        user: witness.user,
        recipient: witness.recipient,
        spokeToken: witness.spokeToken,
        hubAsset: witness.hubAsset,
        amount: BigInt(witness.amount),
        fee: BigInt(witness.fee),
        relayer: witness.relayer,
        sourceTxHash: witness.sourceTxHash,
        sourceLogIndex: BigInt(witness.sourceLogIndex),
        messageHash: witness.messageHash
    };
}
function toSourceBorrowFillEvidenceWire(sourceEvidence) {
    return {
        sourceBlockNumber: sourceEvidence.sourceBlockNumber.toString(),
        sourceBlockHash: sourceEvidence.sourceBlockHash,
        sourceReceiptsRoot: sourceEvidence.sourceReceiptsRoot,
        sourceReceiver: sourceEvidence.sourceReceiver
    };
}
function fromSourceBorrowFillEvidenceWire(sourceEvidence) {
    return {
        sourceBlockNumber: BigInt(sourceEvidence.sourceBlockNumber),
        sourceBlockHash: sourceEvidence.sourceBlockHash,
        sourceReceiptsRoot: sourceEvidence.sourceReceiptsRoot,
        sourceReceiver: sourceEvidence.sourceReceiver
    };
}
function decodeAcrossDepositMessage(message) {
    try {
        const decoded = decodeAbiParameters([
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
        ], message);
        return decoded[0];
    }
    catch {
        return undefined;
    }
}
function normalizeNetwork(value) {
    const normalized = value.trim().toLowerCase();
    if (normalized === "mainnet")
        return "ethereum";
    if (normalized === "world")
        return "worldchain";
    if (normalized === "bnb")
        return "bsc";
    if (normalized in NETWORKS)
        return normalized;
    throw new Error(`Unsupported network=${value}. Use one of: ${Object.keys(NETWORKS).join(", ")}`);
}
function resolveSpokeNetwork(value) {
    const first = value
        .split(",")
        .map((entry) => entry.trim())
        .find((entry) => entry.length > 0);
    return normalizeNetwork(first ?? "base");
}
function resolveNetworkRpc(network, fallback) {
    const config = NETWORKS[network];
    const tenderly = process.env[`${config.envPrefix}_TENDERLY_RPC_URL`];
    const rpc = process.env[`${config.envPrefix}_RPC_URL`];
    if (isLiveMode && tenderly) {
        throw new Error(`LIVE_MODE forbids ${config.envPrefix}_TENDERLY_RPC_URL`);
    }
    return rpc ?? tenderly ?? fallback;
}
function resolveSpokeAddress(spokeEnvPrefix, suffix) {
    return (process.env[`SPOKE_${spokeEnvPrefix}_${suffix}`]
        ?? process.env[`SPOKE_${suffix}`]
        ?? "");
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
    if (!Number.isInteger(finalizationWorkerIntervalMs) || finalizationWorkerIntervalMs <= 0) {
        throw new Error("RELAYER_FINALIZATION_WORKER_INTERVAL_MS must be a positive integer");
    }
    if (!Number.isFinite(finalizationRetryBaseDelayMs) || finalizationRetryBaseDelayMs <= 0) {
        throw new Error("RELAYER_FINALIZATION_RETRY_BASE_MS must be a positive integer");
    }
    if (!Number.isFinite(finalizationRetryMaxDelayMs) || finalizationRetryMaxDelayMs <= 0) {
        throw new Error("RELAYER_FINALIZATION_RETRY_MAX_MS must be a positive integer");
    }
    if (!Number.isInteger(finalizationMaxAttempts) || finalizationMaxAttempts <= 0) {
        throw new Error("RELAYER_FINALIZATION_MAX_ATTEMPTS must be a positive integer");
    }
    if (!Number.isInteger(lockUnwindGraceSeconds) || lockUnwindGraceSeconds <= 0) {
        throw new Error("RELAYER_LOCK_UNWIND_GRACE_SECONDS must be a positive integer");
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
        throw new Error(`Missing SPOKE_${spokeConfig.envPrefix}_ACROSS_SPOKE_POOL_ADDRESS or SPOKE_ACROSS_SPOKE_POOL_ADDRESS`);
    }
    if (!spokeBorrowReceiverAddress) {
        throw new Error(`Missing SPOKE_${spokeConfig.envPrefix}_BORROW_RECEIVER_ADDRESS or SPOKE_BORROW_RECEIVER_ADDRESS`);
    }
}
//# sourceMappingURL=server.js.map