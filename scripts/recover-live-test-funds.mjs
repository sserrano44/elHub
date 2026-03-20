#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  isAddress,
  parseAbi,
  parseAbiItem,
  parseEther,
  zeroAddress
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const NETWORKS = {
  base: { envPrefix: "BASE", chainId: 8453, label: "Base", nativeSymbol: "ETH" },
  worldchain: { envPrefix: "WORLDCHAIN", chainId: 480, label: "Worldchain", nativeSymbol: "ETH" },
  bsc: { envPrefix: "BSC", chainId: 56, label: "BSC", nativeSymbol: "BNB" }
};

const KEY_NAMES = [
  "DEPLOYER_PRIVATE_KEY",
  "RELAYER_PRIVATE_KEY",
  "BRIDGE_PRIVATE_KEY",
  "PROVER_PRIVATE_KEY",
  "USER1_PRIVATE_KEY",
  "USER2_PRIVATE_KEY"
];

const DEFAULT_DEPLOYMENT_JSON = path.join(rootDir, "contracts", "deployments", "live-base-hub-worldchain-bsc.json");
const DEFAULT_DEPLOYMENT_LOG = path.join(rootDir, "contracts", "deployments", "live_deployed_contracts.log");
const DEFAULT_HISTORY_SCOPE = "all";
const DEFAULT_MAX_TXS = 200;
const DEFAULT_LOG_CHUNK_SIZE = 100_000n;
const DEFAULT_RECOVERY_PENDING_FINALIZE_TTL = 86_400n;
const DEFAULT_RECOVERY_SWEEP_DELAY = 86_400n;

const LOCK_STATUS_ACTIVE = 1;
const PENDING_ACTIVE = 1;
const PENDING_EXPIRED = 2;
const PENDING_FINALIZED = 3;
const PENDING_SWEPT = 4;

const lockManagerAbi = parseAbi([
  "function locks(bytes32 intentId) view returns (bytes32 intentId,address user,uint8 intentType,address asset,uint256 amount,address relayer,uint256 lockTimestamp,uint256 expiry,uint8 status)",
  "function cancelLock(bytes32 intentId)",
  "function cancelExpiredLock(bytes32 intentId)",
  "function reservedDebt(address user,address asset) view returns (uint256)",
  "function reservedLiquidity(address asset) view returns (uint256)"
]);

const hubReceiverAbi = parseAbi([
  "function pendingDeposits(bytes32 pendingId) view returns (uint8 state,uint256 createdAt,uint256 finalizeDeadline,uint256 sweepEligibleAt,uint256 sourceChainId,uint256 depositId,uint8 intentType,address user,address spokeToken,address hubAsset,uint256 amount,address tokenReceived,uint256 amountReceived,address relayer,bytes32 messageHash)",
  "function recoveryVault() view returns (address)",
  "function pendingFinalizeTtl() view returns (uint256)",
  "function recoverySweepDelay() view returns (uint256)",
  "function setRecoveryConfig(address recoveryVault,uint256 pendingFinalizeTtl,uint256 recoverySweepDelay)",
  "function expirePendingDeposit(bytes32 pendingId)",
  "function sweepExpiredPending(bytes32 pendingId)"
]);

const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to,uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
]);

const borrowLockedEvent = parseAbiItem(
  "event BorrowLocked(bytes32 indexed intentId,address indexed user,address indexed asset,uint256 amount,address relayer)"
);
const withdrawLockedEvent = parseAbiItem(
  "event WithdrawLocked(bytes32 indexed intentId,address indexed user,address indexed asset,uint256 amount,address relayer)"
);
const pendingRecordedEvent = parseAbiItem(
  "event PendingDepositRecorded(bytes32 indexed pendingId,uint256 indexed sourceChainId,uint256 indexed depositId,uint8 intentType,address user,address spokeToken,address hubAsset,uint256 amount,address tokenReceived,uint256 amountReceived,address relayer,bytes32 messageHash)"
);

