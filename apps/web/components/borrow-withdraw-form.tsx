"use client";

import { useMemo, useState } from "react";
import { parseUnits } from "viem";
import { useAccount, useSignTypedData } from "wagmi";
import { IntentType, getIntentTypedData, rawIntentId } from "@elhub/sdk";
import { useDeployments } from "../lib/runtime-config";

const RELAYER_API = process.env.NEXT_PUBLIC_RELAYER_API_URL ?? "http://127.0.0.1:3040";
const INDEXER_API = process.env.NEXT_PUBLIC_INDEXER_API_URL ?? "http://127.0.0.1:3030";

function formatIntentStatus(status: string): string {
  if (status === "pending_lock") return "Pending lock on hub...";
  if (status === "locked") return "Locked and dispatched. Waiting for spoke fill...";
  if (status === "filled") return "Fill observed. Finalizing proof...";
  if (status === "awaiting_settlement") return "Proof finalized. Awaiting settlement batch...";
  if (status === "settled") return "Settled on hub.";
  if (status === "expired_unwound") return "Fill window expired and lock was automatically unwound.";
  if (status === "failed") return "Intent failed.";
  return `Current status: ${status}`;
}

export function BorrowWithdrawForm({ mode }: { mode: "borrow" | "withdraw" }) {
  const { address, chainId } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const { config, loading } = useDeployments();

  const [asset, setAsset] = useState("USDC");
  const [amount, setAmount] = useState("25");
  const [status, setStatus] = useState<string>("");
  const [intentId, setIntentId] = useState<string>("");

  const token = useMemo(() => config?.tokens[asset], [asset, config]);

  async function submit() {
    if (!address || !config || !token) return;
    const intentInbox = config.hub.intentInbox;
    if (!intentInbox) {
      setStatus("Missing hub intent inbox in deployment config.");
      return;
    }

    const amountRaw = parseUnits(amount, token.decimals);
    const quoteRes = await fetch(`${RELAYER_API}/quote?intentType=${mode === "borrow" ? IntentType.BORROW : IntentType.WITHDRAW}&amount=${amountRaw.toString()}`);
    const quote = (await quoteRes.json()) as { fee: string };

    const nonce = BigInt(Date.now());
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 60);

    const intent = {
      intentType: mode === "borrow" ? IntentType.BORROW : IntentType.WITHDRAW,
      user: address,
      inputChainId: BigInt(chainId ?? 480),
      outputChainId: BigInt(Number(process.env.NEXT_PUBLIC_SPOKE_CHAIN_ID ?? 480)),
      inputToken: token.spoke,
      outputToken: token.spoke,
      amount: amountRaw,
      recipient: address,
      maxRelayerFee: BigInt(quote.fee),
      nonce,
      deadline
    };

    setStatus("Signing intent...");
    const signature = await signTypedDataAsync(
      getIntentTypedData(Number(process.env.NEXT_PUBLIC_HUB_CHAIN_ID ?? 8453), intentInbox, intent)
    );

    const localIntentId = rawIntentId(intent);
    setIntentId(localIntentId);

    setStatus("Locking on Base + filling on Worldchain via relayer...");
    const submitRes = await fetch(`${RELAYER_API}/intent/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intent: {
          ...intent,
          inputChainId: intent.inputChainId.toString(),
          outputChainId: intent.outputChainId.toString(),
          amount: intent.amount.toString(),
          maxRelayerFee: intent.maxRelayerFee.toString(),
          nonce: intent.nonce.toString(),
          deadline: intent.deadline.toString()
        },
        signature,
        relayerFee: quote.fee
      })
    });

    if (!submitRes.ok) {
      setStatus(`Relayer failed: ${await submitRes.text()}`);
      return;
    }

    setStatus("Locked and dispatched. Waiting for fill...");
  }

  async function refreshStatus() {
    if (!intentId) return;
    const res = await fetch(`${INDEXER_API}/intents/${intentId}`);
    if (!res.ok) {
      setStatus("No indexer status yet");
      return;
    }
    const data = (await res.json()) as { status: string };
    setStatus(formatIntentStatus(data.status));
  }

  if (!address) return <p className="muted">Connect wallet first.</p>;
  if (loading || !config) return <p className="muted">Loading deployment config...</p>;

  return (
    <div className="card stack">
      <label>
        Asset
        <select value={asset} onChange={(e) => setAsset(e.target.value)}>
          {Object.keys(config.tokens).map((symbol) => (
            <option key={symbol} value={symbol}>{symbol}</option>
          ))}
        </select>
      </label>
      <label>
        Amount
        <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0" />
      </label>
      <button className="btn" onClick={submit}>
        {mode === "borrow" ? "Borrow To Worldchain" : "Withdraw To Worldchain"}
      </button>
      {intentId ? (
        <button className="btn btn-ghost" onClick={refreshStatus}>
          Refresh Intent Status
        </button>
      ) : null}
      {status ? <p className="muted">{status}</p> : null}
    </div>
  );
}
