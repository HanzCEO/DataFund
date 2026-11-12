// The enclave service. Runs inside a Phala dstack CVM (Intel TDX). It alone can decrypt submissions and vote as the verifier.
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { fromB64, sealJson, toB64 } from "../shared/crypto.js";
import { parseSpec } from "../shared/spec.js";
import type { SignedRequest, VerdictDetails } from "../shared/types.js";
import { balance, getBounty, getProposal } from "./chain.js";
import { DAO_ID, MAX_BYTES, MIN_SCORE, NEAR_AI_MODEL, NETWORK, PORT } from "./config.js";
import { attestation, initKeys } from "./keys.js";
import { verifySigned } from "./nep413.js";
import { pinningEnabled, signedUploadUrl } from "./storage.js";
import { allVerdicts, getDetails, getVerdict, putVerdict } from "./store.js";
import { aiEnabled, allowsPlaintext, fileKeyOf, parseSubmission, verify } from "./verifier.js";
import { activeJobs, startWatcher } from "./watcher.js";

const keys = await initKeys();
const app = new Hono();
app.onError((e, c) => c.json({ error: e.message }, 400));

// Requests in progress (besides /status itself). Part of the busy count the public server checks before sleep.
let activeRequests = 0;
app.use(async (c, next) => {
  if (c.req.path === "/status") return next();
  activeRequests++;
  try {
    await next();
  } finally {
    activeRequests--;
  }
});

app.get("/attestation", async (c) => c.json(await attestation()));

app.get("/status", async (c) =>
  c.json({
    mode: keys.mode, accountId: keys.accountId, balance: await balance(), dao: DAO_ID, network: NETWORK,
    aiEnabled: aiEnabled(), model: NEAR_AI_MODEL, minScore: MIN_SCORE, pinning: pinningEnabled(), maxBytes: MAX_BYTES,
    busy: activeJobs() + activeRequests,
  }),
);

app.get("/verdicts", (c) => c.json(allVerdicts()));

/** Simple per-client rate limit. Prechecks spend AI credits and upload URLs spend Pinata quota. */
const hits = new Map<string, number[]>();
function limit(key: string, max: number) {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= max) throw new Error("Too many requests, wait a minute");
  hits.set(key, [...recent, now]);
}
const client = (c: { req: { header: (k: string) => string | undefined } }) => c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? "local";

app.post("/upload-url", async (c) => {
  limit(`up:${client(c)}`, 10);
  return c.json({ url: await signedUploadUrl() });
});

const replyKeyOf = (b64: string) => {
  const k = fromB64(b64 ?? "");
  if (k.length !== 32) throw new Error("replyKey must be a 32-byte x25519 public key");
  return k;
};

/**
 * Dry run on an encrypted upload (no vote). The answer is sealed to a one-time key from the browser. Whoever
 * relays this request (the public server, a gateway) only ever sees ciphertext.
 */
app.post("/precheck", async (c) => {
  limit(`pre:${client(c)}`, 6);
  const body = await c.req.json<{ bountyId: number; blob: string; key: string; sha256: string; replyKey: string }>();
  const reply = replyKeyOf(body.replyKey);
  const blob = fromB64(body.blob ?? "");
  if (blob.length > MAX_BYTES + 64) throw new Error("Dataset too large");
  const bounty = await getBounty(Number(body.bountyId));
  if (!bounty) throw new Error("Bounty not found");
  const r = await verify({
    bountyId: bounty.id, spec: parseSpec(bounty.description), plaintextAllowed: allowsPlaintext(bounty.description),
    ref: { v: 1, sha256: String(body.sha256 ?? ""), key: body.key }, blob, precheck: true,
  });
  return c.json({ sealed: await sealJson(reply, r) });
});

/**
 * Private view of one submission. The requester sees only the review sample and the AI notes on those rows.
 * The contributor sees the AI notes on every checked row of their own file.
 */
app.post("/review", async (c) => {
  const body = await c.req.json<{ request: SignedRequest; replyKey: string }>();
  const reply = replyKeyOf(body.replyKey);
  const m = await verifySigned(body.request);
  if (m.action !== "view") throw new Error("Expected a view request");
  const v = getVerdict(m.proposalId);
  const d = getDetails(m.proposalId);
  if (!v || !d) throw new Error("No verdict for this proposal yet");
  const who = body.request.accountId;
  let out: VerdictDetails & { role: string };
  if (who === v.review?.requester) {
    const shown = new Set(d.sample.map((s) => s.row));
    out = { role: "requester", sample: d.sample, judgements: d.judgements.filter((j) => shown.has(j.row)) };
  } else if (who === v.contributor) {
    out = { role: "contributor", sample: [], judgements: d.judgements };
  } else {
    throw new Error("Only the bounty's requester or the contributor can see this submission");
  }
  return c.json({ sealed: await sealJson(reply, out) });
});

app.post("/review/decide", async (c) => {
  const { request } = await c.req.json<{ request: SignedRequest }>();
  const m = await verifySigned(request);
  if (m.action !== "approve" && m.action !== "reject") throw new Error("Expected approve or reject");
  const v = getVerdict(m.proposalId);
  if (!v || v.decision !== "review" || !v.review) throw new Error("This submission is not waiting for review");
  if (request.accountId !== v.review.requester) throw new Error("Only the bounty's requester can decide");
  if (Date.now() > Date.parse(v.review.deadline)) throw new Error("The review deadline has passed");
  v.review = { ...v.review, decision: m.action, decidedBy: request.accountId, decidedAt: new Date().toISOString() };
  v.reasons.push(`Requester ${request.accountId} chose to ${m.action} after reviewing ${v.review.sampleRows} rows`);
  putVerdict(v);
  return c.json(v);
});

/**
 * The file key of a paid submission, sealed to the caller's one-time key. For requester-only bounties only the
 * verified requester gets it. Public bounties publish the key in the verdict, and this works for anyone.
 */
app.post("/key", async (c) => {
  const body = await c.req.json<{ request: SignedRequest; replyKey: string }>();
  const reply = replyKeyOf(body.replyKey);
  const m = await verifySigned(body.request);
  if (m.action !== "key") throw new Error("Expected a key request");
  const v = getVerdict(m.proposalId);
  if (!v?.released) throw new Error("This submission has not been paid out yet");
  if (v.access === "requester" && body.request.accountId !== v.releaseTo) throw new Error("Only the bounty's requester can download this dataset");
  const key = toB64(await fileKeyOf(parseSubmission((await getProposal(m.proposalId)).description)));
  return c.json({ sealed: await sealJson(reply, { key }) });
});

serve({ fetch: app.fetch, port: PORT }, () => console.log(`[enclave] :${PORT} as ${keys.accountId} (${keys.mode}), DAO ${DAO_ID}`));
startWatcher();
