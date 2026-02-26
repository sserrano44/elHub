#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CIRCUIT_PATH="$ROOT_DIR/circuits/circom/SettlementBatchRoot.circom"
OUT_DIR="$ROOT_DIR/circuits/prover/artifacts"

if ! command -v circom >/dev/null 2>&1; then
  echo "circom not found in PATH"
  exit 1
fi

if ! command -v snarkjs >/dev/null 2>&1; then
  echo "snarkjs not found in PATH"
  exit 1
fi

mkdir -p "$OUT_DIR"

echo "[zk] compiling circuit"
circom "$CIRCUIT_PATH" --r1cs --wasm --sym -o "$OUT_DIR"

R1CS_PATH="$OUT_DIR/SettlementBatchRoot.r1cs"
WASM_DIR="$OUT_DIR/SettlementBatchRoot_js"
ZKEY_0="$OUT_DIR/SettlementBatchRoot_0000.zkey"
ZKEY_FINAL="$OUT_DIR/SettlementBatchRoot_final.zkey"
VK_PATH="$OUT_DIR/verification_key.json"
SOLIDITY_VERIFIER_PATH="$OUT_DIR/Groth16Verifier.generated.sol"

PTAU_POWER="${PTAU_POWER:-15}"
if ! [[ "$PTAU_POWER" =~ ^[0-9]+$ ]]; then
  echo "[zk] invalid PTAU_POWER=$PTAU_POWER (expected integer)"
  exit 1
fi
PTAU_BASENAME="pot${PTAU_POWER}"
PTAU_PATH="${PTAU_PATH:-$OUT_DIR/${PTAU_BASENAME}_final.ptau}"
PTAU_0000="$OUT_DIR/${PTAU_BASENAME}_0000.ptau"
PTAU_BEACON="$OUT_DIR/${PTAU_BASENAME}_beacon.ptau"

if [[ ! -f "$PTAU_PATH" ]]; then
  echo "[zk] no PTAU found, generating local test PTAU power=$PTAU_POWER ($PTAU_PATH)"
  snarkjs powersoftau new bn128 "$PTAU_POWER" "$PTAU_0000" -v
  # Keep artifact generation non-interactive across snarkjs versions.
  # Older versions (e.g. 0.7.x) do not support non-interactive contribute flags.
  PTAU_BEACON_HASH="${PTAU_BEACON_HASH:-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef}"
  PTAU_BEACON_EXP="${PTAU_BEACON_EXP:-10}"
  snarkjs powersoftau beacon "$PTAU_0000" "$PTAU_BEACON" "$PTAU_BEACON_HASH" "$PTAU_BEACON_EXP"
  snarkjs powersoftau prepare phase2 "$PTAU_BEACON" "$PTAU_PATH"
fi

echo "[zk] running groth16 setup"
rm -f "$ZKEY_0" "$ZKEY_FINAL" "$VK_PATH" "$SOLIDITY_VERIFIER_PATH"
if ! snarkjs groth16 setup "$R1CS_PATH" "$PTAU_PATH" "$ZKEY_0"; then
  echo "[zk] groth16 setup failed; ensure PTAU power is large enough (try PTAU_POWER=16)"
  exit 1
fi
ZKEY_BEACON_HASH="${ZKEY_BEACON_HASH:-abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789}"
ZKEY_BEACON_EXP="${ZKEY_BEACON_EXP:-10}"
snarkjs zkey beacon "$ZKEY_0" "$ZKEY_FINAL" "$ZKEY_BEACON_HASH" "$ZKEY_BEACON_EXP"
snarkjs zkey export verificationkey "$ZKEY_FINAL" "$VK_PATH"
snarkjs zkey export solidityverifier "$ZKEY_FINAL" "$SOLIDITY_VERIFIER_PATH"

echo "[zk] artifacts ready"
echo "  - $R1CS_PATH"
echo "  - $WASM_DIR/SettlementBatchRoot.wasm"
echo "  - $ZKEY_FINAL"
echo "  - $VK_PATH"
echo "  - $SOLIDITY_VERIFIER_PATH"
