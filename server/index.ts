import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { DAO_ID, EXPLORER, MIN_SCORE, NEAR_AI_MODEL, NETWORK, PORT, PUBLIC_URL, VERIFIER_ACCOUNT } from "./config.js";
import { MAX_BYTES, sha256 } from "./dataset.js";
import { getAllProposals, getBounties, getClaims, getRecentProposals, provider, view } from "./near.js";
import { allVerdicts, knownAccounts, rememberAccount, uploadPath } from "./store.js";
import { aiEnabled, parseSpec, verify } from "./verifier.js";
import { startWatcher } from "./watcher.js";

const app = new Hono();

app.onError((e, c) => c.json({ error: e.message }, 400));

app.get("/api/config", (c) =>
  c.json({ daoId: DAO_ID, network: NETWORK, explorer: EXPLORER, verifier: VERIFIER_ACCOUNT, aiEnabled: aiEnabled(), model: NEAR_AI_MODEL, minScore: MIN_SCORE }),
);

// Cache chain reads briefly: every open browser polls this, and public RPCs rate-limit.
let cached: { at: number; body: unknown } | undefined;
app.get("/api/state", async (c) => {
  if (cached && Date.now() - cached.at < 4000) return c.json(cached.body as object);
  const [bounties, proposals, available, policy, account] = await Promise.all([
    getBounties(),
    getRecentProposals(),
    view<string>("get_available_amount"),
    view<any>("get_policy"),
    provider.viewAccount(DAO_ID),
  ]);
  const claims = await Promise.all(bounties.map((b) => view<number>("get_bounty_number_of_claims", { id: b.id })));
  const body = {
    available,
    total: account.amount.toString(),
    council: policy.roles.find((r: any) => r.name === "council")?.kind?.Group ?? [],
    bountyBond: policy.bounty_bond,
    proposalBond: policy.proposal_bond,
    bounties: bounties.map((b, i) => ({ ...b, claims: claims[i] ?? 0, spec: safe(() => parseSpec(b.description)) })),
    proposals: proposals.reverse(),
    verdicts: allVerdicts(),
  };
  cached = { at: Date.now(), body };
  return c.json(body);
});

const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

app.get("/api/claims/:account", async (c) => {
  const account = c.req.param("account");
  if (!ACCOUNT_RE.test(account) || account.length > 64) throw new Error("Invalid account id");
  const claims = await getClaims(account);
  rememberAccount(account);
  return c.json(claims);
});

/**
 * One bounty with its participants. The contract only answers "what did account X claim". This endpoint asks that
 * for every account the app has seen (connected wallets, proposers, payout receivers and the council).
 */
const bountyCache = new Map<number, { at: number; body: unknown }>();
app.get("/api/bounties/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 0) throw new Error("Invalid bounty id");
  const hit = bountyCache.get(id);
  if (hit && Date.now() - hit.at < 8000) return c.json(hit.body as object);

  const [bounties, proposals, policy] = await Promise.all([getBounties(), getAllProposals(), view<any>("get_policy")]);
  const bounty = bounties.find((b) => b.id === id);
  const submissions = proposals.filter((p) => typeof p.kind === "object" && p.kind.BountyDone?.bounty_id === id);
  if (!bounty && !submissions.length) return c.json({ error: "Bounty not found" }, 404);

  const council: string[] = policy.roles.find((r: any) => r.name === "council")?.kind?.Group ?? [];
  const candidates = new Set<string>([
    ...knownAccounts(),
    ...council,
    ...proposals.map((p) => p.proposer),
    ...submissions.map((p) => (p.kind as any).BountyDone.receiver_id as string),
  ]);
  const claims = (
    await Promise.all(
      [...candidates].map(async (account) => {
        const mine = await getClaims(account).catch(() => []);
        return mine.filter((cl) => cl.bounty_id === id).map((cl) => ({ account, ...cl }));
      }),
    )
  ).flat();

  const verdicts = allVerdicts();
  const body = {
    bounty: bounty ? { ...bounty, claims: await view<number>("get_bounty_number_of_claims", { id }), spec: safe(() => parseSpec(bounty.description)) } : null,
    claims,
    submissions: submissions.reverse().map((p) => ({ proposal: p, verdict: verdicts[p.id] ?? null })),
    checkedAccounts: candidates.size,
  };
  bountyCache.set(id, { at: Date.now(), body });
  return c.json(body);
});

/** Simple off-chain storage for contributors without their own hosting. Files are content-addressed. */
app.post("/api/upload", async (c) => {
  const { content, format } = await c.req.json<{ content: string; format: "jsonl" | "csv" }>();
  if (typeof content !== "string" || !content.trim()) throw new Error("Empty dataset");
  if (Buffer.byteLength(content) > MAX_BYTES) throw new Error("Dataset larger than 2 MB");
  if (format !== "jsonl" && format !== "csv") throw new Error("format must be jsonl or csv");
  const hash = sha256(content);
  const name = `${hash}.${format}`;
  if (!existsSync(uploadPath(name))) await writeFile(uploadPath(name), content);
  return c.json({ url: `${PUBLIC_URL}/api/files/${name}`, sha256: hash });
});

app.get("/api/files/:name", async (c) => {
  const name = c.req.param("name");
  if (!/^[a-f0-9]{64}\.(jsonl|csv)$/.test(name)) return c.notFound();
  try {
    return c.body(await readFile(uploadPath(name), "utf8"), 200, { "content-type": "text/plain; charset=utf-8" });
  } catch {
    return c.notFound();
  }
});

/** Dry-run the verifier before submitting on-chain (no vote). Lightly rate-limited: it can spend AI credits. */
const hits = new Map<string, number[]>();
app.post("/api/precheck", async (c) => {
  const ip = c.req.header("x-forwarded-for") ?? "local";
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= 6) return c.json({ error: "Too many prechecks, wait a minute" }, 429);
  hits.set(ip, [...recent, now]);

  const { bountyId, url, sha256: claimed } = await c.req.json<{ bountyId: number; url: string; sha256?: string }>();
  const bounty = (await getBounties()).find((b) => b.id === Number(bountyId));
  if (!bounty) throw new Error("Bounty not found");
  return c.json(await verify(bounty.id, parseSpec(bounty.description), { url, sha256: claimed ?? "" }));
});

if (existsSync("dist")) {
  app.use("/*", serveStatic({ root: "./dist" }));
  app.get("*", serveStatic({ path: "./dist/index.html" }));
}

function safe<T>(f: () => T): T | null {
  try {
    return f();
  } catch {
    return null;
  }
}

serve({ fetch: app.fetch, port: PORT }, () => console.log(`[server] ${PUBLIC_URL} (DAO ${DAO_ID} on ${NETWORK})`));
startWatcher();
