import { computeActionsRoot, hashPair, toField } from "./hash";
const SYNTHETIC_ACTION_DEPOSIT_ID = 1n;
const SYNTHETIC_ACTION_USER = "0x000000000000000000000000000000000000dEaD";
const SYNTHETIC_ACTION_ASSET = "0x0000000000000000000000000000000000000001";
export function buildDepositProofBatch(witness) {
    const batchId = toField(witness.sourceChainId);
    const hubChainId = toField(witness.depositId);
    const spokeChainId = hashPair(toField(BigInt(witness.intentType)), toField(BigInt(witness.user)));
    const commitment = witnessCommitment(witness);
    const draft = {
        batchId,
        hubChainId,
        spokeChainId,
        supplyCredits: [
            {
                depositId: SYNTHETIC_ACTION_DEPOSIT_ID,
                user: SYNTHETIC_ACTION_USER,
                hubAsset: SYNTHETIC_ACTION_ASSET,
                amount: commitment
            }
        ],
        repayCredits: [],
        borrowFinalizations: [],
        withdrawFinalizations: []
    };
    return {
        ...draft,
        actionsRoot: computeActionsRoot(draft)
    };
}
function witnessCommitment(witness) {
    let state = hashPair(toField(witness.sourceChainId), toField(witness.depositId));
    state = hashPair(state, toField(BigInt(witness.intentType)));
    state = hashPair(state, toField(BigInt(witness.user)));
    state = hashPair(state, toField(BigInt(witness.hubAsset)));
    state = hashPair(state, toField(witness.amount));
    state = hashPair(state, toField(BigInt(witness.sourceTxHash)));
    state = hashPair(state, toField(witness.sourceLogIndex));
    state = hashPair(state, toField(BigInt(witness.messageHash)));
    return state;
}
//# sourceMappingURL=deposit-proof.js.map