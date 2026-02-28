# elhub Technical Specification

Version: `0.1.0`  
Last updated: `2026-02-21`

## 1. Purpose and Scope

This document defines the technical specification for elhub, a hub-and-spoke, intent-based, cross-chain money market.

Core goals:
1. Concentrate accounting and liquidity on Base (hub).
2. Allow user entry/exit on Worldchain (spoke).
3. Require hub-side pre-locking for borrow/withdraw safety.
4. Finalize all cross-chain accounting through batch settlement.
5. Support production ZK verifier mode without changing settlement interface.

In-scope components:
1. Solidity contracts under `/Users/sebas/projects/hubris/contracts/src`.
2. Relayer, indexer, prover services under `/Users/sebas/projects/hubris/services`.
3. Circuit and proving artifacts under `/Users/sebas/projects/hubris/circuits`.
4. E2E/testing flows in `/Users/sebas/projects/hubris/scripts` and `/Users/sebas/projects/hubris/contracts/test`.

## 2. Topology and Chains

### 2.1 Network roles
1. Hub chain: Base (source of truth for all accounting, risk, and liquidity).
2. Spoke chain: Worldchain (escrow/fill execution and event emission).

### 2.2 Default local/fork wiring
1. Hub RPC default: `http://127.0.0.1:8545`
2. Spoke RPC local default: `http://127.0.0.1:9545`
3. Spoke RPC fork E2E default: `http://127.0.0.1:8546`
4. Hub chain ID default: `8453`
5. Spoke chain ID default: `480`

## 3. Assets and Registry Model

Initial assets:
1. `WETH` (18 decimals)
2. `USDC` (6 decimals)
3. `wARS` (18 decimals default)
4. `wBRL` (18 decimals default)

`TokenRegistry` (`/Users/sebas/projects/hubris/contracts/src/hub/TokenRegistry.sol`) stores:
1. Hub token address.
2. Spoke token address.
3. Decimals.
4. Risk params: `ltvBps`, `liquidationThresholdBps`, `liquidationBonusBps`, `supplyCap`, `borrowCap`.
5. `bridgeAdapterId`.
6. `enabled` flag.

## 4. Core Data Structures

Defined in `/Users/sebas/projects/hubris/contracts/src/libraries/DataTypes.sol`.

### 4.1 Intent
```
Intent {
  uint8 intentType;        // 1=SUPPLY, 2=REPAY, 3=BORROW, 4=WITHDRAW
  address user;
  uint256 inputChainId;
  uint256 outputChainId;
  address inputToken;
  address outputToken;
  uint256 amount;
  address recipient;
  uint256 maxRelayerFee;
  uint256 nonce;
  uint256 deadline;
}
```

### 4.2 SettlementBatch
```
SettlementBatch {
  uint256 batchId;
  uint256 hubChainId;
  uint256 spokeChainId;
  bytes32 actionsRoot;
  SupplyCredit[] supplyCredits;
  RepayCredit[] repayCredits;
  BorrowFinalize[] borrowFinalizations;
  WithdrawFinalize[] withdrawFinalizations;
}
```

## 5. Contract Specifications

### 5.1 HubMoneyMarket
File: `/Users/sebas/projects/hubris/contracts/src/hub/HubMoneyMarket.sol`

Responsibilities:
1. Track per-asset supply/debt shares and indices.
2. Accrue interest via kink utilization model.
3. Execute direct hub supply/borrow/repay/withdraw.
4. Execute settlement-only credit/finalize entry points.
5. Execute liquidation.

Key state:
1. `markets[asset] = { totalSupplyShares, totalDebtShares, supplyIndex, borrowIndex, reserves, lastAccrual, initialized }`
2. `supplyShares[user][asset]`
3. `debtShares[user][asset]`

Access control:
1. Owner sets `riskManager` and `settlement`.
2. Settlement-only functions gated by `onlySettlement`.

