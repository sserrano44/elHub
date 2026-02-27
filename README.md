elhub

Official site: `https://elhub.finance`

Multi-chain intent-based DeFi money market with hub-side accounting on Base and spoke execution on Worldchain and BSC.

## What this repo includes
- Hub contracts (Base): money market, risk manager, intent inbox, lock manager, settlement, verifier, custody, token registry.
- Spoke contracts (Worldchain/BSC): portal for supply/repay initiation + withdraw fills, and Across borrow receiver for borrow fills.
- ZK plumbing: verifier interface + dev mode + circuit scaffold.
- Services:
  - `services/indexer`: canonical lifecycle/status API.
  - `services/relayer`: lock/Across dispatch orchestration + proof finalization for deposits and borrow fills.
  - `services/prover`: settlement batching + proof generation plumbing.
- Next.js app (`apps/web`) with wallet flows for dashboard, supply, borrow, repay, withdraw, activity.
- Monorepo packages:
  - `packages/abis`: generated ABIs from Foundry artifacts.
  - `packages/sdk`: shared intent signing, hashing, and protocol clients.

## Repo structure

```
/apps
  /web
/services
  /relayer
  /indexer
  /prover
/packages
  /sdk
  /abis
/contracts
  /src
  /test
  /script
/circuits
```

## Requirements
- Node.js `>=22`
- Foundry (`forge`, `cast`, `anvil`)
- `pnpm` via Corepack

## One-command local environment

```bash
# from repo root
pnpm install
pnpm dev
```

`pnpm dev` runs:
1. Hub-local anvil (`:8545`, chain id from `HUB_NETWORK`)
2. Spoke-local anvil (`:9545`, chain id from first network in `SPOKE_NETWORKS`)
3. Hub + spoke deployments (`contracts/script/deploy-local.sh`)
4. ABI generation (`packages/abis`)
5. `indexer`, `prover`, `relayer`, and `web` apps

### Helpful URLs (local)
- Web UI: `http://127.0.0.1:3000`
- Indexer API: `http://127.0.0.1:3030`
- Relayer API: `http://127.0.0.1:3040`
- Prover API: `http://127.0.0.1:3050`

## Contracts

### Hub (Base in production)
- `HubMoneyMarket`: share-based supply/debt accounting, interest accrual, settlement hooks, liquidation skeleton.
- `HubRiskManager`: HF math + lock/borrow/withdraw checks + caps.
- `ChainlinkPriceOracle`: Chainlink `AggregatorV3` adapter with heartbeat/staleness checks, bounds, and decimal normalization to `e8`.
- `HubIntentInbox`: EIP-712 validation + nonce consumption.
- `HubLockManager`: mandatory lock/reservation for borrow/withdraw intents.
- `HubSettlement`: batched settlement with verifier, replay protection, lock/fill/deposit checks.
- `Verifier`: `DEV_MODE` dummy proof support + real verifier slot.
- `DepositProofVerifier`: witness->public-input adapter for deposit proof verification.
- `BorrowFillProofVerifier`: witness->public-input adapter for borrow fill proof verification.
- `HubCustody`: bridged funds intake + controlled release to market.
- `HubAcrossReceiver`: Across callback receiver that records pending fills and finalizes deposits only after proof verification.
- `HubAcrossBorrowDispatcher`: hub-side Across dispatcher for borrow fulfillment transport.
- `HubAcrossBorrowFinalizer`: hub-side proof-gated recorder for borrow fill evidence.
- `TokenRegistry`: token mappings (hub/spoke), decimals, risk, bridge adapter id.

### Spoke (Base / BSC)
- `SpokePortal`: supply/repay initiation (escrow + bridge call).
- `MockBridgeAdapter`: local bridging simulation event sink.
- `AcrossBridgeAdapter`: Across V3 transport adapter with route + caller controls and message binding for proof finalization.
- `MockAcrossSpokePool`: local Across-style SpokePool used for source deposit event emission and local callback simulation in E2E harnesses.
- `SpokeAcrossBorrowReceiver`: spoke Across callback receiver that transfers borrow proceeds and emits proof-bound source event.

## End-to-end lifecycle

### Supply / Repay
1. User calls `SpokePortal.initiateSupply` or `initiateRepay`.
2. Across transport emits source deposit event on spoke.
3. Across destination fill triggers hub callback; `HubAcrossReceiver` records `pending_fill` (untrusted message, no custody credit yet).
4. Anyone can call `HubAcrossReceiver.finalizePendingDeposit` with a valid deposit proof.
5. On proof success, receiver moves bridged funds into `HubCustody` and registers the bridged deposit exactly once.
6. Prover batches deposit actions and submits settlement proof.
7. Hub settlement credits supply or repays debt.

