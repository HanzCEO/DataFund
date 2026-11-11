import { AUTO_VOTE, POLL_MS } from "./config.js";
import { getBounty, getRecentProposals, vote } from "./near.js";
import { bumpAttempt, getVerdict, putVerdict } from "./store.js";
import { aiEnabled, parseSpec, parseSubmission, verify } from "./verifier.js";
import type { ProposalView } from "../shared/types.js";

const MAX_ATTEMPTS = 3;
const inFlight = new Set<number>();

/** Poll the DAO for BountyDone proposals, verify the dataset, and cast the verifier bot's vote. */
export function startWatcher() {
  const tick = async () => {
    try {
      const proposals = await getRecentProposals();
      for (const p of proposals) {
        if (typeof p.kind !== "object" || !("BountyDone" in p.kind)) continue;
        if (p.status !== "InProgress" || inFlight.has(p.id)) continue;
        const existing = getVerdict(p.id);
        if (existing?.voteTx) continue;
        inFlight.add(p.id);
        handle(p).finally(() => inFlight.delete(p.id));
      }
    } catch (e) {
      console.error(`[watcher] poll failed (${(e as Error).message})`);
    }
  };
  tick();
  setInterval(tick, POLL_MS);
  console.log(`[watcher] polling every ${POLL_MS / 1000}s, auto-vote ${AUTO_VOTE ? "on" : "off"}, AI ${aiEnabled() ? "on" : "off (structural checks only)"}`);
}

async function handle(p: ProposalView) {
  const kind = (p.kind as any).BountyDone as { bounty_id: number; receiver_id: string };
  let verdict = getVerdict(p.id);
  try {
    if (!verdict || verdict.voteError) {
      if (bumpAttempt(p.id) > MAX_ATTEMPTS) return; // leave it to the council
      const bounty = await getBounty(kind.bounty_id);
      if (!bounty) throw new Error(`Bounty ${kind.bounty_id} not found`);
      verdict = await verify(kind.bounty_id, parseSpec(bounty.description), parseSubmission(p.description));
      verdict.proposalId = p.id;
      verdict.contributor = kind.receiver_id;
      putVerdict(verdict);
      console.log(`[watcher] #${p.id} ${kind.receiver_id} scored ${verdict.score} -> ${verdict.decision}`);
    }
    // If AI is configured but failed, don't auto-reject on structural checks alone. Retry next poll.
    if (verdict.aiError && verdict.decision === "approve") throw new Error(`AI review failed (${verdict.aiError})`);
    if (!AUTO_VOTE) return;
    verdict.voteTx = await vote(p, verdict.decision === "approve");
    delete verdict.voteError;
    putVerdict(verdict);
    console.log(`[watcher] #${p.id} voted ${verdict.decision} in ${verdict.voteTx}`);
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`[watcher] #${p.id} failed (${msg})`);
    if (verdict) putVerdict({ ...verdict, voteError: msg });
    else
      putVerdict({
        proposalId: p.id, bountyId: kind.bounty_id, contributor: kind.receiver_id, url: "", sha256: "", rows: 0,
        checks: [{ name: "Fetch dataset", ok: false, detail: msg }], structuralScore: 0, score: 0,
        decision: "reject", reasons: [msg], createdAt: new Date().toISOString(), voteError: msg,
      });
  }
}
