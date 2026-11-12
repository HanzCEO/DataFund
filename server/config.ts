import { PUBLIC_RPCS } from "../shared/rpc.js";

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
/** The enclave service. The public server relays to it and never sees plaintext. */
export const ENCLAVE_URL = env("ENCLAVE_URL", "http://localhost:8788").replace(/\/$/, "");
export const PORT = Number(env("PORT", "8787"));
export const PUBLIC_URL = env("PUBLIC_URL", `http://localhost:${PORT}`);

export const EXPLORER = NETWORK === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";

/** Scale to zero. Needs a Phala Cloud API key and the CVM's id (app id, UUID or name). Off when either is missing. */
export const PHALA_CLOUD_API_KEY = process.env.PHALA_CLOUD_API_KEY ?? "";
export const PHALA_CVM_ID = process.env.PHALA_CVM_ID ?? "";
export const PHALA_API = env("PHALA_API", "https://cloud-api.phala.com/api/v1").replace(/\/$/, "");
/** Minutes without work or requests before the enclave CVM is shut down. */
export const IDLE_MINUTES = Number(env("IDLE_MINUTES", "10"));