### Borrow
1. User signs EIP-712 intent in UI.
2. Relayer locks intent on hub (`HubLockManager.lock`).
3. Relayer dispatches hub->spoke Across fill via `HubAcrossBorrowDispatcher.dispatchBorrowFill`.
4. Across destination fill calls `SpokeAcrossBorrowReceiver.handleV3AcrossMessage` and emits `BorrowFillRecorded`.
5. Relayer/prover submit borrow fill proof to `HubAcrossBorrowFinalizer.finalizeBorrowFill`.
6. Finalizer records proof-verified borrow fill evidence in settlement.
7. Prover batches finalize actions and settles.
8. Settlement consumes lock, updates accounting, reimburses relayer on hub.

### Withdraw
1. User signs EIP-712 intent in UI.
2. Relayer locks intent on hub (`HubLockManager.lock`).
3. Relayer dispatches hub->spoke Across fill via `HubAcrossBorrowDispatcher.dispatchBorrowFill` with `intentType=WITHDRAW`.
4. Across destination fill calls `SpokeAcrossBorrowReceiver.handleV3AcrossMessage` and emits `BorrowFillRecorded`.
5. Relayer/prover submit withdraw fill proof to `HubAcrossBorrowFinalizer.finalizeBorrowFill`.
6. Finalizer records proof-verified withdraw fill evidence in settlement.
7. Prover batches finalize actions and settles.
8. Settlement consumes lock, updates accounting, reimburses relayer on hub.

## Testing

```bash
cd contracts
forge build
forge test --offline
```

Tests cover:
- Interest accrual invariants (indices monotonic, shares-to-assets behavior)
- HF checks for borrow/withdraw locks
- Chainlink oracle adapter checks (staleness, non-positive answers, decimal normalization)
- Risk manager oracle bound enforcement
- Supply+borrow lock/fill/settle happy path
- Across pending-fill + proof-gated bridge crediting invariants
- Replay protections (batch, intent, fill)
- Failure paths (missing lock/fill, expired intent)
- Settlement atomicity rollback on mid-batch failure
- Settlement max action cap enforcement (`MAX_BATCH_ACTIONS = 50`)

Run focused oracle/risk hardening tests:

```bash
cd contracts
forge test --offline --match-contract ChainlinkOracleAndRiskBoundsTest -vv
```

### Base fork integration test (ETH supply + USDC borrow)

Start an anvil fork of Base:

```bash
anvil --fork-url "$BASE_RPC_URL" --port 8545
```

Run the fork test suite:

```bash
cd contracts
RUN_FORK_TESTS=1 BASE_FORK_URL=http://127.0.0.1:8545 forge test --match-contract ForkBaseSupplyBorrowTest -vv
```

Notes:
- The test uses canonical Base `WETH` for ETH supply (`ETH -> WETH -> supply`).
- The borrow leg uses a freshly deployed `USDC` mock on the fork for deterministic liquidity across Forge versions.
- Coverage includes:
  - supply ETH collateral + borrow USDC
  - full lifecycle: borrow -> repay -> withdraw collateral
  - liquidation when ETH price drops below safe collateralization

### Fork E2E (Base hub + selected spoke forks)

If you run a hub fork on `:8545` and spoke fork on `:8546`, execute:

```bash
HUB_NETWORK=base \
SPOKE_NETWORKS=worldchain \
BASE_TENDERLY_RPC_URL=http://127.0.0.1:8545 \
WORLDCHAIN_TENDERLY_RPC_URL=http://127.0.0.1:8546 \
pnpm test:e2e:fork
```

The E2E runner will:
1. build + deploy contracts to the fork nodes
2. start `indexer`, `prover`, and `relayer`
3. run supply->settle flow
4. run borrow->lock/Across-dispatch/proof-finalize->settle flow
5. assert hub supply/debt state

Notes:
1. `scripts/e2e-fork.mjs` now reads `.env` automatically.
2. RPC resolution order:
   1. explicit process env (`HUB_NETWORK`, `SPOKE_NETWORKS`, `<NETWORK>_TENDERLY_RPC_URL`, `<NETWORK>_RPC_URL`)
   2. `.env` with the same keys
   3. local fallbacks (`http://127.0.0.1:8545` hub, `http://127.0.0.1:8546` spoke)
3. `scripts/e2e-fork.mjs` uses the first entry in `SPOKE_NETWORKS` as the active spoke.
4. When RPCs are Tenderly, `scripts/e2e-fork.mjs` can fund deployer/relayer/bridge/prover with `tenderly_setBalance`.
5. Funding knobs:
   1. `E2E_USE_TENDERLY_FUNDING` (default `1`)
   2. `E2E_MIN_DEPLOYER_GAS_ETH` (default `2`)
   3. `E2E_MIN_OPERATOR_GAS_ETH` (default `0.05`)

### Spoke -> Base-hub supply-only E2E

