# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ElHub is a hub-and-spoke, intent-based, cross-chain money market protocol. The **hub** (Base) handles all accounting, risk checks, and liquidity. The **spoke** (Worldchain) handles user entry/exit and escrow execution. Settlement is batched and ZK-verified using Groth16 proofs.

## Monorepo Structure

**pnpm** workspaces managed by **Turbo**. Package manager: pnpm 9.12.0 (via Corepack). Requires Node.js >= 22.

- `contracts/` — Solidity 0.8.24 (Foundry). **Not** a pnpm workspace — Foundry-only.
- `circuits/` — Circom ZK circuits (Groth16 via snarkjs)
- `services/indexer/` — Intent lifecycle & status API (port 3030)
- `services/prover/` — Batch construction & ZK proof generation (port 3050)
- `services/relayer/` — Lock/fill orchestration & bridge simulation (port 3040)
- `packages/sdk/` — EIP-712 intent signing, viem clients, protocol helpers
- `packages/abis/` — Auto-generated contract ABIs from Foundry artifacts
- `apps/web/` — Next.js 15 frontend with Wagmi + TanStack Query (port 3000)
- `scripts/` — Dev environment, E2E test runners, deployment helpers

## Common Commands

```bash
pnpm install                # Install all dependencies
pnpm dev                    # Full local dev: 2 anvil chains + deploy + all services + web
pnpm build                  # Turbo build all workspaces
pnpm lint                   # Lint all (only web has linting via next lint)
pnpm test                   # Test all
pnpm format                 # Format all

# Contracts (Foundry)
pnpm contracts:build        # forge build
pnpm contracts:test         # forge test -vvv
cd contracts && forge test --match-test testFunctionName -vvv  # Run single test
cd contracts && forge test --match-contract ContractName -vvv  # Run single contract's tests

# Services (individual)
cd services/indexer && pnpm test    # tsx --test src/**/*.test.ts
cd services/prover && pnpm test     # tsx --test src/**/*.test.ts

# ABIs (regenerate after contract changes)
pnpm abis:generate

# E2E fork tests
pnpm test:e2e:fork                    # Base + Worldchain fork integration
pnpm test:e2e:base-mainnet-supply     # Base -> mainnet-hub supply lifecycle
pnpm test:e2e                         # Run active E2E suite

# Circuits
bash ./circuits/prover/build-artifacts.sh   # Build circuit artifacts (requires circom + snarkjs in PATH)
```

## Architecture: Core Data Flow

**Supply/Repay flow:**
1. User calls `SpokePortal.initiateSupply/initiateRepay` on spoke
2. Across relays funds to hub receiver (mock Across relay in local/dev)
3. Prover batches deposit actions and generates proof
4. Settlement on hub credits supply or repays debt

**Borrow/Withdraw flow:**
1. User signs EIP-712 intent via SDK
2. Relayer locks intent on hub (`HubLockManager.lock`)
3. Relayer dispatches Across fill from hub to spoke receiver
4. Relayer/prover finalizes proof-backed fill evidence on hub
5. Prover batches finalize actions and generates proof
6. Settlement consumes lock, updates accounting, reimburses relayer

**Intent status flow:** `initiated → pending_lock → locked → filled → awaiting_settlement → settled | failed`

## Contracts Architecture

Hub contracts live in `contracts/src/hub/` — the main ones are `HubMoneyMarket` (share-based accounting, interest accrual), `HubRiskManager` (health factor, LTV, caps), `HubIntentInbox` (EIP-712 verification), `HubLockManager` (lock/reservation), `HubSettlement` (batched ZK-verified settlement), `HubCustody` (bridged funds), `TokenRegistry` (hub↔spoke token mappings).

Spoke contracts live in `contracts/src/spoke/` — `SpokePortal` is the user-facing entry point for inbound supply/repay. `AcrossBridgeAdapter` and `SpokeAcrossBorrowReceiver` handle cross-chain transport/callbacks.

Shared libraries in `contracts/src/libraries/` — `Constants.sol` (WAD, RAY, BPS, MAX_BATCH_ACTIONS=50), `DataTypes.sol` (all struct definitions), `IntentHasher.sol`, `ProofHash.sol`.

