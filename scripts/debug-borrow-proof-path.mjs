#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, decodeAbiParameters, encodeAbiParameters, encodeFunctionData, http, parseAbi } from "viem";

function usageAndExit(message) {
  if (message) {
    console.error(message);
  }
  console.error(
    "Usage: node scripts/debug-borrow-proof-path.mjs --deployment <path> --payload <path> [--hub-rpc <url>] [--caller <0x...>]"
  );
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--")) continue;
    if (!value || value.startsWith("--")) usageAndExit(`Missing value for ${key}`);
    args[key.slice(2)] = value;
    i += 1;
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function extractBorrowPayload(raw) {
  if (raw?.kind === "borrow_fill_finalization" && raw?.payload) return raw.payload;
  if (raw?.payload?.witness && raw?.payload?.sourceEvidence) return raw.payload;
  if (raw?.witness && raw?.sourceEvidence) return raw;
  throw new Error("Payload JSON must be a borrow_fill_finalization task, a payload wrapper, or a direct payload object.");
}

function normalizeWitness(payload) {
  const witness = payload.witness;
  if (!witness) throw new Error("payload.witness is required");
  return {
    sourceChainId: BigInt(witness.sourceChainId),
    intentId: witness.intentId,
    intentType: Number(witness.intentType),
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

function normalizeSourceProof(payload) {
  const sourceEvidence = payload.sourceEvidence;
  if (!sourceEvidence) throw new Error("payload.sourceEvidence is required");
  return {
    sourceBlockNumber: BigInt(sourceEvidence.sourceBlockNumber),
    sourceBlockHash: sourceEvidence.sourceBlockHash,
    receiptsRoot: sourceEvidence.sourceReceiptsRoot,
    sourceReceiver: sourceEvidence.sourceReceiver
  };
}

function buildCanonicalBorrowFillProof(witness, source, destinationDispatcher, destinationFinalizer, destinationChainId) {
  const finalityProof = encodeAbiParameters(
    [
      { name: "sourceChainId", type: "uint256" },
      { name: "sourceBlockNumber", type: "uint256" },
      { name: "sourceBlockHash", type: "bytes32" }
    ],
    [witness.sourceChainId, source.sourceBlockNumber, source.sourceBlockHash]
  );

  const inclusionProof = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "sourceChainId", type: "uint256" },
          { name: "sourceBlockHash", type: "bytes32" },
          { name: "receiptsRoot", type: "bytes32" },
          { name: "sourceTxHash", type: "bytes32" },
          { name: "sourceLogIndex", type: "uint256" },
          { name: "sourceReceiver", type: "address" },
          { name: "intentId", type: "bytes32" },
          { name: "intentType", type: "uint8" },
          { name: "user", type: "address" },
          { name: "recipient", type: "address" },
          { name: "spokeToken", type: "address" },
          { name: "hubAsset", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "fee", type: "uint256" },
          { name: "relayer", type: "address" },
          { name: "messageHash", type: "bytes32" },
          { name: "destinationChainId", type: "uint256" },
          { name: "hubDispatcher", type: "address" },
          { name: "hubFinalizer", type: "address" }
        ]
      }
    ],
    [
      {
        sourceChainId: witness.sourceChainId,
        sourceBlockHash: source.sourceBlockHash,
        receiptsRoot: source.receiptsRoot,
        sourceTxHash: witness.sourceTxHash,
        sourceLogIndex: witness.sourceLogIndex,
        sourceReceiver: source.sourceReceiver,
        intentId: witness.intentId,
        intentType: witness.intentType,
        user: witness.user,
        recipient: witness.recipient,
        spokeToken: witness.spokeToken,
        hubAsset: witness.hubAsset,
        amount: witness.amount,
        fee: witness.fee,
        relayer: witness.relayer,
        messageHash: witness.messageHash,
        destinationChainId,
        hubDispatcher: destinationDispatcher,
        hubFinalizer: destinationFinalizer
      }
    ]
  );

  const payload = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "sourceBlockNumber", type: "uint256" },
          { name: "sourceBlockHash", type: "bytes32" },
          { name: "receiptsRoot", type: "bytes32" },
          { name: "sourceReceiver", type: "address" },
          { name: "finalityProof", type: "bytes" },
          { name: "inclusionProof", type: "bytes" }
        ]
      }
    ],
    [
      {
        sourceBlockNumber: source.sourceBlockNumber,
        sourceBlockHash: source.sourceBlockHash,
        receiptsRoot: source.receiptsRoot,
        sourceReceiver: source.sourceReceiver,
        finalityProof,
        inclusionProof
      }
    ]
  );

  return encodeAbiParameters(
    [
      { name: "version", type: "uint8" },
      { name: "payload", type: "bytes" }
    ],
    [1, payload]
  );
}