main().catch((error) => {
  console.error("[recover-live] failed:", error);
  process.exit(1);
});

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const envFile = loadDotEnv(path.join(rootDir, ".env"));
  const env = { ...envFile, ...process.env };

  const deployment = readJson(cli.deploymentJson);
  const deployLogText = fs.existsSync(cli.deploymentLog) ? fs.readFileSync(cli.deploymentLog, "utf8") : "";

  const clientsByChain = createClientsByChain(deployment, env);
  const walletSet = resolveWalletSet(env, cli.includeUserWallets);
  const sink = normalizeAddress(cli.recoveryTo || deployment?.operators?.deployer);
  if (!sink) throw new Error("Unable to resolve recovery sink address (operators.deployer or --recovery-to)");

  const targetSelection = discoverTargets({
    deployment,
    deployLogText,
    historyScope: cli.historyScope,
    customTargetsPath: cli.customTargets
  });

  const report = createReport({ cli, sink, deployment, walletSet });

  const validatedTargets = await validateTargets({
    targets: targetSelection,
    clientsByChain,
    report
  });

  printInventory({
    cli,
    sink,
    walletSet,
    targetSelection,
    validatedTargets,
    deployment
  });

  let txCounter = 0;
  let capReached = false;

  const executeTx = async ({ op, writer, recordFailureUnresolved = true }) => {
    if (!cli.execute) {
      pushOperation(report, { ...op, status: "planned" });
      return { status: "planned" };
    }
    if (capReached || txCounter >= cli.maxTxs) {
      capReached = true;
      pushOperation(report, { ...op, status: "skipped", reason: "max_txs_reached" });
      addUnresolved(report, { ...op, reason: "max_txs_reached" });
      return { status: "skipped" };
    }

    try {
      const txHash = await writer();
      txCounter += 1;
      pushOperation(report, { ...op, status: "executed", txHash });
      return { status: "executed", txHash };
    } catch (error) {
      const message = errorMessage(error);
      pushOperation(report, { ...op, status: "failed", error: message });
      if (recordFailureUnresolved) {
        addUnresolved(report, { ...op, reason: message });
      }
      return { status: "failed", error: message };
    }
  };

  await recoverLocks({
    validatedTargets,
    deployment,
    clientsByChain,
    walletSet,
    executeTx,
    report
  });

  await recoverPendingDeposits({
    validatedTargets,
    clientsByChain,
    walletSet,
    sink,
    executeTx,
    report
  });

  await recoverWalletBalances({
    deployment,
    clientsByChain,
    walletSet,
    sink,
    cli,
    executeTx,
    report
  });

  report.summary.executedTxs = txCounter;
  report.summary.capReached = capReached;
  report.meta.completedAt = new Date().toISOString();

  writeJson(cli.reportFile, report);
  console.log(`[recover-live] report: ${path.relative(rootDir, cli.reportFile)}`);
  console.log(
    `[recover-live] summary planned=${report.summary.planned} executed=${report.summary.executed} skipped=${report.summary.skipped} failed=${report.summary.failed} unresolved=${report.unresolved.length}`
  );

  if (cli.execute && report.unresolved.length > 0) {
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const options = {
    execute: false,
    deploymentJson: DEFAULT_DEPLOYMENT_JSON,
    deploymentLog: DEFAULT_DEPLOYMENT_LOG,
    historyScope: DEFAULT_HISTORY_SCOPE,
    customTargets: "",
    recoveryTo: "",
    includeUserWallets: true,
    minNativeReserveByChain: {
      8453: parseEther("0.00005"),
      480: parseEther("0.00005"),
      56: parseEther("0.00005")
    },
    maxTxs: DEFAULT_MAX_TXS,
    reportFile: defaultReportPath()
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--":
        break;
      case "--execute":
        options.execute = true;
        break;
      case "--deployment-json":
        options.deploymentJson = mustValue(argv, ++i, arg);
        break;
      case "--deployment-log":
        options.deploymentLog = mustValue(argv, ++i, arg);
        break;
      case "--history-scope": {
        const value = mustValue(argv, ++i, arg);
        if (value !== "all" && value !== "latest" && value !== "custom") {
          throw new Error(`Invalid --history-scope: ${value}`);
        }
        options.historyScope = value;
        break;
      }
      case "--custom-targets":
        options.customTargets = mustValue(argv, ++i, arg);
        break;
      case "--recovery-to":
        options.recoveryTo = mustValue(argv, ++i, arg);
        break;
      case "--include-user-wallets": {
        const value = mustValue(argv, ++i, arg).toLowerCase();
        if (value !== "true" && value !== "false") {
          throw new Error("--include-user-wallets must be true|false");
        }
        options.includeUserWallets = value === "true";
        break;
      }
      case "--min-native-reserve-base":
        options.minNativeReserveByChain[8453] = parseEther(mustValue(argv, ++i, arg));
        break;
      case "--min-native-reserve-worldchain":
        options.minNativeReserveByChain[480] = parseEther(mustValue(argv, ++i, arg));
        break;
      case "--min-native-reserve-bsc":
        options.minNativeReserveByChain[56] = parseEther(mustValue(argv, ++i, arg));
        break;
      case "--max-txs": {
        const value = Number(mustValue(argv, ++i, arg));
        if (!Number.isInteger(value) || value <= 0) throw new Error("--max-txs must be a positive integer");
        options.maxTxs = value;
        break;
      }
      case "--report-file":
        options.reportFile = path.resolve(rootDir, mustValue(argv, ++i, arg));
        break;
      case "--help":
        printHelpAndExit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.historyScope === "custom" && !options.customTargets) {
    throw new Error("--history-scope custom requires --custom-targets <path>");
  }

  options.deploymentJson = path.resolve(rootDir, options.deploymentJson);
  options.deploymentLog = path.resolve(rootDir, options.deploymentLog);
  options.customTargets = options.customTargets ? path.resolve(rootDir, options.customTargets) : "";
  options.reportFile = path.resolve(rootDir, options.reportFile);

  return options;
}