Settlement entry points:
1. `settlementCreditSupply(user, asset, amount)`
2. `settlementCreditRepay(user, asset, amount)`
3. `settlementFinalizeBorrow(user, asset, amount, relayer, fee)`
4. `settlementFinalizeWithdraw(user, asset, amount, relayer, fee)`

### 5.2 HubRiskManager
File: `/Users/sebas/projects/hubris/contracts/src/hub/HubRiskManager.sol`

Responsibilities:
1. Enforce supply/borrow caps and enabled assets.
2. Compute health factor and liquidation status.
3. Check lock-time and runtime borrow/withdraw feasibility.

Health factor:
1. Per-asset supply value: `supplyAmount * priceE8 / 10^decimals`
2. Per-asset debt value: `debtAmount * priceE8 / 10^decimals`
3. Adjusted collateral: `sum(supplyValue * liquidationThresholdBps / 10_000)`
4. HF: `adjustedCollateral * 1e18 / totalDebtValue`
5. Liquidatable when `HF < 1e18`

Lock-aware behavior:
1. Includes `reservedWithdraw` subtraction from supply.
2. Includes `reservedDebt` addition to debt.

### 5.3 HubIntentInbox
File: `/Users/sebas/projects/hubris/contracts/src/hub/HubIntentInbox.sol`

Responsibilities:
1. EIP-712 intent verification.
2. Nonce replay protection.
3. Consumer allowlist for intent consumption.

Domain:
1. Name: `ElHubIntentInbox`
2. Version: `1`

Nonce model:
1. `nonceUsed[user][nonce]` boolean.

### 5.4 HubLockManager
File: `/Users/sebas/projects/hubris/contracts/src/hub/HubLockManager.sol`

Responsibilities:
1. Enforce mandatory lock before borrow/withdraw fill.
2. Reserve hub liquidity and user borrowing/withdrawal headroom.
3. Bind lock to relayer and expiry.
4. Consume/cancel locks.

Lock statuses:
1. `0` none
2. `1` active
3. `2` consumed
4. `3` cancelled

Reservation state:
1. `reservedLiquidity[asset]`
2. `reservedDebt[user][asset]`
3. `reservedWithdraw[user][asset]`

### 5.5 HubCustody
File: `/Users/sebas/projects/hubris/contracts/src/hub/HubCustody.sol`

Responsibilities:
1. Register bridged deposits (`CANONICAL_BRIDGE_RECEIVER_ROLE`).
2. Release matched deposits to market (`SETTLEMENT_ROLE`).
3. Enforce one-time consume semantics per `depositId`.

### 5.6 HubAcrossReceiver
File: `/Users/sebas/projects/hubris/contracts/src/hub/HubAcrossReceiver.sol`

Responsibilities:
1. Accept Across callback only from configured hub `SpokePool`.
2. Treat callback message as untrusted and store a `pending` fill only.
3. Track actual `tokenSent` and `amountReceived` from callback params.
4. Finalize pending fill permissionlessly via `verifyDepositProof`.
5. Move funds into `HubCustody` and call `registerBridgedDeposit` only after valid proof.
6. Enforce replay protection via finalization key:
   1. `sourceChainId + sourceTxHash + sourceLogIndex + depositId + messageHash`.

### 5.7 HubSettlement
File: `/Users/sebas/projects/hubris/contracts/src/hub/HubSettlement.sol`

Responsibilities:
1. Verify proof and public inputs.
2. Enforce batch replay protection.
3. Validate action root consistency.
4. Apply supply/repay credits and borrow/withdraw finalizations atomically.
5. Enforce fill-evidence and lock-consumption checks.

Replay protections:
1. `batchExecuted[batchId]`
2. `depositSettled[depositId]`
3. `intentSettled[intentId]`
4. `fillEvidence[intentId].consumed`

Batch max:
1. `MAX_BATCH_ACTIONS = 50`

### 5.8 Verifier
File: `/Users/sebas/projects/hubris/contracts/src/zk/Verifier.sol`

Modes:
1. Dev mode: `DEV_MODE=true`, proof accepted by hash match (`DEV_PROOF_HASH`).
2. Prod mode: `DEV_MODE=false`, delegates to configured verifier contract.

