// The public server. Chain reads, the web UI and a relay to the enclave. It holds no keys and no datasets.
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { existsSync } from "node:fs";
import { parseSpec } from "../shared/spec.js";
import { DAO_ID, ENCLAVE_URL, EXPLORER, NETWORK, PORT, PUBLIC_URL } from "./config.js";
import { cachedAttestation, cachedStatus, cachedVerdicts, getPhase, scale, scalingEnabled, touch, wake } from "./scaler.js";
import { getAllProposals, getBounties, getClaims, getRecentProposals, provider, view } from "./near.js";
import { knownAccounts, rememberAccount } from "./store.js";

const app = new Hono();

app.onError((e, c) => c.json({ error: e.message }, 400));

// Keep the enclave's public data fresh and make scaling decisions. Every browser reads the cached copy.
const POLL_MS = 8000;
async function poll() {
  try {
    const [proposals, policy] = await Promise.all([getRecentProposals(), view<any>("get_policy")]);
    await scale(proposals, Number(BigInt(policy.proposal_period) / 1_000_000n));
  } catch (e) {
    console.warn(`[server] poll failed (${(e as Error).message})`);
  }
  setTimeout(poll, POLL_MS);
}
poll();

app.get("/api/config", (c) => {
  const s = cachedStatus() as any;
  return c.json({
    daoId: DAO_ID, network: NETWORK, explorer: EXPLORER, verifier: s?.accountId ?? "", enclaveMode: s?.mode ?? "offline",
    aiEnabled: Boolean(s?.aiEnabled), model: s?.model ?? "", minScore: s?.minScore ?? 70, pinning: Boolean(s?.pinning), maxBytes: s?.maxBytes ?? 0,
    scaling: scalingEnabled(),
  });
});

// Cache chain reads briefly. Every open browser polls this, and public RPCs rate-limit.
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
  const v = cachedVerdicts();
  const claims = await Promise.all(bounties.map((b) => view<number>("get_bounty_number_of_claims", { id: b.id })));
  const body = {
    available,
    total: account.amount.toString(),
    council: policy.roles.find((r: any) => r.name === "council")?.kind?.Group ?? [],
    verifiers: policy.roles.find((r: any) => r.name === "verifier")?.kind?.Group ?? [],
    bountyBond: policy.bounty_bond,
    proposalBond: policy.proposal_bond,
    bounties: bounties.map((b, i) => ({ ...b, claims: claims[i] ?? 0, spec: safe(() => parseSpec(b.description)) })),
    proposals: proposals.reverse(),
    verdicts: v,
    enclave: getPhase(),
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

  const v = cachedVerdicts();
  const body = {
    bounty: bounty ? { ...bounty, claims: await view<number>("get_bounty_number_of_claims", { id }), spec: safe(() => parseSpec(bounty.description)) } : null,
    claims,
    submissions: submissions.reverse().map((p) => ({ proposal: p, verdict: v[p.id] ?? null })),
    checkedAccounts: candidates.size,
  };
  bountyCache.set(id, { at: Date.now(), body });
  return c.json(body);
});

/** The DAO's config, full policy and every proposal, newest first. Backs the DAO and council pages. */
let daoCache: { at: number; body: unknown } | undefined;
app.get("/api/dao", async (c) => {
  if (daoCache && Date.now() - daoCache.at < 6000) return c.json(daoCache.body as object);
  const [config, policy, proposals] = await Promise.all([view<any>("get_config"), view<any>("get_policy"), getAllProposals()]);
  const body = { config, policy, proposals: proposals.reverse(), verdicts: cachedVerdicts() };
  daoCache = { at: Date.now(), body };
  return c.json(body);
});

/**
 * Relay to the enclave. Everything private in these calls is encrypted end to end between the browser and the
 * enclave (sealed file keys in, sealed answers out). Relaying here reveals nothing. A sleeping enclave is woken
 * first, which takes about a minute. Attestation and status come from the cache while it sleeps.
 */
const RELAY = new Set(["attestation", "status", "upload-url", "precheck", "review", "review/decide", "key"]);
app.all("/api/enclave/*", async (c) => {
  const path = c.req.path.slice("/api/enclave/".length);
  if (!RELAY.has(path)) return c.notFound();
  if (getPhase() !== "awake") {
    if (path === "attestation" && cachedAttestation()) return c.json(cachedAttestation()!);
    if (path === "status" && cachedStatus()) return c.json({ ...cachedStatus(), asleep: true });
  }
  await wake();
  const res = await fetch(`${ENCLAVE_URL}/${path}`, {
    method: c.req.method,
    headers: { "content-type": "application/json", "x-forwarded-for": c.req.header("x-forwarded-for") ?? "local" },
    body: c.req.method === "GET" ? undefined : await c.req.text(),
    signal: AbortSignal.timeout(300_000),
  });
  touch();
  return new Response(res.body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
});

/** Wake the enclave ahead of time, for example when someone opens the submit form. */
app.post("/api/wake", (c) => {
  wake().catch((e) => console.warn(`[scaler] wake failed (${(e as Error).message})`));
  return c.json({ enclave: getPhase() });
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

serve({ fetch: app.fetch, port: PORT }, () =>
  console.log(`[server] ${PUBLIC_URL} (DAO ${DAO_ID} on ${NETWORK}, enclave ${ENCLAVE_URL}, scale to zero ${scalingEnabled() ? "on" : "off"})`),
);
