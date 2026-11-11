// Chain reads and the enclave's own votes.
import { Account, KeyPairSigner, providers } from "near-api-js";
import { RoundRobinProvider } from "../shared/rpc.js";
import type { BountyView, ProposalView } from "../shared/types.js";
import { DAO_ID, RPC_URLS } from "./config.js";
import { getKeys } from "./keys.js";

export const provider = new RoundRobinProvider(RPC_URLS);

export const view = <T>(method: string, args: Record<string, unknown> = {}) =>
  provider.callFunction(DAO_ID, method, args) as Promise<T>;

export async function getRecentProposals(limit = 60): Promise<ProposalView[]> {
  const last = (await view<number>("get_last_proposal_id")) ?? 0;
  return (await view<ProposalView[]>("get_proposals", { from_index: Math.max(0, last - limit), limit })) ?? [];
}

export async function getAllProposals(): Promise<ProposalView[]> {
  const last = (await view<number>("get_last_proposal_id")) ?? 0;
  const pages = await Promise.all(
    Array.from({ length: Math.ceil(last / 100) }, (_, i) => view<ProposalView[]>("get_proposals", { from_index: i * 100, limit: 100 })),
  );
  return pages.flat().filter(Boolean);
}

export async function getProposal(id: number): Promise<ProposalView> {
  return view<ProposalView>("get_proposal", { id });
}

export async function getBounty(id: number): Promise<BountyView | undefined> {
  return view<BountyView>("get_bounty", { id }).catch(() => undefined);
}

/** Latest final block. Its hash seeds the sample, and nobody can know it when they submit. */
export async function finalBlock(): Promise<{ height: number; hash: string }> {
  const b = await provider.block({ finality: "final" });
  return { height: b.header.height, hash: b.header.hash };
}

/**
 * Proposal status confirmed by two different RPC providers. A key is released on this answer. One lying or
 * stale node can't trigger a release on its own.
 */
export async function confirmedStatus(id: number): Promise<string> {
  const seen: string[] = [];
  for (const url of RPC_URLS) {
    try {
      const p = new providers.JsonRpcProvider({ url }, { retries: 1 });
      const r = (await p.callFunction(DAO_ID, "get_proposal", { id })) as ProposalView;
      seen.push(r.status);
      if (seen.length === 2) break;
    } catch {
      // try the next provider
    }
  }
  if (seen.length < 2) throw new Error("Could not reach two RPC providers");
  if (seen[0] !== seen[1]) throw new Error(`RPC providers disagree on proposal ${id} (${seen.join(" vs ")})`);
  return seen[0];
}

/** Whether a public key is a full-access key of an account. Used to check NEP-413 signatures. */
export async function isFullAccessKey(accountId: string, publicKey: string): Promise<boolean> {
  try {
    const r = (await provider.query({ request_type: "view_access_key", account_id: accountId, public_key: publicKey, finality: "final" })) as any;
    return r.permission === "FullAccess";
  } catch {
    return false;
  }
}

/**
 * The account that proposed a bounty. The spec names a requester, and it only counts when an approved AddBounty
 * proposal with the same description came from that account.
 */
export async function verifiedRequester(bounty: BountyView, claimed: string): Promise<string | undefined> {
  if (!claimed) return undefined;
  const all = await getAllProposals();
  const match = all.find(
    (p) => p.status === "Approved" && p.proposer === claimed && typeof p.kind === "object" && p.kind.AddBounty?.bounty?.description === bounty.description,
  );
  return match ? claimed : undefined;
}

let account: Account | undefined;
function me(): Account {
  const k = getKeys();
  account ??= new Account(k.accountId, provider, KeyPairSigner.fromSecretKey(k.nearSecretKey as never));
  return account;
}

/** Cast the enclave's vote. Passing `proposal` (the kind) guards against voting on a swapped proposal. */
export async function vote(p: ProposalView, approve: boolean): Promise<string> {
  const outcome = await me().callFunctionRaw({
    contractId: DAO_ID,
    methodName: "act_proposal",
    args: { id: p.id, action: approve ? "VoteApprove" : "VoteReject", proposal: p.kind },
    gas: 200_000_000_000_000n,
    deposit: 0n,
  });
  return outcome.transaction_outcome.id;
}

export async function balance(): Promise<string> {
  try {
    return (await provider.viewAccount(getKeys().accountId)).amount.toString();
  } catch {
    return "0";
  }
}
