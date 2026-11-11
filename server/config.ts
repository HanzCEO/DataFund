import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

try {
  process.loadEnvFile(".env");
} catch {
  // .env is optional; real env vars still apply.
}

const env = (k: string, d?: string): string => {
  const v = process.env[k] ?? d;
  if (v === undefined || v === "") throw new Error(`Missing env ${k} (see .env.example)`);
  return v;
};

export const NETWORK = env("NEAR_NETWORK", "testnet");
export const RPC_URL = env("NEAR_RPC_URL", NETWORK === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com");
export const DAO_ID = env("DAO_ID");
export const VERIFIER_ACCOUNT = env("VERIFIER_ACCOUNT");
export const PORT = Number(env("PORT", "8787"));
export const PUBLIC_URL = env("PUBLIC_URL", `http://localhost:${PORT}`);
export const MIN_SCORE = Number(env("MIN_SCORE", "70"));
export const POLL_MS = Number(env("POLL_MS", "8000"));
export const AUTO_VOTE = env("AUTO_VOTE", "true") === "true";

export const NEAR_AI_API_KEY = process.env.NEAR_AI_API_KEY ?? "";
export const NEAR_AI_BASE_URL = env("NEAR_AI_BASE_URL", "https://cloud-api.near.ai/v1");
export const NEAR_AI_MODEL = env("NEAR_AI_MODEL", "z-ai/glm-5.3-flash");

export const EXPLORER = NETWORK === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";

/** Verifier bot key: VERIFIER_PRIVATE_KEY, else the near-cli legacy keychain file. */
export function verifierPrivateKey(): string {
  if (process.env.VERIFIER_PRIVATE_KEY) return process.env.VERIFIER_PRIVATE_KEY;
  const file = join(homedir(), ".near-credentials", NETWORK, `${VERIFIER_ACCOUNT}.json`);
  const key = JSON.parse(readFileSync(file, "utf8")).private_key;
  if (!key) throw new Error(`No private_key in ${file}`);
  return key;
}
