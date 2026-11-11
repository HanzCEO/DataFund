// Enclave settings. In a Phala CVM these come from encrypted env vars that only the CVM can read.
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
const list = (v?: string) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export const NETWORK = env("NEAR_NETWORK", "testnet");
export const RPC_URLS = list(process.env.NEAR_RPC_URLS).length ? list(process.env.NEAR_RPC_URLS) : PUBLIC_RPCS[NETWORK] ?? [];
if (RPC_URLS.length < 2) throw new Error("The enclave needs at least two RPC URLs to confirm payouts before releasing keys");
export const DAO_ID = env("DAO_ID");
export const PORT = Number(env("ENCLAVE_PORT", "8788"));
export const DATA_DIR = env("ENCLAVE_DATA_DIR", "data/enclave");

/** Without a dstack socket the enclave refuses to start unless this is set. Dev keys live in a plain file. */
export const ALLOW_DEV_KEYS = process.env.ENCLAVE_DEV === "true";
/** Dev only. Lets the verifier fetch from http and private addresses, for local tests. */
export const ALLOW_PRIVATE_URLS = process.env.ENCLAVE_ALLOW_PRIVATE_URLS === "true";

export const MIN_SCORE = Number(env("MIN_SCORE", "70"));
export const POLL_MS = Number(env("POLL_MS", "8000"));
export const AUTO_VOTE = env("AUTO_VOTE", "true") === "true";
/** Files up to this many rows are checked row by row. Bigger files get a random sample of SAMPLE_ROWS. */
export const FULL_SCAN_ROWS = Number(env("FULL_SCAN_ROWS", "2000"));
export const SAMPLE_ROWS = Number(env("SAMPLE_ROWS", "500"));
export const MAX_BYTES = Number(env("MAX_DATASET_MB", "10")) * 1024 * 1024;

export const NEAR_AI_API_KEY = process.env.NEAR_AI_API_KEY ?? "";
export const NEAR_AI_BASE_URL = env("NEAR_AI_BASE_URL", "https://cloud-api.near.ai/v1");
export const NEAR_AI_MODEL = env("NEAR_AI_MODEL", "z-ai/glm-5.3-flash");

export const PINATA_JWT = process.env.PINATA_JWT ?? "";
/** Gateways tried in order when fetching a CID. The file is encrypted and its hash is checked. Any gateway will do. */
export const IPFS_GATEWAYS = [...list(process.env.PINATA_GATEWAY).map((g) => (g.startsWith("http") ? g : `https://${g}`)), "https://ipfs.io", "https://dweb.link"];