function decodeCanonicalBorrowFillProof(proofHex) {
  const decodedProof = decodeAbiParameters(
    [
      { name: "version", type: "uint8" },
      { name: "payload", type: "bytes" }
    ],
    proofHex
  );
  const version = Number(decodedProof[0]);
  if (version !== 1) {
    throw new Error(`Unsupported canonical proof version=${version}`);
  }
  const payload = decodedProof[1];
  const decodedPayload = decodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "sourceBlockNumber", type: "uint256" },
          { name: "sourceBlockHash", type: "bytes32" },
          { name: "receiptsRoot", type: "bytes32" },
          { name: "sourceReceiver", type: "address" },
          { name: "finalityProof", type: "bytes" },
          { name: "inclusionProof", type: "bytes" }
        ]
      }
    ],
    payload
  );
  return decodedPayload[0];
}

function errorSummary(error) {
  const short = error?.shortMessage ?? error?.message ?? String(error);
  const reason = error?.cause?.reason ?? error?.reason;
  if (reason && !String(short).includes(String(reason))) {
    return `${short} | reason=${reason}`;
  }
  return String(short);
}

async function runBoolStage(label, fn) {
  try {
    const ok = await fn();
    return { label, outcome: ok ? "true" : "false" };
  } catch (error) {
    return { label, outcome: "revert", error: errorSummary(error) };
  }
}

