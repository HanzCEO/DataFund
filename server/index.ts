// The public server. Chain reads, the web UI and a relay to the enclave. It holds no keys and no datasets.
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { existsSync } from "node:fs";
import { parseSpec } from "../shared/spec.js";
import type { Verdict } from "../shared/types.js";
import { DAO_ID, ENCLAVE_URL, EXPLORER, NETWORK, PORT, PUBLIC_URL } from "./config.js";
import { getAllProposals, getBounties, getClaims, getRecentProposals, provider, view } from "./near.js";
import { knownAccounts, rememberAccount } from "./store.js";

const app = new Hono();

app.onError((e, c) => c.json({ error: e.message }, 400));

const enclave = async <T>(path: string): Promise<T> => {
  const res = await fetch(`${ENCLAVE_URL}${path}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Enclave answered HTTP ${res.status}`);
  return res.json() as Promise<T>;
};

// Verdicts are public data from the enclave. Cache them so every browser poll doesn't hit it.
let verdictCache: { at: number; body: Record<string, Verdict> } = { at: 0, body: {} };
async function verdicts(): Promise<Record<string, Verdict>> {
  if (Date.now() - verdictCache.at < 3000) return verdictCache.body;
  try {
    verdictCache = { at: Date.now(), body: await enclave("/verdicts") };
  } catch (e) {
    console.warn(`[server] enclave unreachable (${(e as Error).message})`);
  }
  return verdictCache.body;
}

app.get("/api/config", async (c) => {
  const s = await enclave<any>("/status").catch(() => null);
  return c.json({
    daoId: DAO_ID, network: NETWORK, explorer: EXPLORER, verifier: s?.accountId ?? "", enclaveMode: s?.mode ?? "offline",
    aiEnabled: Boolean(s?.aiEnabled), model: s?.model ?? "", minScore: s?.minScore ?? 70, pinning: Boolean(s?.pinning), maxBytes: s?.maxBytes ?? 0,
  });
});

// Cache chain reads briefly. Every open browser polls this, and public RPCs rate-limit.
let cached: { at: number; body: unknown } | undefined;
app.get("/api/state", async (c) => {
  if (cached && Date.now() - cached.at < 4000) return c.json(cached.body as object);
  const [bounties, proposals, available, policy, account, v] = await Promise.all([
    getBounties(),
    getRecentProposals(),
    view<string>("get_available_amount"),
    view<any>("get_policy"),
    provider.viewAccount(DAO_ID),
    verdicts(),
  ]);
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

  const v = await verdicts();
  const body = {
    bounty: bounty ? { ...bounty, claims: await view<number>("get_bounty_number_of_claims", { id }), spec: safe(() => parseSpec(bounty.description)) } : null,
    claims,
    submissions: submissions.reverse().map((p) => ({ proposal: p, verdict: v[p.id] ?? null })),
    checkedAccounts: candidates.size,
  };
  bountyCache.set(id, { at: Date.now(), body });
  return c.json(body);
});

/**
 * Relay to the enclave. Everything private in these calls is encrypted end to end between the browser and the
 * enclave (sealed file keys in, sealed answers out). Relaying here reveals nothing.
 */
const RELAY = new Set(["attestation", "status", "upload-url", "precheck", "review", "review/decide"]);
app.all("/api/enclave/*", async (c) => {
  const path = c.req.path.slice("/api/enclave/".length);
  if (!RELAY.has(path)) return c.notFound();
  const res = await fetch(`${ENCLAVE_URL}/${path}`, {
    method: c.req.method,
    headers: { "content-type": "application/json", "x-forwarded-for": c.req.header("x-forwarded-for") ?? "local" },
    body: c.req.method === "GET" ? undefined : await c.req.text(),
    signal: AbortSignal.timeout(300_000),
  });
  return new Response(res.body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
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

serve({ fetch: app.fetch, port: PORT }, () => console.log(`[server] ${PUBLIC_URL} (DAO ${DAO_ID} on ${NETWORK}, enclave ${ENCLAVE_URL})`));
