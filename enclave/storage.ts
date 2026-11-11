// Fetching encrypted datasets and pinning them to IPFS. Nothing here is stored on the operator's server.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ALLOW_PRIVATE_URLS, IPFS_GATEWAYS, MAX_BYTES, PINATA_JWT } from "./config.js";

const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})$/;
export const isCid = (s: string) => CID_RE.test(s);

/** Fetch a file by CID (any gateway) or by https link. */
export async function fetchBytes(ref: { cid?: string; url?: string }): Promise<Uint8Array> {
  if (ref.cid) {
    if (!isCid(ref.cid)) throw new Error("Invalid CID");
    let last: unknown;
    for (const gw of IPFS_GATEWAYS) {
      try {
        return await fetchGuarded(new URL(`/ipfs/${ref.cid}`, gw));
      } catch (e) {
        last = e;
      }
    }
    throw new Error(`No IPFS gateway returned ${ref.cid} (${(last as Error)?.message})`);
  }
  if (ref.url) {
    const m = ref.url.match(/^ipfs:\/\/([^/?#]+)/);
    return m ? fetchBytes({ cid: m[1] }) : fetchGuarded(new URL(ref.url));
  }
  throw new Error("Submission has no CID or URL");
}

async function fetchGuarded(start: URL): Promise<Uint8Array> {
  let current = start;
  for (let hop = 0; hop < 4; hop++) {
    await assertPublic(current);
    const res = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location")!, current);
      continue;
    }
    if (!res.ok) throw new Error(`Fetch failed with HTTP ${res.status}`);
    return readCapped(res);
  }
  throw new Error("Too many redirects");
}

async function assertPublic(u: URL) {
  if (ALLOW_PRIVATE_URLS) return;
  if (u.protocol !== "https:") throw new Error("Dataset URL must be https");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  for (const a of addrs) if (isPrivate(a)) throw new Error("Dataset URL resolves to a private address");
}

function isPrivate(ip: string): boolean {
  if (ip.includes(":")) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return isPrivate(v.slice(7));
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

async function readCapped(res: Response): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new Error(`Dataset larger than ${MAX_BYTES / 1024 / 1024} MB`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export const pinningEnabled = () => Boolean(PINATA_JWT);

/** Pin the encrypted file to the DAO's Pinata account. The contributor can't unpin it after payout. */
export async function pin(bytes: Uint8Array, name: string): Promise<string> {
  if (!PINATA_JWT) throw new Error("Pinning is not configured (PINATA_JWT)");
  const form = new FormData();
  form.append("network", "public");
  form.append("name", name);
  form.append("file", new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" }), name);
  const res = await fetch("https://uploads.pinata.cloud/v3/files", {
    method: "POST",
    headers: { authorization: `Bearer ${PINATA_JWT}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  const json = (await res.json().catch(() => ({}))) as { data?: { cid?: string } };
  if (!res.ok || !json.data?.cid) throw new Error(`Pinata upload failed with HTTP ${res.status}`);
  return json.data.cid;
}

/** Short-lived URL the browser uploads one encrypted file to. The Pinata key never leaves the enclave. */
export async function signedUploadUrl(): Promise<string> {
  if (!PINATA_JWT) throw new Error("IPFS upload is not configured. Host the encrypted file yourself and paste its link");
  const res = await fetch("https://uploads.pinata.cloud/v3/files/sign", {
    method: "POST",
    headers: { authorization: `Bearer ${PINATA_JWT}`, "content-type": "application/json" },
    body: JSON.stringify({ date: Math.floor(Date.now() / 1000), expires: 120, max_file_size: MAX_BYTES, filename: "dataset.enc" }),
  });
  const json = (await res.json().catch(() => ({}))) as { data?: string };
  if (!res.ok || !json.data) throw new Error(`Pinata refused to sign an upload URL (HTTP ${res.status})`);
  return json.data;
}