async function runFinalizerStage(label, fn) {
  try {
    await fn();
    return { label, outcome: "success" };
  } catch (error) {
    return { label, outcome: "revert", error: errorSummary(error) };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.deployment || !args.payload) {
    usageAndExit();
  }

  const deployment = readJson(args.deployment);
  const rawPayload = readJson(args.payload);
  const payload = extractBorrowPayload(rawPayload);
  const witness = normalizeWitness(payload);
  const sourceProof = normalizeSourceProof(payload);

  const hubRpc = args["hub-rpc"] ?? deployment?.hub?.rpcUrl ?? process.env.HUB_RPC_URL;
  if (!hubRpc) throw new Error("Missing hub RPC URL. Pass --hub-rpc or include hub.rpcUrl in deployment JSON.");

  const hubChainId = Number(deployment?.hub?.chainId ?? process.env.HUB_CHAIN_ID ?? 0);
  if (!Number.isInteger(hubChainId) || hubChainId <= 0) throw new Error("Invalid hub chain ID in deployment/env");

  const chain = {
    id: hubChainId,
    name: "Hub",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [hubRpc] } }
  };

  const publicClient = createPublicClient({ chain, transport: http(hubRpc) });

  const backendAddress = deployment?.hub?.borrowFillProofBackend;
  const borrowFillVerifierAddress = deployment?.hub?.borrowFillProofVerifier;
  const finalizerAddress = deployment?.hub?.hubAcrossBorrowFinalizer;
  const destinationChainId = BigInt(deployment?.hub?.chainId);

  if (!backendAddress || !borrowFillVerifierAddress || !finalizerAddress) {
    throw new Error("Deployment JSON must include hub.borrowFillProofBackend, hub.borrowFillProofVerifier and hub.hubAcrossBorrowFinalizer");
  }

  const backendAbi = parseAbi([
    "function lightClientVerifier() view returns (address)",
    "function eventVerifier() view returns (address)",
    "function destinationDispatcher() view returns (address)",
    "function verifyCanonicalBorrowFill((uint256 sourceChainId,bytes32 intentId,uint8 intentType,address user,address recipient,address spokeToken,address hubAsset,uint256 amount,uint256 fee,address relayer,bytes32 sourceTxHash,uint256 sourceLogIndex,bytes32 messageHash) witness,(uint256 sourceBlockNumber,bytes32 sourceBlockHash,bytes32 receiptsRoot,address sourceReceiver,bytes finalityProof,bytes inclusionProof) proof,address destinationFinalizer,uint256 destinationChainId) view returns (bool)"
  ]);
  const lightVerifierAbi = parseAbi([
    "function verifyFinalizedBlock(uint256 sourceChainId,uint256 sourceBlockNumber,bytes32 sourceBlockHash,bytes proof) view returns (bool)"
  ]);
  const eventVerifierAbi = parseAbi([
    "function verifyBorrowFillRecorded((uint256 sourceChainId,bytes32 intentId,uint8 intentType,address user,address recipient,address spokeToken,address hubAsset,uint256 amount,uint256 fee,address relayer,bytes32 sourceTxHash,uint256 sourceLogIndex,bytes32 messageHash) witness,bytes32 sourceBlockHash,bytes32 receiptsRoot,address sourceReceiver,uint256 expectedDestinationChainId,address expectedHubDispatcher,address expectedHubFinalizer,bytes proof) view returns (bool)"
  ]);
  const borrowFillVerifierAbi = parseAbi([
    "function verifyBorrowFillProof(bytes proof,(uint256 sourceChainId,bytes32 intentId,uint8 intentType,address user,address recipient,address spokeToken,address hubAsset,uint256 amount,uint256 fee,address relayer,bytes32 sourceTxHash,uint256 sourceLogIndex,bytes32 messageHash) witness) view returns (bool)"
  ]);
  const finalizerAbi = parseAbi([
    "function verifier() view returns (address)",
    "function finalizeBorrowFill(bytes proof,(uint256 sourceChainId,bytes32 intentId,uint8 intentType,address user,address recipient,address spokeToken,address hubAsset,uint256 amount,uint256 fee,address relayer,bytes32 sourceTxHash,uint256 sourceLogIndex,bytes32 messageHash) witness)"
  ]);

  const [lightVerifierAddress, eventVerifierAddress, destinationDispatcher, finalizerVerifierAddress] = await Promise.all([
    publicClient.readContract({ address: backendAddress, abi: backendAbi, functionName: "lightClientVerifier" }),
    publicClient.readContract({ address: backendAddress, abi: backendAbi, functionName: "eventVerifier" }),
    publicClient.readContract({ address: backendAddress, abi: backendAbi, functionName: "destinationDispatcher" }),
    publicClient.readContract({ address: finalizerAddress, abi: finalizerAbi, functionName: "verifier" })
  ]);

  const proof = buildCanonicalBorrowFillProof(
    witness,
    sourceProof,
    destinationDispatcher,
    finalizerAddress,
    destinationChainId
  );
  const canonicalProof = decodeCanonicalBorrowFillProof(proof);

  const stages = [];
  stages.push(await runBoolStage("light_client.verifyFinalizedBlock", async () => (
    publicClient.readContract({
      address: lightVerifierAddress,
      abi: lightVerifierAbi,
      functionName: "verifyFinalizedBlock",
      args: [witness.sourceChainId, sourceProof.sourceBlockNumber, sourceProof.sourceBlockHash, canonicalProof.finalityProof]
    })
  )));
  stages.push(await runBoolStage("event_verifier.verifyBorrowFillRecorded", async () => (
    publicClient.readContract({
      address: eventVerifierAddress,
      abi: eventVerifierAbi,
      functionName: "verifyBorrowFillRecorded",
      args: [
        witness,
        sourceProof.sourceBlockHash,
        sourceProof.receiptsRoot,
        sourceProof.sourceReceiver,
        destinationChainId,
        destinationDispatcher,
        finalizerAddress,
        canonicalProof.inclusionProof
      ]
    })
  )));
  stages.push(await runBoolStage("backend.verifyCanonicalBorrowFill", async () => (
    publicClient.readContract({
      address: backendAddress,
      abi: backendAbi,
      functionName: "verifyCanonicalBorrowFill",
      args: [witness, canonicalProof, finalizerAddress, destinationChainId]
    })
  )));
  stages.push(await runBoolStage("finalizer_verifier.verifyBorrowFillProof", async () => (
    publicClient.readContract({
      address: finalizerVerifierAddress,
      abi: borrowFillVerifierAbi,
      functionName: "verifyBorrowFillProof",
      args: [proof, witness]
    })
  )));
  stages.push(await runFinalizerStage("finalizer.finalizeBorrowFill (eth_call)", async () => {
    const calldata = encodeFunctionData({
      abi: finalizerAbi,
      functionName: "finalizeBorrowFill",
      args: [proof, witness]
    });
    await publicClient.call({
      to: finalizerAddress,
      data: calldata,
      ...(args.caller ? { account: args.caller } : {})
    });
  }));

  console.log("Borrow proof-path diagnostics");
  console.log(`- intentId: ${witness.intentId}`);
  console.log(`- sourceChainId(spoke): ${witness.sourceChainId.toString()}`);
  console.log(`- destinationChainId(hub): ${destinationChainId.toString()}`);
  console.log(`- backend: ${backendAddress}`);
  console.log(`- lightVerifier: ${lightVerifierAddress}`);
  console.log(`- eventVerifier: ${eventVerifierAddress}`);
  console.log(`- destinationDispatcher: ${destinationDispatcher}`);
  console.log(`- finalizer: ${finalizerAddress}`);
  console.log(`- finalizerVerifier: ${finalizerVerifierAddress}`);
  console.log("");

  for (const stage of stages) {
    if (stage.outcome === "revert") {
      console.log(`FAIL [${stage.label}] revert: ${stage.error}`);
    } else if (stage.outcome === "false") {
      console.log(`FAIL [${stage.label}] returned false`);
    } else {
      console.log(`OK   [${stage.label}] ${stage.outcome}`);
    }
  }

  const firstFailure = stages.find((stage) => stage.outcome === "revert" || stage.outcome === "false");
  if (firstFailure) {
    console.log("");
    console.log(`First failing stage: ${firstFailure.label} (${firstFailure.outcome})`);
    process.exit(2);
  }
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exit(1);
});
