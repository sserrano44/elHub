import path from "node:path";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import express from "express";
import { z } from "zod";
import { JsonIndexerStore, SqliteIndexerStore } from "./store";
const runtimeEnv = (process.env.ZKHUB_ENV ?? process.env.NODE_ENV ?? "development").toLowerCase();
const isProduction = runtimeEnv === "production";
const corsAllowOrigin = process.env.CORS_ALLOW_ORIGIN ?? "*";
const internalAuthSecret = process.env.INTERNAL_API_AUTH_SECRET
    ?? (isProduction ? "" : "dev-internal-auth-secret");
const internalAuthPreviousSecret = process.env.INTERNAL_API_AUTH_PREVIOUS_SECRET?.trim() ?? "";
const internalCallerHeader = "x-elhub-internal-service";
const internalRequirePrivateIp = (process.env.INTERNAL_API_REQUIRE_PRIVATE_IP ?? (isProduction ? "1" : "0")) !== "0";
const internalAllowedIps = parseCsvSet(process.env.INTERNAL_API_ALLOWED_IPS ?? "");
const internalAllowedServices = parseCsvSet(process.env.INTERNAL_API_ALLOWED_SERVICES ?? "relayer,prover,e2e");
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
app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", corsAllowOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type,x-request-id,x-elhub-internal-ts,x-elhub-internal-sig,x-elhub-internal-service");
    if (_req.method === "OPTIONS") {
        res.status(204).end();
        return;
    }
    next();
});
const port = Number(process.env.INDEXER_PORT ?? 3030);
const dbKind = (process.env.INDEXER_DB_KIND ?? "json").toLowerCase();
const dbPath = process.env.INDEXER_DB_PATH
    ?? path.join(process.cwd(), "data", dbKind === "sqlite" ? "indexer.db" : "indexer.json");
const store = dbKind === "sqlite"
    ? new SqliteIndexerStore(dbPath)
    : new JsonIndexerStore(dbPath);
const internalAuthMaxSkewMs = Number(process.env.INTERNAL_API_AUTH_MAX_SKEW_MS ?? "60000");
const apiRateWindowMs = Number(process.env.API_RATE_WINDOW_MS ?? "60000");
const apiRateMaxRequests = Number(process.env.API_RATE_MAX_REQUESTS ?? "1200");
const internalRateWindowMs = Number(process.env.INTERNAL_API_RATE_WINDOW_MS ?? "60000");
const internalRateMaxRequests = Number(process.env.INTERNAL_API_RATE_MAX_REQUESTS ?? "2400");
const seenSignatures = new Map();
const rateBuckets = new Map();
if (!isProduction && internalAuthSecret === "dev-internal-auth-secret") {
    console.warn("Indexer is using default INTERNAL_API_AUTH_SECRET. Override it before production.");
}
if (internalAuthPreviousSecret.length > 0) {
    console.log("Indexer internal auth previous secret enabled for key rotation.");
}
const intentSchema = z.object({
    intentId: z.string().startsWith("0x"),
    status: z.enum(["initiated", "pending_lock", "locked", "filled", "awaiting_settlement", "settled", "failed"]),
    user: z.string().startsWith("0x"),
    intentType: z.number().int(),
    amount: z.string(),
    token: z.string(),
    txHash: z.string().startsWith("0x").optional(),
    metadata: z.record(z.unknown()).optional()
});
const statusPatchSchema = z.object({
    status: z.enum(["initiated", "pending_lock", "locked", "filled", "awaiting_settlement", "settled", "failed"]),
    txHash: z.string().startsWith("0x").optional(),
    metadata: z.record(z.unknown()).optional()
});
const depositSchema = z.object({
    depositId: z.number().int().nonnegative(),
    user: z.string().startsWith("0x"),
    intentType: z.number().int(),
    token: z.string().startsWith("0x"),
    amount: z.string(),
    status: z.enum(["initiated", "pending_fill", "bridged", "settled"]),
    metadata: z.record(z.unknown()).optional()
});
app.use(rateLimitMiddleware);
app.use("/internal", requireInternalNetwork, requireInternalAuth);
app.get("/health", (_req, res) => {
    res.json({ ok: true });
});
app.get("/activity", (req, res) => {
    const user = typeof req.query.user === "string" ? req.query.user : undefined;
    const intents = store.listIntents(user);
    res.json(intents);
});
app.get("/intents/:intentId", (req, res) => {
    const intent = store.getIntent(req.params.intentId);
    if (!intent) {
        res.status(404).json({ error: "not_found" });
        return;
    }
    res.json(intent);
});
app.post("/internal/intents/upsert", (req, res) => {
    const parsed = intentSchema.safeParse(req.body);
    if (!parsed.success) {
        auditLog(req, "intent_upsert_rejected", { reason: "invalid_payload" });
        res.status(400).json({ error: parsed.error.flatten() });
        return;
    }
    const payload = parsed.data;
    const entity = {
        intentId: payload.intentId,
        status: payload.status,
        user: payload.user,
        intentType: payload.intentType,
        amount: payload.amount,
        token: payload.token,
        txHash: payload.txHash,
        metadata: payload.metadata,
        updatedAt: new Date().toISOString()
    };
    auditLog(req, "intent_upsert", { intentId: entity.intentId, status: entity.status });
    res.json(store.upsertIntent(entity));
});
app.post("/internal/intents/:intentId/status", (req, res) => {
    const parsed = statusPatchSchema.safeParse(req.body);
    if (!parsed.success) {
        auditLog(req, "intent_status_rejected", {
            intentId: req.params.intentId,
            reason: "invalid_payload"
        });
        res.status(400).json({ error: parsed.error.flatten() });
        return;
    }
    const updated = store.updateIntentStatus(req.params.intentId, parsed.data.status, {
        txHash: parsed.data.txHash,
        metadata: parsed.data.metadata
    });
    if (!updated) {
        auditLog(req, "intent_status_rejected", { intentId: req.params.intentId, reason: "not_found" });
        res.status(404).json({ error: "not_found" });
        return;
    }
    auditLog(req, "intent_status_updated", {
        intentId: req.params.intentId,
        status: parsed.data.status
    });
    res.json(updated);
});
app.post("/internal/deposits/upsert", (req, res) => {
    const parsed = depositSchema.safeParse(req.body);
    if (!parsed.success) {
        auditLog(req, "deposit_upsert_rejected", { reason: "invalid_payload" });
        res.status(400).json({ error: parsed.error.flatten() });
        return;
    }
    auditLog(req, "deposit_upsert", {
        depositId: parsed.data.depositId,
        status: parsed.data.status
    });
    res.json(store.upsertDeposit({
        depositId: parsed.data.depositId,
        user: parsed.data.user,
        intentType: parsed.data.intentType,
        token: parsed.data.token,
        amount: parsed.data.amount,
        status: parsed.data.status,
        metadata: parsed.data.metadata
    }));
});
app.get("/deposits/:depositId", (req, res) => {
    const dep = store.getDeposit(Number(req.params.depositId));
    if (!dep) {
        res.status(404).json({ error: "not_found" });
        return;
    }
    res.json(dep);
});
app.listen(port, () => {
    console.log(`Indexer API listening on :${port}`);
    console.log(`Indexer persistence: kind=${dbKind} path=${dbPath}`);
});
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
        if (lhs.length === 0 || rhs.length === 0 || lhs.length !== rhs.length) {
            return false;
        }
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
        service: "indexer",
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