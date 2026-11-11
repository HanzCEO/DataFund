import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PUBLIC_RPCS } from "./rpc.js";

try {
  process.loadEnvFile(".env");
} catch {
  // .env is optional. Real env vars still apply.
}

const env = (k: string, d?: string): string => {
  const v = process.env[k] ?? d;
  if (v === undefined || v === "") throw new Error(`Missing env ${k} (see .env.example)`);
  return v;
};

export const NETWORK = env("NEAR_NETWORK", "testnet");
/**
 * RPC nodes used in round-robin. NEAR_RPC_URLS (comma-separated) replaces the default public list.
 * A legacy single NEAR_RPC_URL is kept and put first.
 */
const list = (v?: string) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
export const RPC_URLS = [...new Set([...list(process.env.NEAR_RPC_URL), ...(list(process.env.NEAR_RPC_URLS).length ? list(process.env.NEAR_RPC_URLS) : PUBLIC_RPCS[NETWORK] ?? [])])];
if (!RPC_URLS.length) throw new Error(`No RPC URLs for network ${NETWORK}. Set NEAR_RPC_URLS`);
export const DAO_ID = env("DAO_ID");
export const VERIFIER_ACCOUNT = env("VERIFIER_ACCOUNT");
export const PORT = Number(env("PORT", "8787"));
export const PUBLIC_URL = env("PUBLIC_URL", `http://localhost:${PORT}`);
export const MIN_SCORE = Number(env("MIN_SCORE", "70"));
/** Minimum share of sampled rows where the AI's blind label matches the submitted one. */
export const MIN_AGREEMENT = Number(env("MIN_AGREEMENT", "0.8"));
export const POLL_MS = Number(env("POLL_MS", "8000"));
export const AUTO_VOTE = env("AUTO_VOTE", "true") === "true";

export const NEAR_AI_API_KEY = process.env.NEAR_AI_API_KEY ?? "";
export const NEAR_AI_BASE_URL = env("NEAR_AI_BASE_URL", "https://cloud-api.near.ai/v1");
export const NEAR_AI_MODEL = env("NEAR_AI_MODEL", "z-ai/glm-5.3-flash");

export const EXPLORER = NETWORK === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";

/** Verifier bot key from VERIFIER_PRIVATE_KEY, else the near-cli legacy keychain file. */
export function verifierPrivateKey(): string {
  if (process.env.VERIFIER_PRIVATE_KEY) return process.env.VERIFIER_PRIVATE_KEY;
  const file = join(homedir(), ".near-credentials", NETWORK, `${VERIFIER_ACCOUNT}.json`);
  const key = JSON.parse(readFileSync(file, "utf8")).private_key;
  if (!key) throw new Error(`No private_key in ${file}`);
  return key;
}
