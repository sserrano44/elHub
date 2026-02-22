import fs from "node:fs";
import path from "node:path";
import { createHash, createHmac, randomUUID } from "node:crypto";
import express from "express";
import { z } from "zod";
import { createPublicClient, createWalletClient, decodeAbiParameters, defineChain, encodeAbiParameters, http, keccak256, parseAbi, parseAbiItem } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HubLockManagerAbi, MockERC20Abi } from "@elhub/abis";
var IntentType;
(function (IntentType) {
    IntentType[IntentType["SUPPLY"] = 1] = "SUPPLY";
    IntentType[IntentType["REPAY"] = 2] = "REPAY";
    IntentType[IntentType["BORROW"] = 3] = "BORROW";
    IntentType[IntentType["WITHDRAW"] = 4] = "WITHDRAW";
})(IntentType || (IntentType = {}));
const runtimeEnv = (process.env.ZKHUB_ENV ?? process.env.NODE_ENV ?? "development").toLowerCase();
const isProduction = runtimeEnv === "production";
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
const hubRpc = process.env.HUB_RPC_URL ?? "http://127.0.0.1:8545";
const spokeRpc = process.env.SPOKE_RPC_URL ?? "http://127.0.0.1:9545";
const hubChainId = BigInt(process.env.HUB_CHAIN_ID ?? "8453");
const spokeChainId = BigInt(process.env.SPOKE_CHAIN_ID ?? "480");
const lockManagerAddress = process.env.HUB_LOCK_MANAGER_ADDRESS;
const custodyAddress = process.env.HUB_CUSTODY_ADDRESS;
const acrossReceiverAddress = process.env.HUB_ACROSS_RECEIVER_ADDRESS;
const acrossBorrowDispatcherAddress = process.env.HUB_ACROSS_BORROW_DISPATCHER_ADDRESS;
const acrossBorrowFinalizerAddress = process.env.HUB_ACROSS_BORROW_FINALIZER_ADDRESS;
const spokeAcrossSpokePoolAddress = process.env.SPOKE_ACROSS_SPOKE_POOL_ADDRESS;
const spokeBorrowReceiverAddress = process.env.SPOKE_BORROW_RECEIVER_ADDRESS;
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
    "function dispatchBorrowFill(bytes32 intentId,uint8 intentType,address user,address recipient,address outputToken,uint256 amount,uint256 outputChainId,uint256 relayerFee,uint256 maxRelayerFee,address hubAsset) returns (bytes32)"
]);
const acrossBorrowFinalizerAbi = parseAbi([
    "function finalizeBorrowFill(bytes proof,(uint256 sourceChainId,bytes32 intentId,uint8 intentType,address user,address recipient,address spokeToken,address hubAsset,uint256 amount,uint256 fee,address relayer,bytes32 sourceTxHash,uint256 sourceLogIndex,bytes32 messageHash) witness)"
]);
const spokeV3FundsDepositedEvent = parseAbiItem("event V3FundsDeposited(uint256 indexed depositId, address indexed depositor, address indexed recipient, address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, address exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes message, address caller)");
const spokeBorrowFillRecordedEvent = parseAbiItem("event BorrowFillRecorded(bytes32 indexed intentId,uint8 indexed intentType,address indexed user,address recipient,address spokeToken,address hubAsset,uint256 amount,uint256 fee,address relayer,uint256 destinationChainId,address hubFinalizer,bytes32 messageHash)");
const hubPendingDepositRecordedEvent = parseAbiItem("event PendingDepositRecorded(bytes32 indexed pendingId,uint256 indexed sourceChainId,uint256 indexed depositId,uint8 intentType,address user,address spokeToken,address hubAsset,uint256 amount,address tokenReceived,uint256 amountReceived,address relayer,bytes32 messageHash)");
const hubBridgedDepositRegisteredEvent = parseAbiItem("event BridgedDepositRegistered(uint256 indexed depositId, uint8 indexed intentType, address indexed user, address hubAsset, uint256 amount, uint256 originChainId, bytes32 originTxHash, uint256 originLogIndex, bytes32 attestationKey)");
const trackingPath = process.env.RELAYER_TRACKING_PATH ?? path.join(process.cwd(), "data", "relayer-tracking.json");
const tracking = loadTracking(trackingPath);
let isPollingCanonicalBridge = false;
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
        await hubPublic.waitForTransactionReceipt({ hash: lockTx });
        const hubAsset = spokeToHub[intent.outputToken.toLowerCase()];
        if (!hubAsset) {
            throw new Error(`No spoke->hub token mapping for ${intent.outputToken}`);
        }
        await hubWallet.writeContract({
            abi: MockERC20Abi,
            address: hubAsset,
            functionName: "approve",
            args: [acrossBorrowDispatcherAddress, intent.amount],
            account: relayerAccount
        });
        const dispatchTx = await hubWallet.writeContract({
            abi: acrossBorrowDispatcherAbi,
            address: acrossBorrowDispatcherAddress,
            functionName: "dispatchBorrowFill",
            args: [
                intentId,
                intent.intentType,
                intent.user,
                intent.recipient,
                intent.outputToken,
                intent.amount,
                intent.outputChainId,
                relayerFee,
                intent.maxRelayerFee,
                hubAsset
            ],
            account: relayerAccount
        });
        await hubPublic.waitForTransactionReceipt({ hash: dispatchTx });
        await updateIntentStatus(intentId, "locked", { lockTx, dispatchTx });
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
    if (latestBlock < tracking.lastSpokeBlock) {
        // Local anvil restarts can rewind chain height; restart scanning from genesis.
        tracking.lastSpokeBlock = 0n;
    }
    const finalizedToBlock = latestBlock > relayerSpokeFinalityBlocks
        ? latestBlock - relayerSpokeFinalityBlocks
        : 0n;
    if (finalizedToBlock === 0n)
        return;
    if (tracking.lastSpokeBlock === 0n && finalizedToBlock > relayerInitialBackfillBlocks) {
        tracking.lastSpokeBlock = finalizedToBlock - relayerInitialBackfillBlocks;
    }
    const fromBlock = tracking.lastSpokeBlock + 1n;
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
async function handleAcrossDepositLog(log, finalizedToBlock) {
    const message = log.args.message;
    const outputToken = log.args.outputToken;
    const recipient = log.args.recipient;
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
    const existing = await fetchDeposit(depositId);
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
    await attemptFinalizePendingDeposit(pendingId, witness, sourceEvidence, depositId, user, intentType, hubAsset, amount);
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
        if (existing.amount !== amount.toString()) {
            console.warn(`Skipping outbound fill ${intentId} due to amount mismatch`);
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
    const finalizeTx = await attemptFinalizeBorrowFill(witness, sourceEvidence, intentId).catch((error) => {
        console.warn(`Outbound fill finalization failed for intent ${intentId}: ${error.message}`);
        return undefined;
    });
    if (!finalizeTx)
        return;
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
        amount: amount.toString(),
        fee: fee.toString(),
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
    if (finalizedToBlock === 0n)
        return;
    if (tracking.lastHubBlock === 0n && finalizedToBlock > relayerInitialBackfillBlocks) {
        tracking.lastHubBlock = finalizedToBlock - relayerInitialBackfillBlocks;
    }
    const fromBlock = tracking.lastHubBlock + 1n;
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
    tracking.lastHubBlock = rangeToBlock;
    saveTracking(trackingPath, tracking);
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
    const existing = await fetchDeposit(depositId);
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
    await attemptFinalizePendingDeposit(pendingId, witness, sourceEvidence, depositId, user, intentType, hubAsset, amount);
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
    const existing = await fetchDeposit(depositId);
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
        depositId: depositId.toString(),
        user,
        hubAsset,
        amount: amount.toString()
    });
}
async function fetchDeposit(depositId) {
    const existing = await fetch(`${indexerApi}/deposits/${depositId.toString()}`).catch(() => null);
    if (!existing || !existing.ok)
        return undefined;
    return (await existing.json());
}
async function fetchIntent(intentId) {
    const existing = await fetch(`${indexerApi}/intents/${intentId}`).catch(() => null);
    if (!existing || !existing.ok)
        return undefined;
    return (await existing.json());
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
        destinationFinalizer: acrossBorrowFinalizerAddress,
        destinationChainId: hubChainId.toString()
    });
    const proof = asHexString(response?.proof);
    if (!proof) {
        throw new Error("prover response missing outbound fill proof");
    }
    return proof;
}
async function attemptFinalizePendingDeposit(pendingId, witness, sourceEvidence, depositId, user, intentType, hubAsset, amount) {
    let proof;
    try {
        proof = await fetchDepositProof(witness, sourceEvidence);
    }
    catch (error) {
        console.warn(`Deposit proof fetch failed for deposit ${depositId.toString()}: ${error.message}`);
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
    }
    catch (error) {
        console.warn(`Across pending finalization failed for deposit ${depositId.toString()}: ${error.message}`);
    }
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
function loadTracking(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) {
        const initial = { lastSpokeBlock: 0n, lastHubBlock: 0n };
        saveTracking(filePath, initial);
        return initial;
    }
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
        lastSpokeBlock: BigInt(raw.lastSpokeBlock ?? "0"),
        lastHubBlock: BigInt(raw.lastHubBlock ?? "0")
    };
}
function saveTracking(filePath, state) {
    fs.writeFileSync(filePath, JSON.stringify({
        lastSpokeBlock: state.lastSpokeBlock.toString(),
        lastHubBlock: state.lastHubBlock.toString()
    }, null, 2));
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
    if (relayerSpokeFinalityBlocks < 0n) {
        throw new Error("RELAYER_SPOKE_FINALITY_BLOCKS cannot be negative");
    }
    if (relayerHubFinalityBlocks < 0n) {
        throw new Error("RELAYER_HUB_FINALITY_BLOCKS cannot be negative");
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
        throw new Error("Missing SPOKE_ACROSS_SPOKE_POOL_ADDRESS");
    }
    if (!spokeBorrowReceiverAddress) {
        throw new Error("Missing SPOKE_BORROW_RECEIVER_ADDRESS");
    }
}
//# sourceMappingURL=server.js.map