Public input count:
1. Configured immutable `PUBLIC_INPUT_COUNT` (current expected value `4`).

### 5.9 Groth16VerifierAdapter
File: `/Users/sebas/projects/hubris/contracts/src/zk/Groth16VerifierAdapter.sol`

Responsibilities:
1. Decode generic `bytes proof` into `(uint256[2], uint256[2][2], uint256[2])`.
2. Validate `publicInputs.length == 4`.
3. Validate each public input is `< SNARK_SCALAR_FIELD`.
4. Delegate to snarkjs-style generated verifier signature.

### 5.10 SpokePortal
File: `/Users/sebas/projects/hubris/contracts/src/spoke/SpokePortal.sol`

Responsibilities:
1. Escrow inbound supply/repay and invoke bridge adapter.

Events:
1. `SupplyInitiated`
2. `RepayInitiated`

### 5.11 Bridge Adapters
Files:
1. `/Users/sebas/projects/hubris/contracts/src/spoke/AcrossBridgeAdapter.sol`
2. `/Users/sebas/projects/hubris/contracts/src/spoke/MockBridgeAdapter.sol`
3. `/Users/sebas/projects/hubris/contracts/src/mocks/MockAcrossSpokePool.sol`

Across adapter:
1. Per-token Across route config (`spokePool`, `hubToken`, relayer/deadline fields).
2. Caller allowlist.
3. Emits Across V3 `depositV3` with encoded deposit metadata.
4. Preserves `SpokePortal` bridge adapter interface.

Mock adapter:
1. Local/dev escrow sink + event emission.
2. Owner-controlled escrow release for testing.

### 5.12 Across Borrow Fulfillment Path
Files:
1. `/Users/sebas/projects/hubris/contracts/src/hub/HubAcrossBorrowDispatcher.sol`
2. `/Users/sebas/projects/hubris/contracts/src/spoke/SpokeAcrossBorrowReceiver.sol`
3. `/Users/sebas/projects/hubris/contracts/src/hub/HubAcrossBorrowFinalizer.sol`
4. `/Users/sebas/projects/hubris/contracts/src/zk/BorrowFillProofVerifier.sol`
5. `/Users/sebas/projects/hubris/contracts/src/zk/AcrossBorrowFillProofBackend.sol`

Responsibilities:
1. `HubAcrossBorrowDispatcher` sends hub-funded borrow fills over Across to spoke receiver with deterministic message binding.
2. `SpokeAcrossBorrowReceiver` only accepts callbacks from allowlisted spoke pool and expected fill relayer, and requires message bindings for expected hub chain, hub dispatcher, and hub finalizer before transfers.
3. `HubAcrossBorrowFinalizer` permissionlessly verifies borrow-fill proof and records settlement fill evidence exactly once.
4. Borrow proof backend enforces source receiver allowlist, destination dispatcher/finalizer binding, and source finality + source event inclusion checks.
5. `HubSettlement` accepts proof-verified borrow fill evidence via `PROOF_FILL_ROLE`.

## 6. Intent and Lifecycle State Machines

### 6.1 Supply/Repay (Worldchain -> Base)
1. User calls `SpokePortal.initiateSupply` or `initiateRepay`.
2. Spoke portal escrows funds and calls Across transport (`AcrossBridgeAdapter -> depositV3`).
3. Relayer observes source Across deposit event and records `initiated`.
4. Across destination fill calls `HubAcrossReceiver.handleV3AcrossMessage`:
   1. receiver records `pending_fill` only (no custody credit).
5. Relayer observes hub `PendingDepositRecorded`, requests proof from prover, then calls `finalizePendingDeposit`.
6. On valid proof:
   1. receiver transfers bridged token to `HubCustody`.
   2. receiver calls `HubCustody.registerBridgedDeposit`.
   3. indexer status updates to `bridged`.
7. Prover enqueues action.
8. Settlement batch verifies and applies supply/repay accounting.