To run only the inbound supply path for Base-hub semantics (default spoke: Worldchain):

```bash
HUB_NETWORK=base \
SPOKE_NETWORKS=worldchain \
BASE_TENDERLY_RPC_URL=http://127.0.0.1:8545 \
WORLDCHAIN_TENDERLY_RPC_URL=http://127.0.0.1:8546 \
pnpm test:e2e:base-hub-supply
```

This wrapper runs `scripts/e2e-fork.mjs` with `E2E_SUPPLY_ONLY=1` and asserts:
1. deposit reaches `pending_fill`
2. deposit is proof-finalized to `bridged`
3. settlement credits supply on hub

Legacy alias: `pnpm test:e2e:base-mainnet-supply` still forwards to the Base-hub supply wrapper.

For local/fork tests only, the script simulates the destination relay callback with `MockAcrossSpokePool.relayV3Deposit`; production relayer runtime no longer performs this relay simulation.

### Live E2E (Base hub + Worldchain/BSC spokes, real RPCs)

This run executes against live chain RPCs (no Tenderly vnets) and validates real Across processing:

```bash
HUB_NETWORK=base \
SPOKE_NETWORKS=worldchain,bsc \
BASE_RPC_URL=<base-mainnet-rpc> \
WORLDCHAIN_RPC_URL=<worldchain-mainnet-rpc> \
BSC_RPC_URL=<bsc-mainnet-rpc> \
HUB_GROTH16_VERIFIER_ADDRESS=<groth16-verifier-on-base> \
HUB_LIGHT_CLIENT_VERIFIER_ADDRESS=<light-client-verifier-on-base> \
HUB_ACROSS_DEPOSIT_EVENT_VERIFIER_ADDRESS=<deposit-event-verifier-on-base> \
HUB_ACROSS_BORROW_FILL_EVENT_VERIFIER_ADDRESS=<borrow-fill-event-verifier-on-base> \
pnpm test:e2e:live:base-world-bsc
```

Rerun without redeploying:

```bash
E2E_LIVE_SKIP_DEPLOY=1 pnpm test:e2e:live:base-world-bsc
```

Notes:
1. `scripts/e2e-live-base-world-bsc.mjs` hard-fails if any configured RPC URL is Tenderly in `LIVE_MODE=1`.
2. The live runner never calls relay simulation paths (`simulateAcrossRelay` / `MockAcrossSpokePool.relayV3Deposit`).
3. Deployment artifacts are written under `contracts/deployments/live-*.{json,env}` for local reuse; do not commit the generated `live-*.env`.
4. UUPS deployment state is tracked in `contracts/deployments/live-base-world-bsc.manifest.json` and action logs in `contracts/deployments/live_deployed_contracts.log`.

### E2E command set

Active E2E commands:
1. `pnpm test:e2e:base-hub-supply` (smoke path for inbound supply lifecycle to Base hub)
2. `pnpm test:e2e:fork` (full supply + borrow lifecycle)
3. `pnpm test:e2e:live:base-world-bsc` (Base hub + Worldchain/BSC live scenario on real RPCs)
4. `pnpm test:e2e` (runs both local/fork active E2E commands)

## CI
- GitHub Actions workflow: `.github/workflows/ci.yml`
- Jobs:
  - `contracts`: `forge build` + `forge test --offline`
  - `monorepo-build`: install deps, regenerate ABIs, build all workspaces

## ABI generation

```bash
pnpm abis:generate
```

Reads Foundry artifacts from `contracts/out` and writes JSON ABIs into `packages/abis/src/generated`.

## Deployment artifacts
After local deploy:
- `contracts/deployments/local.json`
- `contracts/deployments/local.env`
- copied to `apps/web/public/deployments/local.json`

## ZK mode notes
- Local dev uses `DEV_MODE=true` verifier with proof payload `ZKHUB_DEV_PROOF`.
- Production mode requires deploying `Verifier` with:
  - `DEV_MODE=false`
  - non-zero `initialGroth16Verifier`
  - `PUBLIC_INPUT_COUNT=4` (batchId, hubChainId, spokeChainId, actionsRoot)
- `actionsRoot` is SNARK-field-safe and deterministic from settlement action ordering.
- Real-proof plumbing is implemented in `services/prover` via `CircuitProofProvider` (`snarkjs groth16 fullprove`).
- Build circuit artifacts with `bash ./circuits/prover/build-artifacts.sh`.
- Set `PROVER_MODE=circuit` to use real Groth16 proofs.
- `contracts/script/deploy-local.mjs` supports verifier modes:
  - `HUB_VERIFIER_DEV_MODE=1` (default): deploy `Verifier` in dev proof mode.
  - `HUB_VERIFIER_DEV_MODE=0`: requires `HUB_GROTH16_VERIFIER_ADDRESS` and deploys `Groth16VerifierAdapter` + prod `Verifier`.

