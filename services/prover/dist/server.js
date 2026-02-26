import path from "node:path";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import express from "express";
import { z } from "zod";
import { createPublicClient, createWalletClient, defineChain, formatEther, parseEther, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HubSettlementAbi } from "@elhub/abis";
import { buildBatch } from "./batch";
import { buildCanonicalBorrowFillProof, buildCanonicalDepositProof } from "./deposit-proof";
import { CircuitProofProvider, DevProofProvider } from "./proof";
import { JsonProverQueueStore, SqliteProverQueueStore } from "./queue-store";
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
const internalAuthPreviousSecret = process.env.INTERNAL_API_AUTH_PREVIOUS_SECRET?.trim() ?? "";
const internalCallerHeader = "x-elhub-internal-service";
const internalServiceName = process.env.INTERNAL_API_SERVICE_NAME?.trim() || "prover";
const internalRequirePrivateIp = (process.env.INTERNAL_API_REQUIRE_PRIVATE_IP ?? (isProduction ? "1" : "0")) !== "0";
const internalAllowedIps = parseCsvSet(process.env.INTERNAL_API_ALLOWED_IPS ?? "");
const internalAllowedServices = parseCsvSet(process.env.INTERNAL_API_ALLOWED_SERVICES ?? "relayer,e2e");
const internalTrustProxy = (process.env.INTERNAL_API_TRUST_PROXY ?? "0") !== "0";
const internalAuthVerificationSecrets = Array.from(new Set([internalAuthSecret, internalAuthPreviousSecret].filter((secret) => secret.length > 0)));
validateStartupConfig();
const app = express();
app.set("trust proxy", internalTrustProxy);
app.use(express.json({
    limit: "1mb",
    verify: (req, _res, buf) => {
        req.rawBody = buf.toString("utf8");
    }
}));
app.use((req, res, next) => {
    const requestId = req.header("x-request-id")?.trim() || randomUUID();
    req.requestId = requestId;
    res.setHeader("x-request-id", requestId);
    next();
});
app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", corsAllowOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type,x-request-id,x-elhub-internal-ts,x-elhub-internal-sig,x-elhub-internal-service");
    if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
    }
    next();
});
const port = Number(process.env.PROVER_PORT ?? 3050);
const proverStoreKind = (process.env.PROVER_STORE_KIND ?? "json").toLowerCase();
const queuePath = process.env.PROVER_QUEUE_PATH ?? path.join(process.cwd(), "data", "prover-queue.json");
const statePath = process.env.PROVER_STATE_PATH ?? path.join(process.cwd(), "data", "prover-state.json");
const dbPath = process.env.PROVER_DB_PATH ?? path.join(process.cwd(), "data", "prover.db");
const initialBatchId = BigInt(process.env.PROVER_BATCH_START ?? "1");
const mode = process.env.PROVER_MODE ?? "dev";
const batchSize = Number(process.env.PROVER_BATCH_SIZE ?? 20);
const internalAuthMaxSkewMs = Number(process.env.INTERNAL_API_AUTH_MAX_SKEW_MS ?? "60000");
const apiRateWindowMs = Number(process.env.API_RATE_WINDOW_MS ?? "60000");
const apiRateMaxRequests = Number(process.env.API_RATE_MAX_REQUESTS ?? "1200");
const internalRateWindowMs = Number(process.env.INTERNAL_API_RATE_WINDOW_MS ?? "60000");
const internalRateMaxRequests = Number(process.env.INTERNAL_API_RATE_MAX_REQUESTS ?? "2400");
const hubNetwork = normalizeNetwork(process.env.HUB_NETWORK ?? "ethereum");
const spokeNetwork = resolveSpokeNetwork(process.env.SPOKE_NETWORKS ?? process.env.SPOKE_NETWORK ?? "base");
const hubConfig = NETWORKS[hubNetwork];
const spokeConfig = NETWORKS[spokeNetwork];
const hubRpc = process.env.HUB_RPC_URL ?? resolveNetworkRpc(hubNetwork, "http://127.0.0.1:8545");
const hubChainId = BigInt(process.env.HUB_CHAIN_ID
    ?? process.env[`${hubConfig.envPrefix}_CHAIN_ID`]
    ?? String(hubConfig.defaultChainId));
