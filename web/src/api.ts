import type { Attestation, BountyView, DatasetSpec, ProposalView, Verdict } from "../../shared/types";

export type Config = {
  daoId: string;
  network: string;
  explorer: string;
  /** The enclave's NEAR account (implicit, hex). */
  verifier: string;
  enclaveMode: "tee" | "dev" | "offline";
  aiEnabled: boolean;
  model: string;
  minScore: number;
  /** Whether the enclave can hand out IPFS upload URLs. */
  pinning: boolean;
  maxBytes: number;
  /** Scale to zero is on. The enclave CVM sleeps when idle and wakes on demand. */
  scaling: boolean;
};
export type Bounty = BountyView & { claims: number; spec: Required<DatasetSpec> | null };
export type State = {
  available: string;
  total: string;
  council: string[];
  verifiers: string[];
  bountyBond: string;
  proposalBond: string;
  bounties: Bounty[];
  proposals: ProposalView[];
  verdicts: Record<string, Verdict>;
  enclave: "awake" | "asleep" | "waking" | "stopping" | "unknown";
};
export type RunFn = (label: string, f: () => Promise<unknown>) => Promise<void>;
export type { Attestation };

export const api = async <T,>(path: string, body?: unknown): Promise<T> => {
  const res = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
};

/** Start the enclave CVM ahead of a request that will need it. Fire and forget. */
export const warmUp = () => void fetch("/api/wake", { method: "POST" }).catch(() => undefined);
