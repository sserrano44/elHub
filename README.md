elhub

Official site: `https://elhub.finance`

Multi-chain intent-based DeFi money market with hub-side accounting on Ethereum mainnet and spoke execution on Base and BSC.

## What this repo includes
- Hub contracts (Ethereum mainnet): money market, risk manager, intent inbox, lock manager, settlement, verifier, custody, token registry.
- Spoke contracts (Base/BSC): portal for supply/repay initiation and borrow/withdraw fills.
- ZK plumbing: verifier interface + dev mode + circuit scaffold.
- Services:
  - `services/indexer`: canonical lifecycle/status API.
  - `services/relayer`: lock/fill orchestration + spoke deposit bridging simulation.
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
1. Ethereum-mainnet-local anvil (`:8545`, chain id `1`)
2. Spoke-local anvil (`:9545`, chain id `8453` for `SPOKE_NETWORK=base`, `56` for `SPOKE_NETWORK=bsc`)
3. Hub + spoke deployments (`contracts/script/deploy-local.sh`)
4. ABI generation (`packages/abis`)
5. `indexer`, `prover`, `relayer`, and `web` apps

### Helpful URLs (local)
- Web UI: `http://127.0.0.1:3000`
- Indexer API: `http://127.0.0.1:3030`
- Relayer API: `http://127.0.0.1:3040`
- Prover API: `http://127.0.0.1:3050`

## Contracts

### Hub (Ethereum mainnet)
- `HubMoneyMarket`: share-based supply/debt accounting, interest accrual, settlement hooks, liquidation skeleton.
- `HubRiskManager`: HF math + lock/borrow/withdraw checks + caps.
- `ChainlinkPriceOracle`: Chainlink `AggregatorV3` adapter with heartbeat/staleness checks, bounds, and decimal normalization to `e8`.
- `HubIntentInbox`: EIP-712 validation + nonce consumption.
- `HubLockManager`: mandatory lock/reservation for borrow/withdraw intents.
- `HubSettlement`: batched settlement with verifier, replay protection, lock/fill/deposit checks.
- `Verifier`: `DEV_MODE` dummy proof support + real verifier slot.
- `HubCustody`: bridged funds intake + controlled release to market.
- `CanonicalBridgeReceiverAdapter`: hub-side bridge attestation entrypoint with `ATTESTER_ROLE`.
- `TokenRegistry`: token mappings (hub/spoke), decimals, risk, bridge adapter id.

### Spoke (Base / BSC)
- `SpokePortal`: supply/repay initiation (escrow + bridge call) and fill execution for borrow/withdraw.
- `MockBridgeAdapter`: local bridging simulation event sink.
- `CanonicalBridgeAdapter`: production adapter with allowlisted callers and per-token canonical routes.

## End-to-end lifecycle

### Supply / Repay
1. User calls `SpokePortal.initiateSupply` or `initiateRepay`.
2. Relayer watches spoke events.
3. Canonical bridge attestation is forwarded through `CanonicalBridgeReceiverAdapter` to `HubCustody.registerBridgedDeposit`.
4. Prover batches deposit actions and submits settlement proof.
5. Hub settlement credits supply or repays debt.

### Borrow / Withdraw
1. User signs EIP-712 intent in UI.
2. Relayer locks intent on hub (`HubLockManager.lock`).
3. Relayer fills user on spoke (`SpokePortal.fillBorrow/fillWithdraw`).
4. Relayer records fill evidence on hub settlement.
5. Prover batches finalize actions and settles.
6. Settlement consumes lock, updates accounting, reimburses relayer on hub.

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

### Cross-chain fork E2E test (hub fork + selected spoke, lock/fill/settle)

With hub fork on `:8545` and spoke fork on `:8546`:

```bash
cd contracts
RUN_FORK_TESTS=1 \
# BASE_FORK_URL is the legacy env key used by this Forge test for hub fork RPC.
BASE_FORK_URL=http://127.0.0.1:8545 \
SPOKE_NETWORK=bsc \
SPOKE_BSC_RPC_URL=http://127.0.0.1:8546 \
forge test --match-contract ForkCrossChainE2ETest -vv
```

This test executes:
1. supply ETH collateral on hub market
2. sign + lock borrow intent on hub
3. fill borrow on selected spoke
4. settle batch on hub and verify debt + relayer reimbursement + lock consumption

### Fork E2E (Ethereum hub + selected spoke forks)

If you run a hub fork on `:8545` and spoke fork on `:8546`, execute:

```bash
HUB_RPC_URL=http://127.0.0.1:8545 \
SPOKE_NETWORK=base \
SPOKE_BASE_RPC_URL=http://127.0.0.1:8546 \
pnpm test:e2e:fork
```

The E2E runner will:
1. build + deploy contracts to the fork nodes
2. start `indexer`, `prover`, and `relayer`
3. run supply->settle flow
4. run borrow->lock/fill->settle flow
5. assert hub supply/debt state

Notes:
1. `scripts/e2e-fork.mjs` now reads `.env` automatically.
2. RPC resolution order:
   1. explicit process env (`HUB_RPC_URL`, `SPOKE_NETWORK`, `SPOKE_<NETWORK>_RPC_URL`)
   2. `.env` with the same keys
   3. base local fallback (`http://127.0.0.1:8546`) only when `SPOKE_NETWORK=base`
