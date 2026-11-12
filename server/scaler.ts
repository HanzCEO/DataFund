// Scale to zero for the Phala CVM. The public server starts the enclave when there is work and shuts it down after
// a quiet spell. It only ever sees public data (chain state, public verdicts), never keys or datasets.
//
// Work that needs the enclave
//   a payout claim with no verdict yet, or a verdict that still has to be voted on
//   a manual review the requester decided, or whose deadline passed
//   an approved payout whose key has not been released
//   any relayed request (precheck, upload URL, review, key)
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Attestation, ProposalView, Verdict } from "../shared/types.js";
import { ENCLAVE_URL, IDLE_MINUTES, PHALA_API, PHALA_CLOUD_API_KEY, PHALA_CVM_ID } from "./config.js";

export type Phase = "awake" | "asleep" | "waking" | "stopping" | "unknown";

const DATA_DIR = process.env.DATA_DIR ?? "data";
const CACHE = join(DATA_DIR, "enclave-cache.json");
mkdirSync(DATA_DIR, { recursive: true });

/** Public enclave data kept on disk. The app keeps working while the CVM sleeps. */
type Cache = { verdicts: Record<string, Verdict>; attestation?: Attestation; status?: Record<string, unknown> };
let cache: Cache = { verdicts: {} };
try {
  cache = { ...cache, ...JSON.parse(readFileSync(CACHE, "utf8")) };
} catch {
  // first run
}
function saveCache() {
  writeFileSync(CACHE + ".tmp", JSON.stringify(cache));
  renameSync(CACHE + ".tmp", CACHE);
}

export const scalingEnabled = () => Boolean(PHALA_CLOUD_API_KEY && PHALA_CVM_ID);
export const cachedVerdicts = () => cache.verdicts;
export const cachedAttestation = () => cache.attestation;
export const cachedStatus = () => cache.status;

let phase: Phase = scalingEnabled() ? "unknown" : "awake";
let lastActivity = Date.now();
export const getPhase = () => phase;
/** Something just used or needs the enclave. Pushes back the idle shutdown. */
export const touch = () => void (lastActivity = Date.now());

async function enclave<T>(path: string, timeoutMs = 8000): Promise<T> {
  const res = await fetch(`${ENCLAVE_URL}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Enclave answered HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/** Ask the enclave directly. Success means awake, and the answers refresh the cache. */
async function probe(): Promise<{ busy: number } | undefined> {
  try {
    const status = await enclave<Record<string, unknown> & { busy?: number }>("/status");
    const verdicts = await enclave<Record<string, Verdict>>("/verdicts");
    cache.status = status;
    cache.verdicts = verdicts;
    if (!cache.attestation || cache.attestation.accountId !== status.accountId) cache.attestation = await enclave<Attestation>("/attestation", 30_000);
    saveCache();
    if (phase !== "stopping") phase = "awake";
    return { busy: Number(status.busy ?? 0) };
  } catch {
    return undefined;
  }
}

async function phala(path: string, method: "GET" | "POST" = "GET"): Promise<any> {
  const res = await fetch(`${PHALA_API}/cvms/${PHALA_CVM_ID}${path}`, {
    method,
    headers: { "X-API-Key": PHALA_CLOUD_API_KEY, accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => ({}));
  // 409 means another start or stop is already under way. That's fine for us.
  if (!res.ok && res.status !== 409) throw new Error(`Phala API ${method} ${path} answered HTTP ${res.status} (${body?.detail ?? body?.message ?? ""})`);
  return body;
}

let waking: Promise<void> | undefined;

/** Make sure the enclave is up. Starts the CVM if needed and waits until the enclave answers (up to 5 minutes). */
export function wake(): Promise<void> {
  touch();
  if (!scalingEnabled() || phase === "awake") return Promise.resolve();
  waking ??= (async () => {
    try {
      if (await probe()) return;
      phase = "waking";
      console.log("[scaler] starting the enclave CVM");
      await phala("/start", "POST");
      const until = Date.now() + 5 * 60_000;
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 5000));
        if (await probe()) {
          console.log("[scaler] enclave is awake");
          return;
        }
      }
      phase = "unknown";
      throw new Error("The enclave did not wake up within 5 minutes");
    } finally {
      waking = undefined;
    }
  })();
  return waking;
}

/** Whether a payout proposal still needs the enclave, judged from public chain data and the public verdict. */
function needsEnclave(p: ProposalView, v: Verdict | undefined, proposalPeriodMs: number): boolean {
  if (typeof p.kind !== "object" || !p.kind.BountyDone) return false;
  if (v?.abandoned) return false;
  if (p.status === "Approved") return Boolean(v?.encrypted && !v.released);
  if (p.status !== "InProgress") return false;
  // An expired proposal can't be voted on any more.
  if (Date.now() - Number(BigInt(p.submission_time) / 1_000_000n) > proposalPeriodMs) return false;
  if (!v) return true;
  if (v.voteTx) return false;
  if (v.decision !== "review") return true;
  return Boolean(v.review?.decision) || Date.now() > Date.parse(v.review?.deadline ?? "");
}

/**
 * One scaling decision. Wake when there is work, shut down after IDLE_MINUTES without work, requests or jobs.
 * Called by the server's poll loop with fresh proposals.
 */
export async function scale(proposals: ProposalView[], proposalPeriodMs: number) {
  if (!scalingEnabled()) return void (await probe()); // keep the cache fresh, nothing to scale
  if (waking || phase === "stopping") return;
  const live = await probe();
  if (!live && phase !== "waking") phase = "asleep";

  const pending = proposals.filter((p) => needsEnclave(p, cache.verdicts[p.id], proposalPeriodMs));
  if (pending.length) {
    touch();
    if (!live) await wake().catch((e) => console.warn(`[scaler] wake failed (${(e as Error).message})`));
    return;
  }
  if (!live) return;
  if (live.busy > 0) return touch();
  if (Date.now() - lastActivity < IDLE_MINUTES * 60_000) return;

  phase = "stopping";
  console.log(`[scaler] no work for ${IDLE_MINUTES} min, shutting the enclave CVM down`);
  try {
    await phala("/shutdown", "POST");
    phase = "asleep";
  } catch (e) {
    phase = "unknown";
    console.warn(`[scaler] shutdown failed (${(e as Error).message})`);
  }
}