### 6.2 Borrow (Base accounting -> Worldchain payout via Across)
1. User signs EIP-712 intent.
2. Relayer calls `HubLockManager.lock`.
3. Relayer calls `HubAcrossBorrowDispatcher.dispatchBorrowFill`.
4. Across destination fill calls `SpokeAcrossBorrowReceiver.handleV3AcrossMessage`:
   1. receiver authenticates source chain, hub dispatcher, hub finalizer, and callback relayer.
   2. receiver pays recipient and relayer fee.
   2. receiver emits `BorrowFillRecorded`.
5. Relayer observes `BorrowFillRecorded`, requests proof from prover, and calls `HubAcrossBorrowFinalizer.finalizeBorrowFill`.
6. Finalizer verifies proof and records fill evidence into settlement.
7. Prover batches finalize action.
8. Settlement consumes lock, updates hub accounting, reimburses relayer.

### 6.3 Withdraw (Base accounting -> Worldchain payout via Across)
1. User signs EIP-712 intent.
2. Relayer calls `HubLockManager.lock`.
3. Relayer calls `HubAcrossBorrowDispatcher.dispatchBorrowFill` with `intentType=WITHDRAW`.
4. Across destination fill calls `SpokeAcrossBorrowReceiver.handleV3AcrossMessage` with the same dispatcher/finalizer/relayer authentication checks.
5. Relayer observes `BorrowFillRecorded`, requests proof from prover, and calls `HubAcrossBorrowFinalizer.finalizeBorrowFill`.
6. Finalizer verifies proof and records fill evidence in settlement.
7. Prover batches finalize action.
8. Settlement consumes lock, updates hub accounting, reimburses relayer.

### 6.4 Indexer intent statuses
1. `initiated`
2. `pending_lock`
3. `locked`
4. `filled`
5. `awaiting_settlement`
6. `settled`
7. `failed`

### 6.5 Indexer deposit statuses
1. `initiated`
2. `pending_fill`
3. `bridged`
4. `settled`

## 7. Proof System Specification

### 7.1 Field and hash
Constants:
1. `SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617`
2. `HASH_BETA = 1315423911`
3. `HASH_C = 11400714819323198485`

`hashPair(left,right)`:
1. `t = (left + right*BETA + C) mod field`
2. output = `t^5 mod field`

### 7.2 actionsRoot derivation
For a batch:
1. Start with `hashPair(batchId, hubChainId)`.
2. Fold `spokeChainId`.
3. Fold total action count.
4. Fold each action hash in deterministic order:
   1. all supply credits
   2. all repay credits
   3. all borrow finalizations
   4. all withdraw finalizations
5. Right-pad with zero action hashes until 50 actions.
6. Final state serialized as `bytes32` root.

### 7.3 Public inputs
Current public inputs passed on-chain:
1. `batchId` (field reduced)
2. `hubChainId` (field reduced)
3. `spokeChainId` (field reduced)
4. `actionsRoot` (field reduced)

### 7.4 Circuit
File: `/Users/sebas/projects/hubris/circuits/circom/SettlementBatchRoot.circom`

Public signals:
1. `batchId`
2. `hubChainId`
3. `spokeChainId`
4. `actionsRoot`

Private witness:
1. `actionCount`
2. `actionIds[50]` (padded)

Current limitation:
1. Circuit proves deterministic root consistency, not full bridge/lock/fill validity constraints.

## 8. Off-Chain Service Specifications

### 8.1 Relayer service
File: `/Users/sebas/projects/hubris/services/relayer/src/server.ts`

Public endpoints:
1. `GET /health`
2. `GET /quote?intentType=<n>&amount=<uint>`
3. `POST /intent/submit`

Behavior:
1. Watches spoke Across deposit logs:
   1. canonical live event `FundsDeposited`
   2. local/fork mock event `V3FundsDeposited`