function printHelpAndExit(code) {
  console.log(`Usage: node ./scripts/recover-live-test-funds.mjs [options]\n\nOptions:\n  --execute\n  --deployment-json <path>\n  --deployment-log <path>\n  --history-scope all|latest|custom\n  --custom-targets <path>\n  --recovery-to <address>\n  --include-user-wallets true|false\n  --min-native-reserve-base <eth>\n  --min-native-reserve-worldchain <eth>\n  --min-native-reserve-bsc <bnb>\n  --max-txs <n>\n  --report-file <path>\n`);
  process.exit(code);
}

function mustValue(argv, idx, flag) {
  const value = argv[idx];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function createReport({ cli, sink, deployment, walletSet }) {
  return {
    meta: {
      startedAt: new Date().toISOString(),
      execute: cli.execute,
      historyScope: cli.historyScope,
      deploymentJson: cli.deploymentJson,
      deploymentLog: cli.deploymentLog,
      sink,
      includeUserWallets: cli.includeUserWallets,
      maxTxs: cli.maxTxs,
      deploymentDeployedAt: deployment?.deployedAt ?? ""
    },
    discovery: {
      targets: {
        lockManagers: [],
        hubReceivers: [],
        skippedNoCode: [],
        skippedUnknownChain: []
      },
      wallets: walletSet.wallets.map((wallet) => ({ key: wallet.key, address: wallet.address }))
    },
    operations: [],
    unresolved: [],
    summary: {
      planned: 0,
      executed: 0,
      skipped: 0,
      failed: 0,
      executedTxs: 0,
      capReached: false
    }
  };
}

function pushOperation(report, operation) {
  report.operations.push({ at: new Date().toISOString(), ...operation });
  if (operation.status === "planned") report.summary.planned += 1;
  if (operation.status === "executed") report.summary.executed += 1;
  if (operation.status === "skipped") report.summary.skipped += 1;
  if (operation.status === "failed") report.summary.failed += 1;
}

function addUnresolved(report, item) {
  report.unresolved.push({ at: new Date().toISOString(), ...item });
}

function discoverTargets({ deployment, deployLogText, historyScope, customTargetsPath }) {
  const targets = {
    lockManagers: new Map(),
    hubReceivers: new Map()
  };

  const addTarget = (kind, chainId, address, source, txHash) => {
    const normalized = normalizeAddress(address);
    if (!normalized) return;
    const chain = asNumber(chainId);
    if (chain <= 0) return;
    const key = `${chain}:${normalized.toLowerCase()}`;
    const store = kind === "lock" ? targets.lockManagers : targets.hubReceivers;
    const normalizedTx = normalizeTxHash(txHash);
    if (!store.has(key)) {
      store.set(key, { chainId: chain, address: normalized, source: [source], txHashes: normalizedTx ? [normalizedTx] : [] });
      return;
    }
    const existing = store.get(key);
    existing.source.push(source);
    if (normalizedTx && !existing.txHashes.includes(normalizedTx)) {
      existing.txHashes.push(normalizedTx);
    }
  };

  const addFromDeploymentLatest = () => {
    if (deployment?.hub?.lockManager && deployment?.hub?.chainId) {
      addTarget("lock", deployment.hub.chainId, deployment.hub.lockManager, "deployment_json");
    }
    if (deployment?.hub?.hubAcrossReceiver && deployment?.hub?.chainId) {
      addTarget("receiver", deployment.hub.chainId, deployment.hub.hubAcrossReceiver, "deployment_json");
    }
  };

  const addFromHistoricalLog = () => {
    for (const rawLine of deployLogText.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const fields = parseKeyValueFields(line);

      if (fields.contract && fields.address) {
        if (fields.contract === "hub.lockManager") {
          addTarget("lock", fields.chainId, fields.address, "deployment_log_contract", fields.tx);
        }
        if (fields.contract === "hub.hubAcrossReceiver") {
          addTarget("receiver", fields.chainId, fields.address, "deployment_log_contract", fields.tx);
        }
      }

      if (fields.key && fields.proxy) {
        if (fields.key === "hub.lockManager") {
          addTarget("lock", fields.chainId, fields.proxy, "deployment_log_action", fields.tx);
        }
        if (fields.key === "hub.hubAcrossReceiver") {
          addTarget("receiver", fields.chainId, fields.proxy, "deployment_log_action", fields.tx);
        }
      }
    }
  };

  if (historyScope === "latest") {
    addFromDeploymentLatest();
  } else if (historyScope === "all") {
    addFromDeploymentLatest();
    addFromHistoricalLog();
  } else {
    const custom = readJson(customTargetsPath);
    for (const entry of custom?.lockManagers ?? []) {
      addTarget("lock", entry.chainId, entry.address, "custom_targets");
    }
    for (const entry of custom?.hubReceivers ?? []) {
      addTarget("receiver", entry.chainId, entry.address, "custom_targets");
    }
  }

  return {
    lockManagers: [...targets.lockManagers.values()],
    hubReceivers: [...targets.hubReceivers.values()]
  };
}

async function validateTargets({ targets, clientsByChain, report }) {
  const validated = {
    lockManagers: [],
    hubReceivers: []
  };

  for (const kind of ["lockManagers", "hubReceivers"]) {
    for (const target of targets[kind]) {
      report.discovery.targets[kind].push(target);
      const client = clientsByChain[target.chainId]?.public;
      if (!client) {
        report.discovery.targets.skippedUnknownChain.push({ kind, ...target });
        continue;
      }
      try {
        const code = await client.getBytecode({ address: target.address });
        if (!code || code === "0x") {
          report.discovery.targets.skippedNoCode.push({ kind, ...target });
          continue;
        }
        validated[kind].push(target);
      } catch (error) {
        report.discovery.targets.skippedNoCode.push({ kind, ...target, error: errorMessage(error) });
      }
    }
  }

  return validated;
}

async function recoverLocks({ validatedTargets, deployment, clientsByChain, walletSet, executeTx, report }) {
  const hubTokens = collectHubTokens(deployment);
  const usersByChain = new Map();
  const assetsByChain = new Map();

  for (const target of validatedTargets.lockManagers) {
    const clientPair = clientsByChain[target.chainId];
    if (!clientPair) continue;
    const publicClient = clientPair.public;
    const latest = await publicClient.getBlockNumber();
    const fromBlock = await resolveTargetStartBlock(publicClient, target);
    const now = (await publicClient.getBlock({ blockTag: "latest" })).timestamp;

    const borrowLogs = await getLogsChunked({
      publicClient,
      address: target.address,
      event: borrowLockedEvent,
      fromBlock,
      toBlock: latest,
      chunkSize: DEFAULT_LOG_CHUNK_SIZE
    });
    const withdrawLogs = await getLogsChunked({
      publicClient,
      address: target.address,
      event: withdrawLockedEvent,
      fromBlock,
      toBlock: latest,
      chunkSize: DEFAULT_LOG_CHUNK_SIZE
    });

    const intents = new Map();
    for (const log of [...borrowLogs, ...withdrawLogs]) {
      const intentId = log.args.intentId;
      const user = normalizeAddress(log.args.user);
      const asset = normalizeAddress(log.args.asset);
      if (!intentId) continue;
      if (!intents.has(intentId)) intents.set(intentId, { intentId, user, asset });
      if (user) {
        addToSetMap(usersByChain, target.chainId, user.toLowerCase());
      }
      if (asset) {
        addToSetMap(assetsByChain, target.chainId, asset.toLowerCase());
      }
    }

    for (const { intentId } of intents.values()) {
      const lock = await readLock(publicClient, target.address, intentId);
      if (lock.status !== LOCK_STATUS_ACTIVE) {
        pushOperation(report, {
          type: "lock_recovery",
          status: "skipped",
          reason: `lock_not_active:${lock.status}`,
          chainId: target.chainId,
          target: target.address,
          intentId
        });
        continue;
      }

      const attemptCancel = async (functionName) => {
        return writeWithWallets({
          functionName,
          args: [intentId],
          chainId: target.chainId,
          contract: target.address,
          abi: lockManagerAbi,
          clientsByChain,
          walletSet
        });
      };

      const resCancel = await executeTx({
        op: {
          type: "lock_recovery",
          action: "cancelLock",
          chainId: target.chainId,
          target: target.address,
          intentId
        },
        writer: () => attemptCancel("cancelLock"),
        recordFailureUnresolved: false
      });

      if (resCancel.status === "executed" || resCancel.status === "planned") continue;

      if (now >= lock.expiry) {
        await executeTx({
          op: {
            type: "lock_recovery",
            action: "cancelExpiredLock",
            chainId: target.chainId,
            target: target.address,
            intentId
          },
          writer: () => attemptCancel("cancelExpiredLock")
        });
      } else {
        addUnresolved(report, {
          type: "lock_recovery",
          action: "cancelLock",
          chainId: target.chainId,
          target: target.address,
          intentId,
          reason: `lock_active_unexpired_or_unauthorized:${resCancel.error ?? "cancelLock_failed"}`
        });
      }
    }

    const userSet = usersByChain.get(target.chainId) ?? new Set();
    const assetSet = assetsByChain.get(target.chainId) ?? new Set();

    for (const token of hubTokens) assetSet.add(token.toLowerCase());

    for (const user of userSet) {
      for (const asset of assetSet) {
        try {
          const reservedDebt = await publicClient.readContract({
            address: target.address,
            abi: lockManagerAbi,
            functionName: "reservedDebt",
            args: [user, asset]
          });
          if (reservedDebt > 0n) {
            addUnresolved(report, {
              type: "lock_reservation_check",
              chainId: target.chainId,
              target: target.address,
              user,
              asset,
              reason: `reservedDebt_nonzero:${reservedDebt.toString()}`
            });
          }
        } catch (error) {
          addUnresolved(report, {
            type: "lock_reservation_check",
            chainId: target.chainId,
            target: target.address,
            user,
            asset,
            reason: errorMessage(error)
          });
        }
      }
    }

    for (const asset of assetSet) {
      try {
        const reservedLiquidity = await publicClient.readContract({
          address: target.address,
          abi: lockManagerAbi,
          functionName: "reservedLiquidity",
          args: [asset]
        });
        if (reservedLiquidity > 0n) {
          addUnresolved(report, {
            type: "lock_reservation_check",
            chainId: target.chainId,
            target: target.address,
            asset,
            reason: `reservedLiquidity_nonzero:${reservedLiquidity.toString()}`
          });
        }
      } catch (error) {
        addUnresolved(report, {
          type: "lock_reservation_check",
          chainId: target.chainId,
          target: target.address,
          asset,
          reason: errorMessage(error)
        });
      }
    }
  }
}

async function recoverPendingDeposits({ validatedTargets, clientsByChain, walletSet, sink, executeTx, report }) {
  for (const target of validatedTargets.hubReceivers) {
    const clientPair = clientsByChain[target.chainId];
    if (!clientPair) continue;
    const publicClient = clientPair.public;
    const latest = await publicClient.getBlockNumber();
    const fromBlock = await resolveTargetStartBlock(publicClient, target);
    const now = (await publicClient.getBlock({ blockTag: "latest" })).timestamp;

    const pendingLogs = await getLogsChunked({
      publicClient,
      address: target.address,
      event: pendingRecordedEvent,
      fromBlock,
      toBlock: latest,
      chunkSize: DEFAULT_LOG_CHUNK_SIZE
    });

    const pendingIds = [...new Set(pendingLogs.map((log) => log.args.pendingId).filter(Boolean))];

    let receiverConfig = null;
    let receiverConfigUpdated = false;

    for (const pendingId of pendingIds) {
      let pending = await readPending(publicClient, target.address, pendingId);
      if (!pending) {
        pushOperation(report, {
          type: "pending_recovery",
          status: "skipped",
          chainId: target.chainId,
          target: target.address,
          pendingId,
          reason: "pending_not_found"
        });
        continue;
      }

      if (pending.state === PENDING_ACTIVE && now >= pending.finalizeDeadline) {
        await executeTx({
          op: {
            type: "pending_recovery",
            action: "expirePendingDeposit",
            chainId: target.chainId,
            target: target.address,
            pendingId
          },
          writer: () => writeWithWallets({
            functionName: "expirePendingDeposit",
            args: [pendingId],
            chainId: target.chainId,
            contract: target.address,
            abi: hubReceiverAbi,
            clientsByChain,
            walletSet
          })
        });
        pending = await readPending(publicClient, target.address, pendingId);
      }

      const sweepEligibleNow =
        (pending.state === PENDING_ACTIVE || pending.state === PENDING_EXPIRED)
        && now >= pending.sweepEligibleAt;

      if (sweepEligibleNow) {
        if (!receiverConfig) {
          receiverConfig = await readReceiverConfig(publicClient, target.address);
        }

        if (receiverConfig.recoveryVault.toLowerCase() !== sink.toLowerCase()) {
          const nextPendingFinalizeTtl =
            receiverConfig.pendingFinalizeTtl > 0n ? receiverConfig.pendingFinalizeTtl : DEFAULT_RECOVERY_PENDING_FINALIZE_TTL;
          const nextRecoverySweepDelay =
            receiverConfig.recoverySweepDelay > 0n ? receiverConfig.recoverySweepDelay : DEFAULT_RECOVERY_SWEEP_DELAY;

          const updateRes = await executeTx({
            op: {
              type: "pending_recovery",
              action: "setRecoveryConfig",
              chainId: target.chainId,
              target: target.address,
              fromVault: receiverConfig.recoveryVault,
              toVault: sink,
              pendingFinalizeTtl: nextPendingFinalizeTtl.toString(),
              recoverySweepDelay: nextRecoverySweepDelay.toString()
            },
            writer: () => writeWithWallets({
              functionName: "setRecoveryConfig",
              args: [sink, nextPendingFinalizeTtl, nextRecoverySweepDelay],
              chainId: target.chainId,
              contract: target.address,
              abi: hubReceiverAbi,
              clientsByChain,
              walletSet
            })
          });

          if (updateRes.status === "executed") {
            receiverConfig.recoveryVault = sink;
            receiverConfig.pendingFinalizeTtl = nextPendingFinalizeTtl;
            receiverConfig.recoverySweepDelay = nextRecoverySweepDelay;
            receiverConfigUpdated = true;
          }
          if (updateRes.status === "failed") {
            addUnresolved(report, {
              type: "pending_recovery",
              chainId: target.chainId,
              target: target.address,
              pendingId,
              reason: "recovery_vault_update_failed"
            });
            continue;
          }
        }

        await executeTx({
          op: {
            type: "pending_recovery",
            action: "sweepExpiredPending",
            chainId: target.chainId,
            target: target.address,
            pendingId,
            configUpdated: receiverConfigUpdated
          },
          writer: () => writeWithWallets({
            functionName: "sweepExpiredPending",
            args: [pendingId],
            chainId: target.chainId,
            contract: target.address,
            abi: hubReceiverAbi,
            clientsByChain,
            walletSet
          })
        });

        pending = await readPending(publicClient, target.address, pendingId);
      }

      classifyPendingState({ report, target, pendingId, pending, now });
    }
  }
}

async function recoverWalletBalances({ deployment, clientsByChain, walletSet, sink, cli, executeTx, report }) {
  const tokensByChain = collectTokensByChain(deployment);

  for (const wallet of walletSet.wallets) {
    if (wallet.address.toLowerCase() === sink.toLowerCase()) continue;

    for (const [chainIdString, clientPair] of Object.entries(clientsByChain)) {
      const chainId = Number(chainIdString);
      const publicClient = clientPair.public;
      const walletClient = createWalletClient({
        account: wallet.account,
        chain: clientPair.chain,
        transport: http(clientPair.rpcUrl)
      });

      const chainTokens = tokensByChain.get(chainId) ?? [];

      for (const token of chainTokens) {
        try {
          const balance = await publicClient.readContract({
            address: token.address,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [wallet.address]
          });
          if (balance <= 0n) continue;

          await executeTx({
            op: {
              type: "wallet_recovery",
              action: "erc20_transfer",
              chainId,
              wallet: wallet.address,
              walletKey: wallet.key,
              token: token.address,
              symbol: token.symbol,
              amount: balance.toString(),
              to: sink
            },
            writer: async () => {
              const hash = await walletClient.writeContract({
                account: wallet.account,
                address: token.address,
                abi: erc20Abi,
                functionName: "transfer",
                args: [sink, balance]
              });
              await publicClient.waitForTransactionReceipt({ hash });
              return hash;
            }
          });
        } catch (error) {
          addUnresolved(report, {
            type: "wallet_recovery",
            chainId,
            wallet: wallet.address,
            walletKey: wallet.key,
            token: token.address,
            reason: errorMessage(error)
          });
        }
      }

      try {
        const nativeBalance = await publicClient.getBalance({ address: wallet.address });
        const reserve = cli.minNativeReserveByChain[chainId] ?? 0n;
        const gasPrice = await publicClient.getGasPrice().catch(() => 1_000_000_000n);
        const gasBuffer = gasPrice * 21_000n * 2n;

        if (nativeBalance <= reserve + gasBuffer) continue;
        const sendable = nativeBalance - reserve - gasBuffer;
        if (sendable <= 0n) continue;

        await executeTx({
          op: {
            type: "wallet_recovery",
            action: "native_transfer",
            chainId,
            wallet: wallet.address,
            walletKey: wallet.key,
            amount: sendable.toString(),
            to: sink,
            reserve: reserve.toString(),
            gasBuffer: gasBuffer.toString()
          },
          writer: async () => {
            const hash = await walletClient.sendTransaction({
              account: wallet.account,
              to: sink,
              value: sendable
            });
            await publicClient.waitForTransactionReceipt({ hash });
            return hash;
          }
        });
      } catch (error) {
        addUnresolved(report, {
          type: "wallet_recovery",
          chainId,
          wallet: wallet.address,
          walletKey: wallet.key,
          reason: errorMessage(error)
        });
      }
    }
  }
}

function classifyPendingState({ report, target, pendingId, pending, now }) {
  if (!pending) {
    addUnresolved(report, {
      type: "pending_recovery",
      chainId: target.chainId,
      target: target.address,
      pendingId,
      reason: "missing_pending_after_actions"
    });
    return;
  }

  if (pending.state === PENDING_SWEPT || pending.state === PENDING_FINALIZED) {
    pushOperation(report, {
      type: "pending_recovery",
      status: "skipped",
      chainId: target.chainId,
      target: target.address,
      pendingId,
      reason: pending.state === PENDING_SWEPT ? "pending_swept" : "pending_finalized"
    });
    return;
  }

  if (pending.state === PENDING_ACTIVE && now < pending.finalizeDeadline) {
    addUnresolved(report, {
      type: "pending_recovery",
      chainId: target.chainId,
      target: target.address,
      pendingId,
      reason: "pending_active_unexpired"
    });
    return;
  }

  if (pending.state === PENDING_EXPIRED && now < pending.sweepEligibleAt) {
    addUnresolved(report, {
      type: "pending_recovery",
      chainId: target.chainId,
      target: target.address,
      pendingId,
      reason: "pending_expired_not_yet_sweepable"
    });
    return;
  }

  addUnresolved(report, {
    type: "pending_recovery",
    chainId: target.chainId,
    target: target.address,
    pendingId,
    reason: `pending_state_unresolved:${pending.state}`
  });
}

async function readLock(publicClient, lockManager, intentId) {
  const lock = await publicClient.readContract({
    address: lockManager,
    abi: lockManagerAbi,
    functionName: "locks",
    args: [intentId]
  });

  return {
    status: asNumber(lock?.status ?? lock?.[8] ?? 0),
    expiry: asBigInt(lock?.expiry ?? lock?.[7] ?? 0n)
  };
}

async function readPending(publicClient, receiver, pendingId) {
  try {
    const pending = await publicClient.readContract({
      address: receiver,
      abi: hubReceiverAbi,
      functionName: "pendingDeposits",
      args: [pendingId]
    });

    const state = asNumber(pending?.state ?? pending?.[0] ?? 0);
    if (state === 0) return null;

    return {
      state,
      finalizeDeadline: asBigInt(pending?.finalizeDeadline ?? pending?.[2] ?? 0n),
      sweepEligibleAt: asBigInt(pending?.sweepEligibleAt ?? pending?.[3] ?? 0n)
    };
  } catch {
    return null;
  }
}

async function readReceiverConfig(publicClient, receiver) {
  const [recoveryVault, pendingFinalizeTtl, recoverySweepDelay] = await Promise.all([
    publicClient.readContract({ address: receiver, abi: hubReceiverAbi, functionName: "recoveryVault" }),
    publicClient.readContract({ address: receiver, abi: hubReceiverAbi, functionName: "pendingFinalizeTtl" }),
    publicClient.readContract({ address: receiver, abi: hubReceiverAbi, functionName: "recoverySweepDelay" })
  ]);

  return {
    recoveryVault: normalizeAddress(recoveryVault) ?? zeroAddress,
    pendingFinalizeTtl: asBigInt(pendingFinalizeTtl),
    recoverySweepDelay: asBigInt(recoverySweepDelay)
  };
}

async function writeWithWallets({ functionName, args, chainId, contract, abi, clientsByChain, walletSet }) {
  const chainPair = clientsByChain[chainId];
  if (!chainPair) throw new Error(`unsupported_chain:${chainId}`);

  const candidates = walletSet.wallets;
  let lastError = null;

  for (const wallet of candidates) {
    try {
      const walletClient = createWalletClient({
        account: wallet.account,
        chain: chainPair.chain,
        transport: http(chainPair.rpcUrl)
      });
      const hash = await walletClient.writeContract({
        account: wallet.account,
        address: contract,
        abi,
        functionName,
        args
      });
      await chainPair.public.waitForTransactionReceipt({ hash });
      return hash;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error(`write_failed:${functionName}`);
}

async function getLogsChunked({ publicClient, address, event, fromBlock, toBlock, chunkSize }) {
  const logs = [];
  let cursor = fromBlock;

  while (cursor <= toBlock) {
    const end = cursor + chunkSize - 1n <= toBlock ? cursor + chunkSize - 1n : toBlock;
    const chunkLogs = await publicClient.getLogs({
      address,
      event,
      fromBlock: cursor,
      toBlock: end
    });
    logs.push(...chunkLogs);
    cursor = end + 1n;
  }

  return logs;
}

async function resolveTargetStartBlock(publicClient, target) {
  const txHashes = Array.isArray(target?.txHashes) ? target.txHashes : [];
  if (txHashes.length === 0) return 0n;

  let start = null;
  for (const txHash of txHashes) {
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
      if (!receipt?.blockNumber) continue;
      if (start === null || receipt.blockNumber < start) {
        start = receipt.blockNumber;
      }
    } catch {
      // Ignore bad/missing historical tx hashes; fall back to block 0.
    }
  }

  return start ?? 0n;
}

function resolveWalletSet(env, includeUserWallets) {
  const wallets = [];
  for (const key of KEY_NAMES) {
    if (!includeUserWallets && (key === "USER1_PRIVATE_KEY" || key === "USER2_PRIVATE_KEY")) continue;

    const privateKey = (env[key] ?? "").trim();
    if (!privateKey) continue;

    try {
      const account = privateKeyToAccount(privateKey);
      wallets.push({ key, account, address: account.address, privateKey });
    } catch {
      // ignore invalid key
    }
  }

  const deduped = new Map();
  for (const wallet of wallets) {
    const key = wallet.address.toLowerCase();
    if (!deduped.has(key)) deduped.set(key, wallet);
  }

  return { wallets: [...deduped.values()] };
}

function createClientsByChain(deployment, env) {
  const clients = {};

  const addClient = (chainId, rpcUrl, label, symbol) => {
    if (!chainId || !rpcUrl) return;
    const chain = defineChain({
      id: Number(chainId),
      name: label,
      nativeCurrency: { name: symbol, symbol, decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } }
    });
    clients[Number(chainId)] = {
      chain,
      rpcUrl,
      public: createPublicClient({ chain, transport: http(rpcUrl) })
    };
  };

  if (deployment?.hub?.chainId && deployment?.hub?.rpcUrl) {
    addClient(deployment.hub.chainId, deployment.hub.rpcUrl, "Hub", "ETH");
  }

  for (const [network, spoke] of Object.entries(deployment?.spokes ?? {})) {
    const meta = NETWORKS[network] ?? { label: network, nativeSymbol: "ETH" };
    addClient(spoke.chainId, spoke.rpcUrl, meta.label, meta.nativeSymbol);
  }

  for (const network of Object.values(NETWORKS)) {
    if (clients[network.chainId]) continue;
    const rpcUrl = (env[`${network.envPrefix}_RPC_URL`] ?? "").trim();
    if (!rpcUrl) continue;
    addClient(network.chainId, rpcUrl, network.label, network.nativeSymbol);
  }

  return clients;
}

function collectHubTokens(deployment) {
  const result = new Set();
  for (const token of Object.values(deployment?.tokens ?? {})) {
    const hubToken = normalizeAddress(token?.hub);
    if (hubToken) result.add(hubToken);
  }
  return [...result];
}

function collectTokensByChain(deployment) {
  const byChain = new Map();
  const setToken = (chainId, address, symbol) => {
    const normalized = normalizeAddress(address);
    if (!normalized) return;
    const existing = byChain.get(chainId) ?? [];
    if (!existing.some((t) => t.address.toLowerCase() === normalized.toLowerCase())) {
      existing.push({ address: normalized, symbol });
      byChain.set(chainId, existing);
    }
  };

  const hubChainId = asNumber(deployment?.hub?.chainId);
  for (const [symbol, token] of Object.entries(deployment?.tokens ?? {})) {
    setToken(hubChainId, token?.hub, symbol);
  }

  for (const [network, spoke] of Object.entries(deployment?.spokes ?? {})) {
    const chainId = asNumber(spoke?.chainId);
    for (const [symbol, token] of Object.entries(deployment?.tokens ?? {})) {
      setToken(chainId, token?.spokes?.[network], symbol);
    }
  }

  return byChain;
}

function parseKeyValueFields(line) {
  const fields = {};
  for (const part of line.split(/\s+/)) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx);
    const value = part.slice(idx + 1);
    fields[key] = value;
  }
  return fields;
}

