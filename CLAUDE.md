# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ZkHub is a hub-and-spoke, intent-based, cross-chain money market protocol. The **hub** (Base) handles all accounting, risk checks, and liquidity. The **spoke** (Worldchain) handles user entry/exit and escrow execution. Settlement is batched and ZK-verified using Groth16 proofs.

## Monorepo Structure

- **pnpm** workspaces managed by **Turbo**. Package manager: pnpm 9.12.0 (via Corepack).
- `contracts/` — Solidity 0.8.24 (Foundry, Cancun EVM, via-IR, optimizer 200 runs)
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
pnpm lint                   # Lint all
pnpm test                   # Test all
pnpm format                 # Format all

# Contracts (Foundry)
pnpm contracts:build        # forge build
pnpm contracts:test         # forge test -vvv
cd contracts && forge test --match-test testFunctionName -vvv  # Run single test

# ABIs (regenerate after contract changes)
pnpm abis:generate

# E2E fork tests
pnpm test:e2e:fork                    # Base + Worldchain fork integration
pnpm test:e2e:fork:circuit:prepare    # Deploy real Groth16 verifier
pnpm test:e2e:fork:circuit            # E2E with real proofs

# Circuits
bash ./circuits/prover/build-artifacts.sh   # Build circuit artifacts (requires circom + snarkjs in PATH)
```

## Architecture: Core Data Flow

**Supply/Repay flow:**
1. User calls `SpokePortal.initiateSupply/initiateRepay` on spoke
2. Relayer bridges funds to hub (mock canonical bridge in dev)
3. Prover batches deposit actions and generates proof
4. Settlement on hub credits supply or repays debt

**Borrow/Withdraw flow:**
1. User signs EIP-712 intent via SDK
2. Relayer locks intent on hub (`HubLockManager.lock`)
3. Relayer fills user on spoke (`SpokePortal.fillBorrow/fillWithdraw`)
4. Relayer records fill evidence on hub settlement
5. Prover batches finalize actions and generates proof
6. Settlement consumes lock, updates accounting, reimburses relayer

## Contracts Architecture

Hub contracts (`contracts/src/hub/`):
- `HubMoneyMarket` — Share-based supply/debt accounting, interest accrual (kink model)
- `HubRiskManager` — Health factor math, LTV, liquidation thresholds, caps
- `HubIntentInbox` — EIP-712 intent verification, nonce replay protection
- `HubLockManager` — Mandatory lock/reservation before spoke execution
- `HubSettlement` — Batched settlement with ZK verification, action root computation
- `HubCustody` — Bridged funds intake and controlled release
- `TokenRegistry` — Token mappings hub↔spoke, decimals, risk parameters
- `KinkInterestRateModel` — Variable rates with utilization kink

Spoke contracts (`contracts/src/spoke/`):
- `SpokePortal` — User-facing: initiates supply/repay, executes borrow/withdraw fills
- `CanonicalBridgeAdapter` / `MockBridgeAdapter` — Bridge abstraction

Libraries (`contracts/src/libraries/`):
- `Constants.sol` — WAD, RAY, BPS, MAX_BATCH_ACTIONS=50, SNARK_SCALAR_FIELD
- `DataTypes.sol` — Intent, SettlementBatch, SupplyCredit, BorrowFinalize structs
- `IntentHasher.sol` — EIP-712 intent hashing
- `ProofHash.sol` — SNARK-field-safe action root computation

ZK (`contracts/src/zk/`):
- `Verifier.sol` — DEV_MODE dummy proof + real Groth16 verifier slot
- `Groth16VerifierAdapter.sol` — Adapts generic proof interface to generated Groth16 verifier

## Circuit Details

`circuits/circom/SettlementBatchRoot.circom` — Field-safe deterministic action-root hash.
- **Public inputs:** batchId, hubChainId, spokeChainId, actionsRoot
- **Private witness:** actionCount, actionIds[50]
- Iteratively hashes inputs using field-safe HashPair, constrains result to actionsRoot

## Services Architecture

All services use Express.js with Zod validation. Internal endpoints (`/internal/*`) use HMAC-SHA256 auth over `{timestamp}:{path}:{body}` with `INTERNAL_API_AUTH_SECRET`.

**Prover** has two modes controlled by `PROVER_MODE` env:
- `dev` (default): Returns dummy proof bytes
- `circuit`: Runs `snarkjs groth16 fullprove` with real artifacts

**Intent status flow:** `initiated → pending_lock → locked → filled → awaiting_settlement → settled | failed`

## Local Development Environment

`pnpm dev` starts:
1. Two anvil instances: Base-local (port 8545, chain 8453) and Worldchain-local (port 9545, chain 480)
2. Contract deployment via `contracts/script/deploy-local.mjs` (writes addresses to `contracts/deployments/local.env` and `local.json`)
3. ABI generation
4. All services + web app in parallel

**Verifier modes** (deployment):
- Dev: `HUB_VERIFIER_DEV_MODE=1` (default) — dummy proofs accepted
- Production: `HUB_VERIFIER_DEV_MODE=0` + `HUB_GROTH16_VERIFIER_ADDRESS=<addr>`

## Key Environment Variables

```
HUB_RPC_URL                          # Hub RPC (default: localhost:8545)
HUB_CHAIN_ID=8453
SPOKE_NETWORK=worldchain|ethereum|bsc
SPOKE_<NETWORK>_RPC_URL              # Active spoke RPC (worldchain defaults to localhost:9545)
SPOKE_<NETWORK>_CHAIN_ID             # Active spoke chain id
INTERNAL_API_AUTH_SECRET              # HMAC key for inter-service auth
PROVER_MODE=dev|circuit               # Proof generation mode
PROVER_CIRCUIT_ARTIFACTS_DIR          # Path to circuit build artifacts
```

Deployed addresses are auto-set by the deploy script. RPC resolution falls back: explicit env → .env values → worldchain localhost defaults (for local dev).

## Foundry Specifics

- OpenZeppelin is vendored: `@openzeppelin/` remaps to `src/vendor/openzeppelin/`
- FFI is enabled
- Fork tests require `RUN_FORK_TESTS=1` and `BASE_FORK_URL` env vars