2. Updates indexer via signed internal calls.
3. Waits for hub-side Across callback (`PendingDepositRecorded`), then runs permissionless proof finalization for inbound deposits.
4. For borrow submit:
   1. lock on hub
   2. dispatch Across fill from hub via `HubAcrossBorrowDispatcher`
   3. observe spoke `BorrowFillRecorded` with expected `hubDispatcher` and `hubFinalizer`
   4. finalize proof on hub via `HubAcrossBorrowFinalizer`
   5. enqueue prover action
5. For withdraw submit:
   1. lock on hub
   2. dispatch Across fill from hub via `HubAcrossBorrowDispatcher` (`intentType=WITHDRAW`)
   3. observe spoke `BorrowFillRecorded` with expected `hubDispatcher` and `hubFinalizer`
   4. finalize proof on hub via `HubAcrossBorrowFinalizer`
   5. enqueue prover action

### 8.2 Indexer service
File: `/Users/sebas/projects/hubris/services/indexer/src/server.ts`

Public endpoints:
1. `GET /health`
2. `GET /activity?user=<address?>`
3. `GET /intents/:intentId`
4. `GET /deposits/:depositId`

Internal endpoints (`/internal/*`, HMAC-authenticated):
1. `POST /internal/intents/upsert`
2. `POST /internal/intents/:intentId/status`
3. `POST /internal/deposits/upsert`

Persistence:
1. JSON file store (`services/indexer/src/store.ts`), not yet production DB.

### 8.3 Prover service
File: `/Users/sebas/projects/hubris/services/prover/src/server.ts`

Public endpoint:
1. `GET /health`

Internal endpoints:
1. `POST /internal/enqueue`
2. `POST /internal/flush`

Modes:
1. `PROVER_MODE=dev`: deterministic dev proof.
2. `PROVER_MODE=circuit`: executes `snarkjs groth16 fullprove`.

Queue behavior:
1. Dedup on action key.
2. Dequeue only after settlement tx receipt.
3. Persists queue and `nextBatchId` in JSON files.

### 8.4 Internal API authentication
Used by relayer/prover/indexer.

Headers:
1. `x-elhub-internal-ts`
2. `x-elhub-internal-sig`

Signature payload:
1. `METHOD + "\n" + ROUTE_PATH + "\n" + TIMESTAMP + "\n" + SHA256(rawBody)`
2. HMAC-SHA256 using `INTERNAL_API_AUTH_SECRET`.

Additional controls:
1. Timestamp skew window.
2. Replay cache.
3. Route-level rate limiting.
4. Request-id propagation (`x-request-id`) and structured audit logs.

## 9. Deployment Specification

Primary script:
1. `/Users/sebas/projects/hubris/contracts/script/deploy-local.mjs`
2. `/Users/sebas/projects/hubris/contracts/script/deploy-live-multi.mjs` (live mode, Base hub + multi-spoke)

Outputs:
1. `/Users/sebas/projects/hubris/contracts/deployments/local.json`
2. `/Users/sebas/projects/hubris/contracts/deployments/local.env`
3. `/Users/sebas/projects/hubris/apps/web/public/deployments/local.json`
4. `/Users/sebas/projects/hubris/contracts/deployments/live-<hub>-hub-<spokes>.json`
5. `/Users/sebas/projects/hubris/contracts/deployments/live-<hub>-<spokes>.manifest.json`
6. `/Users/sebas/projects/hubris/contracts/deployments/live_deployed_contracts.log`

Verifier deployment modes:
1. `HUB_VERIFIER_DEV_MODE=1`:
   1. Deploys `Verifier` in dev mode.
2. `HUB_VERIFIER_DEV_MODE=0`:
   1. Requires `HUB_GROTH16_VERIFIER_ADDRESS`.
   2. Deploys `Groth16VerifierAdapter`.
   3. Deploys `Verifier` in prod mode pointing to adapter.

## 10. E2E and Test Specifications

### 10.1 Contract test suites
Location: `/Users/sebas/projects/hubris/contracts/test`

