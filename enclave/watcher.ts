// Polls the DAO. Verifies new payout claims, votes, enforces review deadlines and releases keys after payout.
import { toB64 } from "../shared/crypto.js";
import { parseSpec } from "../shared/spec.js";
import type { ProposalView, Verdict } from "../shared/types.js";
import { confirmedStatus, finalBlock, getBounty, getRecentProposals, verifiedRequester, vote } from "./chain.js";
import { AUTO_VOTE, POLL_MS } from "./config.js";
import { pin, pinningEnabled } from "./storage.js";
import { bumpAttempt, getVerdict, putVerdict } from "./store.js";
import { aiEnabled, allowsPlaintext, fileKeyOf, parseSubmission, verify } from "./verifier.js";
import { fetchBytes } from "./storage.js";

const MAX_ATTEMPTS = 3;
const inFlight = new Set<number>();
/** Proposals being handled right now. The public server won't put the CVM to sleep while this is above zero. */
export const activeJobs = () => inFlight.size;
/** Seed block per proposal, fixed the first time the proposal is seen. A retry reuses it. */
const seeds = new Map<number, { height: number; hash: string }>();

export const bountyDone = (p: ProposalView) =>
  typeof p.kind === "object" ? (p.kind.BountyDone as { bounty_id: number; receiver_id: string } | undefined) : undefined;

export function startWatcher() {
  const tick = async () => {
    try {
      const proposals = await getRecentProposals();
      for (const p of proposals) {
        if (!bountyDone(p) || inFlight.has(p.id)) continue;
        const v = getVerdict(p.id);
        const job = p.status === "InProgress" ? (v?.voteTx ? undefined : handle(p)) : p.status === "Approved" && v?.encrypted && !v.released ? release(p, v) : undefined;
        if (!job) continue;
        inFlight.add(p.id);
        job.finally(() => inFlight.delete(p.id));
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
  const kind = bountyDone(p)!;
  let verdict = getVerdict(p.id);
  try {
    if (!verdict || (verdict.voteError && !verdict.checks.some((c) => c.ok))) {
      if (bumpAttempt(p.id) > MAX_ATTEMPTS) {
        // Leave it to the council, and say so. A sleeping enclave must not be woken for it again.
        if (verdict && !verdict.abandoned) putVerdict({ ...verdict, abandoned: true });
        return;
      }
      if (!seeds.has(p.id)) seeds.set(p.id, await finalBlock());
      const bounty = await getBounty(kind.bounty_id);
      if (!bounty) throw new Error(`Bounty ${kind.bounty_id} not found`);
      const spec = parseSpec(bounty.description);
      const ref = parseSubmission(p.description);
      const blob = ref.key ? await fetchBytes(ref) : undefined;
      const r = await verify({ bountyId: kind.bounty_id, spec, ref, plaintextAllowed: allowsPlaintext(bounty.description), seed: seeds.get(p.id), blob });
      verdict = r.verdict;
      verdict.proposalId = p.id;
      verdict.contributor = kind.receiver_id;

      // Keep the encrypted file available whatever the contributor does with their copy.
      if (blob && pinningEnabled()) {
        try {
          verdict.cid = await pin(blob, `datafund-${p.id}.enc`);
        } catch (e) {
          console.warn(`[watcher] #${p.id} pin failed (${(e as Error).message})`);
        }
      }

      // The requester only counts when they really proposed this bounty. Checked once, here.
      const needsRequester = verdict.decision === "review" || spec.access === "requester";
      const requester = needsRequester ? await verifiedRequester(bounty, spec.requester) : undefined;
      verdict.access = spec.access;
      if (spec.access === "requester") verdict.releaseTo = requester;
      if (verdict.decision === "review") {
        const deadline = new Date(Number(BigInt(p.submission_time) / 1_000_000n) + spec.reviewHours * 3_600_000).toISOString();
        verdict.review = { requester, deadline, sampleRows: r.details.sample.length };
        if (!requester) fallback(verdict, "the bounty has no verified requester");
      }
      putVerdict(verdict, r.details);
      console.log(`[watcher] #${p.id} ${kind.receiver_id} scored ${verdict.score} -> ${verdict.decision}`);
    }

    if (verdict.decision === "review") {
      if (verdict.review?.decision) verdict.decision = verdict.review.decision;
      else if (Date.now() > Date.parse(verdict.review!.deadline)) fallback(verdict, "the requester did not decide in time");
      else return; // still waiting for the requester
      putVerdict(verdict);
    }

    // If AI is configured but failed, don't auto-approve on structural checks alone. Retry next poll.
    if (verdict.aiError && verdict.decision === "approve" && !verdict.review?.decidedBy) throw new Error(`AI review failed (${verdict.aiError})`);
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
        task: "classification", mode: "auto", encrypted: false,
        checks: [{ name: "Fetch dataset", ok: false, detail: msg }], structuralScore: 0, score: 0,
        decision: "reject", reasons: [msg], createdAt: new Date().toISOString(), voteError: msg,
      });
  }
}

/** Manual review fell through. The enclave's own auto decision stands. */
function fallback(v: Verdict, why: string) {
  v.decision = v.autoDecision ?? "reject";
  v.review = { ...v.review!, fallback: true };
  v.reasons.push(`Auto review decided because ${why}`);
}

/**
 * Once two RPC providers agree the payout was approved, release the key. Public bounties publish it and the
 * dataset becomes public. Requester-only bounties keep it in the enclave and hand it to the requester on a signed
 * request (see /key).
 */
async function release(p: ProposalView, v: Verdict) {
  try {
    if ((await confirmedStatus(p.id)) !== "Approved") return;
    if (v.access === "requester") {
      if (!v.releaseTo) v.reasons.push("No verified requester. The key stays sealed in the enclave");
    } else {
      v.releasedKey = toB64(await fileKeyOf(parseSubmission(p.description)));
    }
    v.released = true;
    putVerdict(v);
    console.log(`[watcher] #${p.id} payout approved, key released ${v.access === "requester" ? `to ${v.releaseTo ?? "nobody"}` : "publicly"}`);
  } catch (e) {
    console.warn(`[watcher] #${p.id} release postponed (${(e as Error).message})`);
  }
}
