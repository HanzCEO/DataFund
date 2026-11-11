// Encryption used by the browser and the enclave. WebCrypto AES-256-GCM for data and x25519 for sealing keys.
import { x25519 } from "@noble/curves/ed25519";

const subtle = globalThis.crypto.subtle;
const SEAL_TAG = new TextEncoder().encode("datafund-seal-v1");

export const utf8 = (s: string) => new TextEncoder().encode(s);
export const fromUtf8 = (b: Uint8Array) => new TextDecoder().decode(b);

export function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, o), (o += p.length);
  return out;
}

export const randomBytes = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));

/** WebCrypto wants an ArrayBuffer-backed view. Copies when the input is a slice of a bigger buffer. */
const buf = (b: Uint8Array) => (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b : b.slice()) as Uint8Array<ArrayBuffer>;

export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest("SHA-256", buf(typeof data === "string" ? utf8(data) : data)));
}

export const sha256Hex = async (data: Uint8Array | string) => toHex(await sha256(data));

async function aes(key: Uint8Array, usage: "encrypt" | "decrypt") {
  return subtle.importKey("raw", buf(key), "AES-GCM", false, [usage]);
}

/** iv (12 bytes) followed by AES-GCM ciphertext. */
export async function aesEncrypt(key: Uint8Array, plain: Uint8Array): Promise<Uint8Array> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, await aes(key, "encrypt"), buf(plain)));
  return concat(iv, ct);
}

export async function aesDecrypt(key: Uint8Array, blob: Uint8Array): Promise<Uint8Array> {
  if (blob.length < 28) throw new Error("Ciphertext too short");
  const iv = blob.subarray(0, 12);
  return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: buf(iv) }, await aes(key, "decrypt"), buf(blob.subarray(12))));
}

/** Encrypt a dataset with a fresh random key. The key is what gets sealed to the enclave. */
export async function encryptFile(plain: Uint8Array) {
  const key = randomBytes(32);
  return { key, blob: await aesEncrypt(key, plain) };
}

export const decryptFile = aesDecrypt;

export function x25519Keypair(secret: Uint8Array = randomBytes(32)) {
  return { secret, publicKey: x25519.getPublicKey(secret) };
}

async function sealKey(shared: Uint8Array, ephPub: Uint8Array, recipient: Uint8Array) {
  return sha256(concat(SEAL_TAG, shared, ephPub, recipient));
}

/**
 * Anonymous sealed box. Only the holder of the recipient's x25519 secret can open it.
 * Layout is ephemeral public key (32), then iv and AES-GCM ciphertext.
 */
export async function seal(recipient: Uint8Array, msg: Uint8Array): Promise<Uint8Array> {
  const eph = x25519Keypair();
  const key = await sealKey(x25519.getSharedSecret(eph.secret, recipient), eph.publicKey, recipient);
  return concat(eph.publicKey, await aesEncrypt(key, msg));
}

export async function open(secret: Uint8Array, sealed: Uint8Array): Promise<Uint8Array> {
  if (sealed.length < 60) throw new Error("Sealed box too short");
  const ephPub = sealed.subarray(0, 32);
  const mine = x25519.getPublicKey(secret);
  const key = await sealKey(x25519.getSharedSecret(secret, ephPub), ephPub, mine);
  return aesDecrypt(key, sealed.subarray(32));
}

export const sealJson = async (recipient: Uint8Array, value: unknown) => toB64(await seal(recipient, utf8(JSON.stringify(value))));
export const openJson = async <T>(secret: Uint8Array, sealed: string): Promise<T> => JSON.parse(fromUtf8(await open(secret, fromB64(sealed))));