Coverage includes:
1. Interest and share-accounting invariants.
2. Lock HF checks and reservation concurrency.
3. Settlement replay/failure/atomicity.
4. Liquidation behavior.
5. Base fork supply/borrow lifecycle.
6. Cross-chain fork lock/Across-dispatch/proof-finalize/settle path.
7. Across receiver pending-fill/proof-finalization invariants.
8. Production verifier path rejecting tampered proofs.

### 10.2 Scripted fork E2E (dev proof)
Script:
1. `/Users/sebas/projects/hubris/scripts/e2e-fork.mjs`

Command:
1. `pnpm test:e2e:fork`

RPC resolution order:
1. process env (`HUB_NETWORK`, `SPOKE_NETWORKS`, `<NETWORK>_TENDERLY_RPC_URL`, `<NETWORK>_RPC_URL`)
2. `.env` with the same keys
3. localhost defaults (`8545/8546`) for local flows

### 10.3 Spoke -> Base-hub supply-only E2E
Script:
1. `/Users/sebas/projects/hubris/scripts/e2e-base-hub-supply.mjs`

Command:
1. `pnpm test:e2e:base-hub-supply`

Checks:
1. deposit reaches `pending_fill`
2. deposit transitions to `bridged` only after proof finalization
3. settlement credits user supply on hub

### 10.4 Active E2E command set
Commands:
1. `pnpm test:e2e:base-hub-supply` (supply-only inbound lifecycle)
2. `pnpm test:e2e:fork` (full supply + borrow lifecycle)
3. `pnpm test:e2e:live:base-world-bsc` (manual real-RPC live scenario: Base hub + Worldchain/BSC spokes)
4. `pnpm test:e2e` (runs local/fork active E2E commands)

Note:
1. Live E2E is an opt-in manual gate and must run with production verifier addresses configured.

### 10.5 Live E2E (real RPC, real Across)
Script:
1. `/Users/sebas/projects/hubris/scripts/e2e-live-base-world-bsc.mjs`

Command:
1. `pnpm test:e2e:live:base-world-bsc`

Expected behavior:
1. Worldchain USDC supply reaches `pending_fill` then `bridged` then `settled`.
2. Worldchain ETH->WETH supply reaches `pending_fill` then `bridged` then `settled`.
3. BSC borrow dispatch emits Across source deposit on hub, destination fill on BSC, proof finalization on hub, then settlement to `settled`.

Operational constraints:
1. `LIVE_MODE=1` rejects any Tenderly RPC URL usage.
2. No relay simulation path is allowed in live mode.
3. `E2E_LIVE_SKIP_DEPLOY=1` is only valid when existing live deployment artifacts are present.
4. Script defaults to `PROVER_MODE=circuit` and requires production verifier contracts to be wired.

## 11. Security and Safety Requirements

Enforced in current implementation:
1. Hub-side lock required before borrow/withdraw finalization.
2. Lock relayer binding and expiry checks.
3. Spoke borrow receiver enforces expected source chain + hub dispatcher + hub finalizer + callback relayer before side effects.
4. Double-fill prevention on spoke.
5. Batch/intent/deposit replay protections in settlement.
6. Settlement applies only after verifier success.
7. Reentrancy guards on critical state transition functions.
8. Pause controls on lock manager, settlement, market, and spoke portal.

Known security gaps (tracked by readiness plan):
1. Deposit proof backend trust/quality (production must use real light-client/ZK verification constraints for source event validity).
2. Production DB/idempotent outbox model for services (P0-4).
3. Full validity constraints in ZK circuit (remaining P0-1 work).
4. Governance hardening, oracle hardening, and audit closure (P1/P2).

## 12. Open Work to Reach Production-Ready

The remaining blockers are:
1. Complete P0-1 circuit constraints:
   1. prove deposit attestation validity
   2. prove lock/fill matching validity
   3. prove amount/fee constraint validity
2. Ship production deposit proof backend (light-client/ZK) with full source-event validity constraints.
3. Complete P0-4 durable persistence migration from JSON to transactional DB + outbox.
4. Execute P1 and P2 workstreams as defined in `/Users/sebas/projects/hubris/PRODUCTION_READINESS_PLAN.md`.