function addToSetMap(map, key, value) {
  const current = map.get(key) ?? new Set();
  current.add(value);
  map.set(key, current);
}

function printInventory({ cli, sink, walletSet, targetSelection, validatedTargets, deployment }) {
  console.log("[recover-live] ==============================================");
  console.log(`[recover-live] mode=${cli.execute ? "execute" : "dry-run"} historyScope=${cli.historyScope}`);
  console.log(`[recover-live] sink=${sink}`);
  console.log(`[recover-live] deployment=${path.relative(rootDir, cli.deploymentJson)} deployedAt=${deployment?.deployedAt ?? "unknown"}`);
  console.log(`[recover-live] wallets=${walletSet.wallets.length} includeUserWallets=${cli.includeUserWallets}`);
  console.log(
    `[recover-live] targets lockManagers discovered=${targetSelection.lockManagers.length} validated=${validatedTargets.lockManagers.length}`
  );
  console.log(
    `[recover-live] targets hubReceivers discovered=${targetSelection.hubReceivers.length} validated=${validatedTargets.hubReceivers.length}`
  );
  console.log("[recover-live] ==============================================");
}

function defaultReportPath() {
  const now = new Date();
  const stamp = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
    "-",
    String(now.getUTCHours()).padStart(2, "0"),
    String(now.getUTCMinutes()).padStart(2, "0"),
    String(now.getUTCSeconds()).padStart(2, "0")
  ].join("");
  return path.join(rootDir, "contracts", "deployments", `recovery-report-${stamp}.json`);
}

function normalizeAddress(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || !isAddress(trimmed, { strict: false })) return undefined;
  return getAddress(trimmed);
}

function normalizeTxHash(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(trimmed)) return undefined;
  return trimmed;
}

function asBigInt(value) {
  try {
    return BigInt(value ?? 0);
  } catch {
    return 0n;
  }
}

function asNumber(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const data = fs.readFileSync(filePath, "utf8");
  const env = {};
  for (const raw of data.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    env[key] = value;
  }
  return env;
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function errorMessage(error) {
  return String(error?.shortMessage ?? error?.message ?? error);
}