const spokeChainId = BigInt(process.env.SPOKE_CHAIN_ID
    ?? process.env[`${spokeConfig.envPrefix}_CHAIN_ID`]
    ?? String(spokeConfig.defaultChainId));
const settlementAddress = process.env.HUB_SETTLEMENT_ADDRESS;
const proverKey = process.env.PROVER_PRIVATE_KEY;
const proverFunderKey = process.env.PROVER_FUNDER_PRIVATE_KEY;
const proverMinNativeEth = process.env.PROVER_MIN_NATIVE_ETH ?? "0";
const proverMinNativeWei = parseNativeWei(proverMinNativeEth);
const indexerUrl = process.env.INDEXER_API_URL ?? "http://127.0.0.1:3030";
if (!settlementAddress || !proverKey) {
    throw new Error("Missing HUB_SETTLEMENT_ADDRESS or PROVER_PRIVATE_KEY");
}
const account = privateKeyToAccount(proverKey);
const hubChain = defineChain({
    id: Number(hubChainId),
    name: "Hub",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [hubRpc] } }
});
const walletClient = createWalletClient({ account, chain: hubChain, transport: http(hubRpc) });
const publicClient = createPublicClient({ chain: hubChain, transport: http(hubRpc) });
const funderAccount = proverFunderKey ? privateKeyToAccount(proverFunderKey) : null;
const funderWallet = funderAccount
    ? createWalletClient({ account: funderAccount, chain: hubChain, transport: http(hubRpc) })
    : null;
const proofProvider = mode === "dev" ? new DevProofProvider() : new CircuitProofProvider();
const seenSignatures = new Map();
const rateBuckets = new Map();
let isFlushing = false;
if (!isProduction && internalAuthSecret === "dev-internal-auth-secret") {
    console.warn("Prover is using default INTERNAL_API_AUTH_SECRET. Override it before production.");
}
if (internalAuthPreviousSecret.length > 0) {
    console.log("Prover internal auth previous secret enabled for key rotation.");
}
const actionSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("supply"),
        sourceChainId: z.string(),
        depositId: z.string(),
        user: z.string().startsWith("0x"),
        hubAsset: z.string().startsWith("0x"),
        amount: z.string()
    }),
    z.object({
        kind: z.literal("repay"),
        sourceChainId: z.string(),
        depositId: z.string(),
        user: z.string().startsWith("0x"),
        hubAsset: z.string().startsWith("0x"),
        amount: z.string()
    }),
    z.object({
        kind: z.literal("borrow"),
        intentId: z.string().startsWith("0x"),
        user: z.string().startsWith("0x"),
        hubAsset: z.string().startsWith("0x"),
        amount: z.string(),
        fee: z.string(),
        relayer: z.string().startsWith("0x")
    }),
    z.object({
        kind: z.literal("withdraw"),
        intentId: z.string().startsWith("0x"),
        user: z.string().startsWith("0x"),
        hubAsset: z.string().startsWith("0x"),
        amount: z.string(),
        fee: z.string(),
        relayer: z.string().startsWith("0x")
    })
]);
const depositWitnessSchema = z.object({
    sourceChainId: z.string(),
    depositId: z.string(),
    intentType: z.number().int().min(1).max(2),
    user: z.string().startsWith("0x"),
    spokeToken: z.string().startsWith("0x"),
    hubAsset: z.string().startsWith("0x"),
    amount: z.string(),
    sourceTxHash: z.string().startsWith("0x"),
    sourceLogIndex: z.string(),
    messageHash: z.string().startsWith("0x"),
    sourceBlockNumber: z.string(),
    sourceBlockHash: z.string().startsWith("0x"),
    sourceReceiptsRoot: z.string().startsWith("0x"),
    sourceSpokePool: z.string().startsWith("0x"),
    destinationReceiver: z.string().startsWith("0x"),
    destinationChainId: z.string()
});
const borrowFillWitnessSchema = z.object({
    sourceChainId: z.string(),
    intentId: z.string().startsWith("0x"),
    intentType: z.number().int().min(3).max(4),
    user: z.string().startsWith("0x"),
    recipient: z.string().startsWith("0x"),
    spokeToken: z.string().startsWith("0x"),
    hubAsset: z.string().startsWith("0x"),
    amount: z.string(),
    fee: z.string(),
    relayer: z.string().startsWith("0x"),
    sourceTxHash: z.string().startsWith("0x"),
    sourceLogIndex: z.string(),
    messageHash: z.string().startsWith("0x"),
    sourceBlockNumber: z.string(),
    sourceBlockHash: z.string().startsWith("0x"),
    sourceReceiptsRoot: z.string().startsWith("0x"),
    sourceReceiver: z.string().startsWith("0x"),
    destinationFinalizer: z.string().startsWith("0x"),
    destinationChainId: z.string()
});
const queueStore = proverStoreKind === "sqlite"
    ? new SqliteProverQueueStore(dbPath, initialBatchId)
    : new JsonProverQueueStore(queuePath, statePath, initialBatchId);