## Production wiring notes
- Configure oracle stack (recommended):
  - Deploy `ChainlinkPriceOracle(owner)`.
  - For each supported hub asset, call:
    - `ChainlinkPriceOracle.setFeed(asset, feed, heartbeat, minPriceE8, maxPriceE8)`
  - Deploy `HubRiskManager(owner, tokenRegistry, moneyMarket, chainlinkOracle)`.
  - Optionally set global bounds on risk manager:
    - `HubRiskManager.setOracleBounds(minPriceE8, maxPriceE8)`
- Oracle notes:
  - `ChainlinkPriceOracle` rejects stale rounds (`block.timestamp - updatedAt > heartbeat`), non-positive answers, and invalid rounds.
  - Feed decimals are normalized to protocol-wide `e8`.
  - Keep heartbeat and bounds conservative per asset and chain.
- Configure `AcrossBridgeAdapter` (recommended inbound transport path):
  - `setAllowedCaller(<SpokePortal>, true)`
  - `setRoute(localToken, acrossSpokePool, hubToken, exclusiveRelayer, fillDeadlineBuffer, true)` per token
  - `SpokePortal.setBridgeAdapter(<AcrossBridgeAdapter>)`
- Configure hub-side Across receiver:
  - deploy `HubAcrossReceiver(admin, custody, depositProofVerifier, hubSpokePool)`
  - grant `CANONICAL_BRIDGE_RECEIVER_ROLE` on `HubCustody` to `HubAcrossReceiver`
  - do not grant attester/operator EOAs any custody bridge registration role
- Configure Across borrow fulfillment path:
  - deploy `HubAcrossBorrowDispatcher(admin, hubAcrossBorrowFinalizer)`
  - deploy `SpokeAcrossBorrowReceiver(admin, spokeAcrossSpokePool)`
  - configure dispatcher routes per hub asset (`setRoute`) and allow relayer caller (`setAllowedCaller`)
  - grant `PROOF_FILL_ROLE` on `HubSettlement` to `HubAcrossBorrowFinalizer`
- Relayer inbound behavior:
  - observe spoke Across deposit logs for source metadata (`initiated`):
    - canonical live event: `FundsDeposited`
    - local/fork mock event: `V3FundsDeposited`
  - observe hub `PendingDepositRecorded` for `pending_fill`
  - request proof from prover and call `finalizePendingDeposit`
  - do not call `relayV3Deposit` in production runtime
- Relayer borrow behavior:
  - lock intent on hub and dispatch borrow/withdraw via `HubAcrossBorrowDispatcher`
  - observe spoke `BorrowFillRecorded`
  - request proof from prover and call `HubAcrossBorrowFinalizer.finalizeBorrowFill`
  - do not use any direct spoke fill function in production runtime
- For settlement verifier, deploy generated Groth16 verifier bytecode and wire it through `Groth16VerifierAdapter`:
  - deploy generated verifier (from `snarkjs zkey export solidityverifier`)
  - deploy `Groth16VerifierAdapter(owner, generatedVerifier)`
  - set `Verifier.setGroth16Verifier(<adapter>)` with `DEV_MODE=false`.
- Production-verifier settlement path is covered in tests (`test_prodVerifierPath_settlementRejectsTamperedProofAndAcceptsValid`).

## Threat model (MVP)
- Hub is source of truth for all accounting and risk checks.
- No fast credit for collateral: supply/repay only apply post-settlement.
- No operator/attester direct bridge credit path in runtime: inbound deposits require `HubAcrossReceiver` proof finalization before `HubCustody` registration.
- Borrow/withdraw requires hub-side lock and reservation before spoke fill.
- Settlement batch replay is blocked by `batchId` replay protection.
- Intent finalization replay blocked via lock consumption + settled intent tracking.
- Spoke double-fills blocked by `SpokeAcrossBorrowReceiver.intentFilled`.
- `DEV_MODE` verifier does not provide production cryptographic guarantees.
- Local Across flow still uses mocked SpokePools; production must use real Across contracts and a production-grade light-client/ZK deposit proof backend.

## Production readiness
- Detailed execution plan: `PRODUCTION_READINESS_PLAN.md`
- Detailed technical specification: `TECHNICAL_SPEC.md`

## Operational notes
- If your shell cannot write to default Corepack/Pnpm home directories, set:

```bash
export COREPACK_HOME="$PWD/.corepack"
export PNPM_HOME="$PWD/.pnpm-home"
export PATH="$PNPM_HOME:$PATH"
```

- Local services depend on environment emitted by `contracts/deployments/local.env`.
- Internal service routes (`/internal/*`) require signed HMAC headers using `INTERNAL_API_AUTH_SECRET`.
