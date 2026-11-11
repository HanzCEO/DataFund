// Encrypt a dataset for the enclave and print the bounty_done description (JSON) to stdout.
// The encrypted file goes to IPFS through the enclave's signed upload URL, or to --out for you to host.
// Run as npx tsx scripts/seal.ts <file> [--url https://…/file.enc] [--out file.enc]
import { readFileSync, writeFileSync } from "node:fs";
import { encryptFile, fromB64, seal, sha256Hex, toB64 } from "../shared/crypto.js";
import type { Attestation, SubmissionRef } from "../shared/types.js";

const args = process.argv.slice(2);
const file = args[0];
const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const base = (process.env.PUBLIC_URL ?? "http://localhost:8787") + "/api/enclave";
if (!file) throw new Error("Run as npx tsx scripts/seal.ts <file> [--url link] [--out file.enc]");

const att = (await (await fetch(`${base}/attestation`)).json()) as Attestation;
const plain = readFileSync(file);
const { key, blob } = await encryptFile(plain);
const ref: SubmissionRef = { v: 1, sha256: await sha256Hex(plain), key: toB64(await seal(fromB64(att.sealPublicKey), key)) };

if (opt("--out")) {
  writeFileSync(opt("--out")!, blob);
  console.error(`wrote ${opt("--out")}. Host it and rerun with --url, or keep this description and fill in "url"`);
}
if (opt("--url")) ref.url = opt("--url");
else {
  const res = await fetch(`${base}/upload-url`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const signed = await res.json();
  if (!res.ok) throw new Error(`${signed.error}. Use --out and --url to host the encrypted file yourself`);
  const form = new FormData();
  form.append("network", "public");
  form.append("file", new Blob([blob as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" }), "dataset.enc");
  const up = await fetch(signed.url, { method: "POST", body: form });
  const json = await up.json();
  if (!up.ok || !json.data?.cid) throw new Error(`IPFS upload failed (HTTP ${up.status})`);
  ref.cid = json.data.cid;
  console.error(`uploaded encrypted file to ipfs://${ref.cid}`);
}
console.log(JSON.stringify(ref));