let nextBatchId = queueStore.getNextBatchId(initialBatchId);
app.use("/internal", requireInternalNetwork, requireInternalAuth);
app.use(rateLimitMiddleware);
app.get("/health", (_req, res) => {
    res.json({
        ok: true,
        mode,
        store: proverStoreKind,
        queued: queueStore.getQueuedCount(),
        nextBatchId: nextBatchId.toString(),
        isFlushing
    });
});
app.post("/internal/enqueue", (req, res) => {
    const parsed = actionSchema.safeParse(req.body);
    if (!parsed.success) {
        auditLog(req, "enqueue_rejected", { reason: "invalid_payload" });
        res.status(400).json({ error: parsed.error.flatten() });
        return;
    }
    const action = normalizeAction(parsed.data);
    const enqueueResult = queueStore.enqueue(action);
    if (enqueueResult === "duplicate") {
        auditLog(req, "enqueue_duplicate");
        res.json({ ok: true, queued: queueStore.getQueuedCount(), duplicate: true });
        return;
    }
    auditLog(req, "enqueue_ok", { queued: queueStore.getQueuedCount() });
    res.json({ ok: true, queued: queueStore.getQueuedCount() });
});
app.post("/internal/deposit-proof", async (req, res) => {
    const parsed = depositWitnessSchema.safeParse(req.body);
    if (!parsed.success) {
        auditLog(req, "deposit_proof_rejected", { reason: "invalid_payload" });
        res.status(400).json({ error: parsed.error.flatten() });
        return;
    }
    try {
        const witness = normalizeDepositWitness(parsed.data);
        const sourceProof = normalizeSourceDepositProof(parsed.data);
        const proof = buildCanonicalDepositProof(witness, sourceProof);
        auditLog(req, "deposit_proof_ok");
        res.json({
            ok: true,
            proof
        });
    }
    catch (error) {
        auditLog(req, "deposit_proof_error", { message: error.message });
        res.status(500).json({ ok: false, error: error.message });
    }
});
app.post("/internal/borrow-fill-proof", async (req, res) => {
    const parsed = borrowFillWitnessSchema.safeParse(req.body);
    if (!parsed.success) {
        auditLog(req, "borrow_fill_proof_rejected", { reason: "invalid_payload" });
        res.status(400).json({ error: parsed.error.flatten() });
        return;
    }
    try {
        const witness = normalizeBorrowFillWitness(parsed.data);
        const sourceProof = normalizeSourceBorrowFillProof(parsed.data);
        const proof = buildCanonicalBorrowFillProof(witness, sourceProof);
        auditLog(req, "borrow_fill_proof_ok");
        res.json({
            ok: true,
            proof
        });
    }
    catch (error) {
        auditLog(req, "borrow_fill_proof_error", { message: error.message });
        res.status(500).json({ ok: false, error: error.message });
    }
});
app.post("/internal/flush", async (_req, res) => {
    try {
        const settled = await flushQueue();
        auditLog(_req, "flush_ok", { settled, queued: queueStore.getQueuedCount() });
        res.json({ ok: true, settled });
    }
    catch (error) {
        auditLog(_req, "flush_error", { message: error.message });
        res.status(500).json({ ok: false, error: error.message });
    }
});
app.listen(port, () => {
    console.log(`Prover service listening on :${port} (mode=${mode})`);
    console.log(`Prover persistence store: kind=${proverStoreKind}`);
    startupPreflight().catch((error) => {
        console.error("Prover startup preflight failed", error);
        process.exit(1);
    });
    setInterval(() => {
        flushQueue().catch((error) => {
            console.error("Prover flush error", error);
        });
    }, 5_000);
});
async function flushQueue() {
    if (isFlushing)
        return 0;
    if (queueStore.getQueuedCount() === 0)
        return 0;
    isFlushing = true;
    try {
        const records = queueStore.peek(batchSize);
        if (records.length === 0)
            return 0;
        const actions = records.map((record) => record.action);
        const batch = buildBatch(nextBatchId, hubChainId, spokeChainId, actions);
        const { proof } = await proofProvider.prove(batch);
        await ensureProverHasGas("flush");
        const txHash = await walletClient.writeContract({
            abi: HubSettlementAbi,
            address: settlementAddress,
            functionName: "settleBatch",
            args: [batch, proof],
            account
        });
        await publicClient.waitForTransactionReceipt({ hash: txHash });
        // Persist queue + batch cursor immediately after on-chain success.
        nextBatchId += 1n;
        queueStore.markSettled(records, nextBatchId);
        for (const action of actions) {
            if (action.kind === "supply" || action.kind === "repay") {
                await postInternal(indexerUrl, "/internal/deposits/upsert", {
                    sourceChainId: Number(action.sourceChainId),
                    depositId: Number(action.depositId),
                    user: action.user,
                    intentType: action.kind === "supply" ? 1 : 2,
                    token: action.hubAsset,
                    amount: action.amount.toString(),
                    status: "settled",
                    metadata: {
                        batchId: batch.batchId.toString(),
                        txHash
                    }
                }).catch((error) => {
                    console.error(`Failed to update settled deposit ${action.depositId.toString()}`, error);
                });
            }
            if (action.kind === "borrow" || action.kind === "withdraw") {
                await postInternal(indexerUrl, `/internal/intents/${action.intentId}/status`, {
                    status: "settled",
                    txHash,
                    metadata: { batchId: batch.batchId.toString() }
                }).catch((error) => {
                    console.error(`Failed to update settled intent ${action.intentId}`, error);
                });
            }
        }
        console.log(`Settled batch ${batch.batchId.toString()} with ${actions.length} actions (tx=${txHash})`);
        return actions.length;
    }
    finally {
        isFlushing = false;
    }
}
async function startupPreflight() {
    const [chainId, balance] = await Promise.all([
        publicClient.getChainId(),
        publicClient.getBalance({ address: account.address })
    ]);
    console.log(JSON.stringify({
        ts: new Date().toISOString(),
        service: "prover",
        action: "startup_context",
        hubRpc,
        hubChainId: String(chainId),
        signer: account.address,
        signerBalanceEth: formatEther(balance),
        minNativeEth: proverMinNativeEth,
        funder: funderAccount?.address ?? null
    }));
    await ensureProverHasGas("startup");
}
async function ensureProverHasGas(reason) {
    if (proverMinNativeWei <= 0n)
        return;
    const current = await publicClient.getBalance({ address: account.address });
    if (current >= proverMinNativeWei)
        return;
    if (!funderWallet || !funderAccount) {
        throw new Error(`prover signer ${account.address} balance too low (${formatEther(current)} ETH < ${proverMinNativeEth} ETH) ` +
            `and PROVER_FUNDER_PRIVATE_KEY is not set.`);
    }
    if (funderAccount.address.toLowerCase() === account.address.toLowerCase()) {
        throw new Error(`prover signer ${account.address} balance too low (${formatEther(current)} ETH < ${proverMinNativeEth} ETH) ` +
            "and PROVER_FUNDER_PRIVATE_KEY points to the same address.");
    }
    const needed = proverMinNativeWei - current;
    const funderBalance = await publicClient.getBalance({ address: funderAccount.address });
    if (funderBalance <= needed) {
        throw new Error(`funder ${funderAccount.address} lacks balance to top up prover. ` +
            `needed=${formatEther(needed)} funder=${formatEther(funderBalance)}`);
    }
    const txHash = await funderWallet.sendTransaction({
        to: account.address,
        value: needed,
        account: funderAccount
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    const updated = await publicClient.getBalance({ address: account.address });
    if (updated < proverMinNativeWei) {
        throw new Error(`prover top-up did not reach required minimum. balance=${formatEther(updated)} required=${proverMinNativeEth}`);
    }
    console.log(JSON.stringify({
        ts: new Date().toISOString(),
        service: "prover",
        action: "prover_gas_topped_up",
        reason,
        signer: account.address,
        funder: funderAccount.address,
        txHash,
        balanceEth: formatEther(updated)
    }));
}
function normalizeAction(input) {
    if (input.kind === "supply" || input.kind === "repay") {
        const sourceChainId = BigInt(input.sourceChainId);
        if (sourceChainId !== spokeChainId) {
            throw new Error(`queued action sourceChainId mismatch: expected=${spokeChainId.toString()} got=${sourceChainId.toString()}`);
        }
        return {
            kind: input.kind,
            sourceChainId,
            depositId: BigInt(input.depositId),
            user: input.user,
            hubAsset: input.hubAsset,
            amount: BigInt(input.amount)
        };
    }
    return {
        kind: input.kind,
        intentId: input.intentId,
        user: input.user,
        hubAsset: input.hubAsset,
        amount: BigInt(input.amount),
        fee: BigInt(input.fee),
        relayer: input.relayer
    };
}
function normalizeDepositWitness(input) {
    return {
        sourceChainId: BigInt(input.sourceChainId),
        depositId: BigInt(input.depositId),
        intentType: input.intentType,
        user: input.user,
        spokeToken: input.spokeToken,
        hubAsset: input.hubAsset,
        amount: BigInt(input.amount),
        sourceTxHash: input.sourceTxHash,
        sourceLogIndex: BigInt(input.sourceLogIndex),
        messageHash: input.messageHash
    };
}
function normalizeSourceDepositProof(input) {
    return {
        sourceBlockNumber: BigInt(input.sourceBlockNumber),
        sourceBlockHash: input.sourceBlockHash,
        sourceReceiptsRoot: input.sourceReceiptsRoot,
        sourceSpokePool: input.sourceSpokePool,
        destinationReceiver: input.destinationReceiver,
        destinationChainId: BigInt(input.destinationChainId)
    };
}
function normalizeBorrowFillWitness(input) {
    return {
        sourceChainId: BigInt(input.sourceChainId),
        intentId: input.intentId,
        intentType: input.intentType,
        user: input.user,
        recipient: input.recipient,
        spokeToken: input.spokeToken,
        hubAsset: input.hubAsset,
        amount: BigInt(input.amount),
        fee: BigInt(input.fee),
        relayer: input.relayer,
        sourceTxHash: input.sourceTxHash,
        sourceLogIndex: BigInt(input.sourceLogIndex),
        messageHash: input.messageHash
    };
}
function normalizeSourceBorrowFillProof(input) {
    return {
        sourceBlockNumber: BigInt(input.sourceBlockNumber),
        sourceBlockHash: input.sourceBlockHash,
        sourceReceiptsRoot: input.sourceReceiptsRoot,
        sourceReceiver: input.sourceReceiver,
        destinationFinalizer: input.destinationFinalizer,
        destinationChainId: BigInt(input.destinationChainId)
    };
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
            throw new Error(`${res.status} ${await res.text()}`);
        }
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
function requireInternalAuth(req, res, next) {
    const request = req;
    const timestamp = req.header("x-elhub-internal-ts");
    const signature = req.header("x-elhub-internal-sig");
    const callerService = req.header(internalCallerHeader)?.trim();
    if (!timestamp || !signature || !callerService) {
        auditLog(request, "internal_auth_rejected", { reason: "missing_headers" });
        res.status(401).json({ error: "missing_internal_auth_headers" });
        return;
    }
    if (internalAllowedServices.size > 0 && !internalAllowedServices.has(callerService)) {
        auditLog(request, "internal_auth_rejected", { reason: "unauthorized_service", callerService });
        res.status(403).json({ error: "unauthorized_internal_service" });
        return;
    }
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) {
        auditLog(request, "internal_auth_rejected", { reason: "bad_timestamp" });
        res.status(401).json({ error: "invalid_internal_auth_timestamp" });
        return;
    }
    if (Math.abs(Date.now() - ts) > internalAuthMaxSkewMs) {
        auditLog(request, "internal_auth_rejected", { reason: "stale_timestamp" });
        res.status(401).json({ error: "stale_internal_auth_timestamp" });
        return;
    }
    const cacheKey = `${timestamp}:${callerService}:${signature}`;
    purgeExpiredSignatures();
    if (seenSignatures.has(cacheKey)) {
        auditLog(request, "internal_auth_rejected", { reason: "replay" });
        res.status(409).json({ error: "replayed_internal_request" });
        return;
    }
    const rawBody = request.rawBody ?? "";
    const routePath = req.originalUrl.split("?")[0] ?? req.path;
    const matchedSecret = internalAuthVerificationSecrets.find((secret) => {
        const expected = computeInternalSignature(secret, req.method, routePath, timestamp, callerService, rawBody);
        return constantTimeHexEqual(signature, expected);
    });
    if (!matchedSecret) {
        auditLog(request, "internal_auth_rejected", { reason: "bad_signature" });
        res.status(401).json({ error: "invalid_internal_auth_signature" });
        return;
    }
    seenSignatures.set(cacheKey, Date.now() + internalAuthMaxSkewMs);
    auditLog(request, "internal_auth_ok", {
        callerService,
        keyVersion: matchedSecret === internalAuthSecret ? "current" : "previous"
    });
    next();
}
function requireInternalNetwork(req, res, next) {
    const request = req;
    const clientIp = extractClientIp(req);
    if (!clientIp) {
        auditLog(request, "internal_network_rejected", { reason: "missing_ip" });
        res.status(403).json({ error: "internal_network_rejected" });
        return;
    }
    if (internalAllowedIps.size > 0 && !internalAllowedIps.has(clientIp)) {
        auditLog(request, "internal_network_rejected", { reason: "ip_not_allowlisted", clientIp });
        res.status(403).json({ error: "internal_network_rejected" });
        return;
    }
    if (internalAllowedIps.size === 0 && internalRequirePrivateIp && !isPrivateIp(clientIp)) {
        auditLog(request, "internal_network_rejected", { reason: "ip_not_private", clientIp });
        res.status(403).json({ error: "internal_network_rejected" });
        return;
    }
    next();
}
function purgeExpiredSignatures() {
    const now = Date.now();
    for (const [key, expiresAt] of seenSignatures.entries()) {
        if (expiresAt <= now)
            seenSignatures.delete(key);
    }
}
function computeInternalSignature(secret, method, routePath, timestamp, callerService, rawBody) {
    const bodyHash = createHash("sha256").update(rawBody).digest("hex");
    const payload = `${method.toUpperCase()}\n${routePath}\n${timestamp}\n${callerService}\n${bodyHash}`;
    return createHmac("sha256", secret).update(payload).digest("hex");
}
function constantTimeHexEqual(a, b) {
    try {
        const lhs = Buffer.from(a, "hex");
        const rhs = Buffer.from(b, "hex");
        if (lhs.length === 0 || rhs.length === 0 || lhs.length !== rhs.length)
            return false;
        return timingSafeEqual(lhs, rhs);
    }
    catch {
        return false;
    }
}
function rateLimitMiddleware(req, res, next) {
    const now = Date.now();
    const isInternal = req.path.startsWith("/internal");
    const windowMs = isInternal ? internalRateWindowMs : apiRateWindowMs;
    const maxRequests = isInternal ? internalRateMaxRequests : apiRateMaxRequests;
    const bucketKey = `${isInternal ? "internal" : "public"}:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`;
    const existing = rateBuckets.get(bucketKey);
    if (!existing || existing.resetAt <= now) {
        rateBuckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
        next();
        return;
    }
    if (existing.count >= maxRequests) {
        auditLog(req, "rate_limit_rejected", { isInternal, bucketKey });
        res.status(429).json({ error: "rate_limited" });
        return;
    }
    existing.count += 1;
    next();
}
function auditLog(req, action, fields) {
    const payload = {
        ts: new Date().toISOString(),
        service: "prover",
        action,
        requestId: req.requestId ?? "unknown",
        method: req.method,
        path: req.originalUrl.split("?")[0] ?? req.path
    };
    if (fields) {
        for (const [key, value] of Object.entries(fields)) {
            payload[key] = value;
        }
    }
    console.log(JSON.stringify(payload));
}
function parseNativeWei(value) {
    const normalized = value.trim();
    if (!normalized || normalized === "0")
        return 0n;
    return parseEther(normalized);
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
function validateStartupConfig() {
    if (!internalAuthSecret) {
        throw new Error("Missing INTERNAL_API_AUTH_SECRET");
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
        if ((process.env.PROVER_MODE ?? "dev") === "dev") {
            throw new Error("PROVER_MODE=dev is forbidden in LIVE_MODE");
        }
    }
    if (!internalServiceName) {
        throw new Error("INTERNAL_API_SERVICE_NAME cannot be empty");
    }
    if (isProduction && !internalRequirePrivateIp && internalAllowedIps.size === 0) {
        throw new Error("Set INTERNAL_API_REQUIRE_PRIVATE_IP=1 or configure INTERNAL_API_ALLOWED_IPS in production");
    }
}
function parseCsvSet(value) {
    return new Set(value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0));
}
function extractClientIp(req) {
    const source = req.ip ?? req.socket.remoteAddress ?? "";
    const normalized = normalizeIp(source);
    return normalized.length > 0 ? normalized : null;
}
function normalizeIp(value) {
    let normalized = value.trim();
    if (normalized.startsWith("::ffff:")) {
        normalized = normalized.slice("::ffff:".length);
    }
    const zoneIndex = normalized.indexOf("%");
    if (zoneIndex >= 0) {
        normalized = normalized.slice(0, zoneIndex);
    }
    return normalized;
}
function isPrivateIp(ip) {
    if (ip === "::1")
        return true;
    if (ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80:"))
        return true;
    const parts = ip.split(".");
    if (parts.length !== 4)
        return false;
    const octets = parts.map((part) => Number(part));
    if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255))
        return false;
    const a = octets[0] ?? -1;
    const b = octets[1] ?? -1;
    if (a === 10 || a === 127)
        return true;
    if (a === 192 && b === 168)
        return true;
    if (a === 172 && b >= 16 && b <= 31)
        return true;
    if (a === 169 && b === 254)
        return true;
    return false;
}
//# sourceMappingURL=server.js.map