3. This allows switching spokes by changing `SPOKE_NETWORK` plus one spoke RPC variable.
4. When RPCs are Tenderly, `scripts/e2e-fork.mjs` can fund deployer/relayer/bridge/prover with `tenderly_setBalance` (Admin RPC).
5. Optional Tenderly Admin RPC envs:
   1. `HUB_ADMIN_RPC_URL` (falls back to `HUB_RPC_URL`)
   2. `SPOKE_<NETWORK>_ADMIN_RPC_URL` (falls back to `SPOKE_<NETWORK>_RPC_URL`)
6. Funding knobs:
   1. `E2E_USE_TENDERLY_FUNDING` (default `1`)
   2. `E2E_MIN_DEPLOYER_GAS_ETH` (default `2`)
   3. `E2E_MIN_OPERATOR_GAS_ETH` (default `0.05`)

### Circuit-mode fork E2E (real Groth16 path, no dev verifier)

This flow enforces:
- `PROVER_MODE=circuit`
- `HUB_VERIFIER_DEV_MODE=0`
- non-zero `HUB_GROTH16_VERIFIER_ADDRESS`

#### 1) Prepare RPC endpoints

```bash
# Option A: Local anvil forks
anvil --fork-url "$HUB_RPC_URL" --port 8545
anvil --fork-url "$SPOKE_BASE_RPC_URL" --port 8546
```

#### 2) Build circuit artifacts

```bash
bash ./circuits/prover/build-artifacts.sh
```

Artifacts expected by the prover:
- `circuits/prover/artifacts/SettlementBatchRoot_js/SettlementBatchRoot.wasm`
- `circuits/prover/artifacts/SettlementBatchRoot_final.zkey`

#### 3) Deploy generated Groth16 verifier on hub fork

`snarkjs zkey export solidityverifier` produces `circuits/prover/artifacts/Groth16Verifier.generated.sol`.

Example deploy:

```bash
forge create \
  --rpc-url http://127.0.0.1:8545 \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --broadcast \
  ./circuits/prover/artifacts/Groth16Verifier.generated.sol:Groth16Verifier
```

Copy the deployed verifier address.

If your generated contract name differs from `Groth16Verifier`, replace `:Groth16Verifier` accordingly.

#### 4) Run circuit-mode E2E (one command)

```bash
pnpm test:e2e:fork:circuit
```

`test:e2e:fork:circuit` is now one-shot:
1. runs `scripts/e2e-fork-circuit-prepare.mjs --json` to resolve/deploy verifier env
2. runs `scripts/e2e-fork-circuit.mjs` with that resolved env

If you need to run the circuit runner directly with pre-set env only:

```bash
pnpm test:e2e:fork:circuit:exec
```

#### 5) Prepare helper (manual/debug)

You can use:

```bash
pnpm test:e2e:fork:circuit:prepare
```

Behavior:
1. Loads `.env` and resolves Hub/Spoke RPCs (including Tenderly vars).
2. If `HUB_GROTH16_VERIFIER_ADDRESS` is missing and generated verifier source exists, auto-deploys it with `forge create --broadcast`.
3. Prints exact `export ...` lines and the final `pnpm test:e2e:fork:circuit` command to run.

Optional env overrides for prepare script:
1. `HUB_GROTH16_VERIFIER_SOURCE`
2. `HUB_GROTH16_VERIFIER_CONTRACT`
3. `DEPLOYER_PRIVATE_KEY`
4. `ENABLE_FORGE_BROADCAST` (default `1`; set `0` only for debug dry-runs)

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
- Configure `CanonicalBridgeAdapter`:
  - `setAllowedCaller(<SpokePortal>, true)`
  - `setRoute(localToken, canonicalBridge, remoteToken, minGasLimit, true)` per token
  - `SpokePortal.setBridgeAdapter(<CanonicalBridgeAdapter>)`
- Configure hub-side bridge receiver:
  - grant `ATTESTER_ROLE` on `CanonicalBridgeReceiverAdapter` to trusted attesters
  - grant `CANONICAL_BRIDGE_RECEIVER_ROLE` on `HubCustody` to `CanonicalBridgeReceiverAdapter`
- For settlement verifier, deploy generated Groth16 verifier bytecode and wire it through `Groth16VerifierAdapter`:
  - deploy generated verifier (from `snarkjs zkey export solidityverifier`)
  - deploy `Groth16VerifierAdapter(owner, generatedVerifier)`
  - set `Verifier.setGroth16Verifier(<adapter>)` with `DEV_MODE=false`.
- Production-verifier settlement path is covered in tests (`test_prodVerifierPath_settlementRejectsTamperedProofAndAcceptsValid`).

## Threat model (MVP)
- Hub is source of truth for all accounting and risk checks.
- No fast credit for collateral: supply/repay only apply post-settlement.
- Borrow/withdraw requires hub-side lock and reservation before spoke fill.
- Settlement batch replay is blocked by `batchId` replay protection.
- Intent finalization replay blocked via lock consumption + settled intent tracking.
- Spoke double-fills blocked by `filledIntent` mapping.
- `DEV_MODE` verifier does not provide production cryptographic guarantees.
- Bridge integration is mocked locally; production must use canonical bridge adapters and real event commitments.

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
