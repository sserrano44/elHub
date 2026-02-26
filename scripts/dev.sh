#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export COREPACK_HOME="${COREPACK_HOME:-$ROOT_DIR/.corepack}"
export PNPM_HOME="${PNPM_HOME:-$ROOT_DIR/.pnpm-home}"
mkdir -p "$COREPACK_HOME" "$PNPM_HOME"
export PATH="$PNPM_HOME:$PATH"

if [[ ! -d "$ROOT_DIR/node_modules" ]]; then
  echo "Installing workspace dependencies (first run)..."
  pnpm install
fi

HUB_NETWORK="${HUB_NETWORK:-ethereum}"
HUB_RPC_PORT="${HUB_RPC_PORT:-8545}"
SPOKE_RPC_PORT="${SPOKE_RPC_PORT:-9545}"
SPOKE_NETWORKS="${SPOKE_NETWORKS:-${SPOKE_NETWORK:-base}}"

normalize_network() {
  local value
  value="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "$value" in
    ethereum|mainnet) echo "ethereum" ;;
    base) echo "base" ;;
    bsc|bnb) echo "bsc" ;;
    worldchain|world) echo "worldchain" ;;
    *)
      echo "Unsupported network=$1 (expected: ethereum, base, bsc, worldchain)" >&2
      exit 1
      ;;
  esac
}

resolve_network_meta() {
  local network="$1"
  case "$network" in
    ethereum)
      echo "ETHEREUM Ethereum 1"
      ;;
    base)
      echo "BASE Base 8453"
      ;;
    bsc)
      echo "BSC BSC 56"
      ;;
    worldchain)
      echo "WORLDCHAIN Worldchain 480"
      ;;
    *)
      echo "Unsupported network=$network" >&2
      exit 1
      ;;
  esac
}

HUB_NETWORK="$(normalize_network "$HUB_NETWORK")"
read -r HUB_ENV_PREFIX HUB_LABEL HUB_DEFAULT_CHAIN_ID <<<"$(resolve_network_meta "$HUB_NETWORK")"
HUB_CHAIN_VAR="${HUB_ENV_PREFIX}_CHAIN_ID"
HUB_CHAIN_ID="${HUB_CHAIN_ID:-${!HUB_CHAIN_VAR:-$HUB_DEFAULT_CHAIN_ID}}"

SPOKE_NETWORK="${SPOKE_NETWORKS%%,*}"
SPOKE_NETWORK="$(normalize_network "$SPOKE_NETWORK")"
read -r SPOKE_ENV_PREFIX SPOKE_LABEL SPOKE_DEFAULT_CHAIN_ID <<<"$(resolve_network_meta "$SPOKE_NETWORK")"
SPOKE_CHAIN_VAR="${SPOKE_ENV_PREFIX}_CHAIN_ID"
SPOKE_CHAIN_ID="${!SPOKE_CHAIN_VAR:-$SPOKE_DEFAULT_CHAIN_ID}"

HUB_RPC_URL="http://127.0.0.1:${HUB_RPC_PORT}"
SPOKE_RPC_URL="http://127.0.0.1:${SPOKE_RPC_PORT}"

PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
}
trap cleanup EXIT INT TERM

echo "Starting ${HUB_LABEL}-local anvil on :${HUB_RPC_PORT}"
anvil --port "$HUB_RPC_PORT" --chain-id "$HUB_CHAIN_ID" --block-time 1 >/tmp/elhub-anvil-${HUB_NETWORK}.log 2>&1 &
PIDS+=("$!")

echo "Starting ${SPOKE_LABEL}-local anvil on :${SPOKE_RPC_PORT}"
anvil --port "$SPOKE_RPC_PORT" --chain-id "$SPOKE_CHAIN_ID" --block-time 1 >/tmp/elhub-anvil-${SPOKE_NETWORK}.log 2>&1 &
PIDS+=("$!")

rpc_ready() {
  local url="$1"
  curl -sS -H "content-type: application/json" \
    --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
    "$url" >/dev/null 2>&1
}

for _ in {1..30}; do
  if rpc_ready "http://127.0.0.1:${HUB_RPC_PORT}" && rpc_ready "http://127.0.0.1:${SPOKE_RPC_PORT}"; then
    break
  fi
  sleep 1
done

export HUB_CHAIN_ID
export HUB_NETWORK
export HUB_RPC_URL
export SPOKE_NETWORK
export SPOKE_NETWORKS

export "${HUB_ENV_PREFIX}_CHAIN_ID=${HUB_CHAIN_ID}"
export "${HUB_ENV_PREFIX}_RPC_URL=${HUB_RPC_URL}"
export "${HUB_ENV_PREFIX}_TENDERLY_RPC_URL=${HUB_RPC_URL}"

export "${SPOKE_ENV_PREFIX}_CHAIN_ID=${SPOKE_CHAIN_ID}"
export "${SPOKE_ENV_PREFIX}_RPC_URL=${SPOKE_RPC_URL}"
export "${SPOKE_ENV_PREFIX}_TENDERLY_RPC_URL=${SPOKE_RPC_URL}"

echo "Deploying local contracts"
bash ./contracts/script/deploy-local.sh

if [[ ! -f ./contracts/deployments/local.env ]]; then
  echo "Missing ./contracts/deployments/local.env after deploy"
  exit 1
fi

set -a
source ./contracts/deployments/local.env
set +a

echo "Generating shared ABIs"
pnpm --filter @elhub/abis run generate

echo "Starting indexer, prover, relayer, and web"
pnpm --filter @elhub/indexer dev &
PIDS+=("$!")

pnpm --filter @elhub/prover dev &
PIDS+=("$!")

pnpm --filter @elhub/relayer dev &
PIDS+=("$!")

pnpm --filter @elhub/web dev &
PIDS+=("$!")

wait -n
