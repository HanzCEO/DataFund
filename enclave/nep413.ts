// NEP-413 signed messages. A wallet signs a review request off-chain and the enclave checks it.
import { ed25519 } from "@noble/curves/ed25519";
import { utils } from "near-api-js";
import { concat, fromB64, sha256, toHex, utf8 } from "../shared/crypto.js";
import type { ReviewMessage, SignedRequest } from "../shared/types.js";
import { DAO_ID } from "./config.js";
import { isFullAccessKey } from "./chain.js";

const TAG = 2147484061; // 2^31 + 413

const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const str = (s: string) => {
  const b = utf8(s);
  return concat(u32(b.length), b);
};

function payload(r: SignedRequest, nonce: Uint8Array, callbackUrl?: string) {
  return concat(u32(TAG), str(r.message), nonce, str(r.recipient), callbackUrl === undefined ? new Uint8Array([0]) : concat(new Uint8Array([1]), str(callbackUrl)));
}

function decodeSig(s: string): Uint8Array {
  try {
    const b = fromB64(s);
    if (b.length === 64) return b;
  } catch {
    // not base64
  }
  return utils.serialize.base_decode(s.replace(/^ed25519:/, ""));
}

const seen = new Map<string, number>();
const MAX_AGE_MS = 10 * 60_000;

/** Verify the signature, the key's owner and freshness. Returns the parsed message. */
export async function verifySigned(r: SignedRequest): Promise<ReviewMessage> {
  if (!r?.accountId || !r.publicKey?.startsWith("ed25519:") || !r.signature || !r.message || !r.nonce) throw new Error("Incomplete signed request");
  const nonce = fromB64(r.nonce);
  if (nonce.length !== 32) throw new Error("Nonce must be 32 bytes");
  const pub = utils.serialize.base_decode(r.publicKey.slice(8));
  const sig = decodeSig(r.signature);

  // Some wallets sign the callback URL as part of the payload and some don't. Accept either form.
  const forms = r.callbackUrl ? [r.callbackUrl, undefined] : [undefined];
  let ok = false;
  for (const cb of forms) if (ed25519.verify(sig, await sha256(payload(r, nonce, cb)), pub)) ok = true;
  if (!ok) throw new Error("Bad signature");
  if (!(await isFullAccessKey(r.accountId, r.publicKey))) throw new Error(`The signing key is not a full-access key of ${r.accountId}`);

  const m = JSON.parse(r.message) as ReviewMessage;
  if (m.app !== "datafund" || m.dao !== DAO_ID) throw new Error("Message is for another app");
  if (r.recipient !== DAO_ID) throw new Error("Wrong recipient");
  if (!Number.isFinite(m.ts) || Math.abs(Date.now() - m.ts) > MAX_AGE_MS) throw new Error("Signed request expired. Sign again");

  const id = toHex(nonce);
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > MAX_AGE_MS * 2) seen.delete(k);
  if (m.action !== "view" && seen.has(id)) throw new Error("Signed request already used");
  seen.set(id, now);
  return m;
}