ZK contracts in `contracts/src/zk/` — `Verifier.sol` supports DEV_MODE (dummy proof) and production Groth16.

## Foundry Specifics

- OpenZeppelin is **vendored**: `@openzeppelin/` remaps to `src/vendor/openzeppelin/`
- **No forge-std** — tests use a custom `TestBase.sol` (`contracts/test/utils/TestBase.sol`) with its own `Vm` cheat interface
- FFI is enabled; `via_ir = true`; Cancun EVM; optimizer 200 runs
- Fork tests require `RUN_FORK_TESTS=1` and `BASE_FORK_URL` env vars

## Services Architecture

All services use **Express.js** with **Zod** validation. TypeScript compiled with `tsc`, run with `tsx` in dev. Internal endpoints (`/internal/*`) use HMAC-SHA256 auth over `{timestamp}:{path}:{body}` with `INTERNAL_API_AUTH_SECRET`.

**Testing**: Services use **Node.js built-in test runner** (`node:test` + `node:assert/strict`), run via `tsx --test`. No Jest/Vitest.

**SQLite**: Services use `node:sqlite` (Node.js 22.5+ built-in `DatabaseSync`) — no external sqlite package. Persistence mode is configurable per service (`INDEXER_DB_KIND=json|sqlite`, `PROVER_STORE_KIND=json|sqlite`).

**Prover** has two modes controlled by `PROVER_MODE` env:
- `dev` (default): Returns dummy proof bytes
- `circuit`: Runs `snarkjs groth16 fullprove` with real artifacts

## Circuit Details

`circuits/circom/SettlementBatchRoot.circom` — Field-safe deterministic action-root hash.
- **Public inputs:** batchId, hubChainId, spokeChainId, actionsRoot
- **Private witness:** actionCount, actionIds[50]
- Iteratively hashes inputs using field-safe HashPair, constrains result to actionsRoot

## Local Development Environment

`pnpm dev` starts:
1. Two anvil instances: Base-local (port 8545, chain 8453) and Worldchain-local (port 9545, chain 480)
2. Contract deployment via `contracts/script/deploy-local.mjs` → writes `contracts/deployments/local.env` and `local.json`
3. ABI generation
4. All services + web app in parallel

The deploy script (`contracts/script/deploy-local.mjs`) deploys all contracts, wires roles, seeds liquidity, and writes deployment artifacts. `scripts/dev.sh` sources `local.env` to inject deployed addresses into service environments.

**Verifier modes:**
- Dev: `HUB_VERIFIER_DEV_MODE=1` (default) — dummy proofs accepted
- Production: `HUB_VERIFIER_DEV_MODE=0` + `HUB_GROTH16_VERIFIER_ADDRESS=<addr>`

## Key Environment Variables

See `.env.example` for the full reference. Key variables:

```
HUB_NETWORK=ethereum|base|bsc|worldchain
HUB_CHAIN_ID=8453
SPOKE_NETWORKS=base,bsc,worldchain   # Comma-separated; first is active in single-spoke flows
<NETWORK>_TENDERLY_RPC_URL           # Tenderly RPC for fork/e2e flows
<NETWORK>_RPC_URL                    # Generic RPC for live deploy flows
<NETWORK>_CHAIN_ID                   # Network chain id
INTERNAL_API_AUTH_SECRET              # HMAC key for inter-service auth
PROVER_MODE=dev|circuit               # Proof generation mode
PROVER_CIRCUIT_ARTIFACTS_DIR          # Path to circuit build artifacts
```

Deployed contract addresses are auto-set by the deploy script and written to `contracts/deployments/local.env`. RPC resolution falls back: explicit env → .env values → worldchain localhost defaults.

## TypeScript Conventions

All workspaces extend `tsconfig.base.json` (ES2022, ESNext modules, Bundler resolution, strict mode, `noUncheckedIndexedAccess`). Services and packages compile with `tsc` to `dist/`. The web app uses Next.js with `noEmit`.
