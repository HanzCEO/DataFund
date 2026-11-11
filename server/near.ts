import { Account, KeyPairSigner } from "near-api-js";
import { DAO_ID, RPC_URLS, VERIFIER_ACCOUNT, verifierPrivateKey } from "./config.js";
import { RoundRobinProvider } from "./rpc.js";
import type { BountyClaim, BountyView, ProposalView } from "../shared/types.js";

export const provider = new RoundRobinProvider(RPC_URLS);

export const view = <T>(method: string, args: Record<string, unknown> = {}) =>
  provider.callFunction(DAO_ID, method, args) as Promise<T>;

export async function getProposals(fromIndex: number, limit: number): Promise<ProposalView[]> {
  return (await view<ProposalView[]>("get_proposals", { from_index: fromIndex, limit })) ?? [];
}

export async function getRecentProposals(limit = 60): Promise<ProposalView[]> {
  const last = (await view<number>("get_last_proposal_id")) ?? 0;
  return getProposals(Math.max(0, last - limit), limit);
}

/** Every proposal, oldest first. The bounty dashboard needs the full payout history, not just recent proposals. */
export async function getAllProposals(): Promise<ProposalView[]> {
  const last = (await view<number>("get_last_proposal_id")) ?? 0;
  const pages = await Promise.all(Array.from({ length: Math.ceil(last / 100) }, (_, i) => getProposals(i * 100, 100)));
  return pages.flat();
}

export async function getBounties(): Promise<BountyView[]> {
  return (await view<BountyView[]>("get_bounties", { from_index: 0, limit: 100 })) ?? [];
}

export async function getBounty(id: number): Promise<BountyView | undefined> {
  return (await getBounties()).find((b) => b.id === id);
}

export async function getClaims(accountId: string): Promise<BountyClaim[]> {
  return (await view<BountyClaim[]>("get_bounty_claims", { account_id: accountId })) ?? [];
}

let verifier: Account | undefined;
function verifierAccount(): Account {
  verifier ??= new Account(VERIFIER_ACCOUNT, provider, KeyPairSigner.fromSecretKey(verifierPrivateKey() as never));
  return verifier;
}

/** Cast the verifier bot's vote. Passing `proposal` (the kind) guards against voting on a swapped proposal. */
export async function vote(p: ProposalView, approve: boolean): Promise<string> {
  const outcome = await verifierAccount().callFunctionRaw({
    contractId: DAO_ID,
    methodName: "act_proposal",
    args: { id: p.id, action: approve ? "VoteApprove" : "VoteReject", proposal: p.kind },
    gas: 200_000_000_000_000n,
    deposit: 0n,
  });
  return outcome.transaction_outcome.id;
}
