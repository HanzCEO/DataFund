// Keys and attestation. Inside a dstack CVM, keys are derived by the dstack KMS from the app identity.
// They never touch disk and the same app gets the same keys after a restart or a move to another machine.
import { DstackClient } from "@phala/dstack-sdk";
import { ed25519 } from "@noble/curves/ed25519";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { utils } from "near-api-js";
import { concat, randomBytes, sha256, toB64, toHex, utf8, x25519Keypair } from "../shared/crypto.js";
import type { Attestation } from "../shared/types.js";
import { ALLOW_DEV_KEYS, DATA_DIR } from "./config.js";

export interface EnclaveKeys {
  mode: "tee" | "dev";
  accountId: string;
  /** ed25519:base58 of seed + public key, for KeyPairSigner. */
  nearSecretKey: string;
  nearPublicKey: Uint8Array;
  sealSecret: Uint8Array;
  sealPublicKey: Uint8Array;
}

let keys: EnclaveKeys | undefined;
let dstack: DstackClient | undefined;

export async function initKeys(): Promise<EnclaveKeys> {
  let nearMaterial: Uint8Array, sealMaterial: Uint8Array, mode: EnclaveKeys["mode"];
  let client: DstackClient | undefined;
  try {
    client = new DstackClient(); // throws when there is no dstack socket and no simulator endpoint
  } catch {
    client = undefined;
  }
  if (client && (await client.isReachable().catch(() => false))) {
    dstack = client;
    mode = "tee";
    nearMaterial = (await client.getKey("datafund/near/v1")).key;
    sealMaterial = (await client.getKey("datafund/seal/v1")).key;
  } else if (ALLOW_DEV_KEYS) {
    mode = "dev";
    const file = join(DATA_DIR, "dev-seed");
    mkdirSync(DATA_DIR, { recursive: true });
    if (!existsSync(file)) writeFileSync(file, toHex(randomBytes(32)), { mode: 0o600 });
    const seed = readFileSync(file, "utf8").trim();
    nearMaterial = utf8(`${seed}/near`);
    sealMaterial = utf8(`${seed}/seal`);
    console.warn("[enclave] DEV MODE. No TEE found, keys come from a local file and there is no attestation.");
  } else {
    throw new Error("No dstack socket found. Run inside a dstack CVM, start the simulator, or set ENCLAVE_DEV=true for local tests");
  }

  // Hash the KMS output into fixed-size secrets, one per purpose.
  const nearSeed = await sha256(concat(utf8("near-ed25519:"), nearMaterial));
  const nearPublicKey = ed25519.getPublicKey(nearSeed) as Uint8Array;
  const seal = x25519Keypair(await sha256(concat(utf8("seal-x25519:"), sealMaterial)));
  keys = {
    mode,
    // NEAR implicit account. Its id is the hex of its ed25519 public key.
    accountId: toHex(nearPublicKey),
    nearSecretKey: `ed25519:${utils.serialize.base_encode(concat(nearSeed, nearPublicKey))}`,
    nearPublicKey,
    sealSecret: seal.secret,
    sealPublicKey: seal.publicKey,
  };
  return keys;
}

export function getKeys(): EnclaveKeys {
  if (!keys) throw new Error("Keys are not initialised");
  return keys;
}

/** Report data binds both public keys into the TDX quote. 32 + 32 bytes fills the 64-byte field exactly. */
export async function attestation(): Promise<Attestation> {
  const k = getKeys();
  const reportData = concat(k.nearPublicKey, k.sealPublicKey);
  const base: Attestation = {
    mode: k.mode,
    accountId: k.accountId,
    nearPublicKey: `ed25519:${utils.serialize.base_encode(k.nearPublicKey)}`,
    sealPublicKey: toB64(k.sealPublicKey),
    reportData: toHex(reportData),
  };
  if (!dstack) return base;
  const [quote, info] = await Promise.all([dstack.getQuote(reportData), dstack.info()]);
  return {
    ...base,
    quote: quote.quote,
    eventLog: quote.event_log,
    composeHash: info.compose_hash ?? info.tcb_info.compose_hash,
    appId: info.app_id,
    osImageHash: info.os_image_hash ?? info.tcb_info.os_image_hash,
  };
}
