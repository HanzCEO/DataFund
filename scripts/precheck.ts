// Encrypt a local dataset, precheck it in the enclave and print the verdict. Nothing is sent in plaintext.
// Run as npx tsx scripts/precheck.ts <bounty-id> <file> [enclave-url]
import { readFileSync } from "node:fs";
import { encryptFile, fromB64, openJson, seal, sha256Hex, toB64, x25519Keypair } from "../shared/crypto.js";
import type { Attestation, Verdict, VerdictDetails } from "../shared/types.js";

const [bountyId, file, base = process.env.ENCLAVE_URL ?? "http://localhost:8788"] = process.argv.slice(2);
if (!bountyId || !file) throw new Error("Run as npx tsx scripts/precheck.ts <bounty-id> <file> [enclave-url]");

const att = (await (await fetch(`${base}/attestation`)).json()) as Attestation;
const plain = readFileSync(file);
const { key, blob } = await encryptFile(plain);
const reply = x25519Keypair();
const res = await fetch(`${base}/precheck`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    bountyId: Number(bountyId),
    blob: toB64(blob),
    key: toB64(await seal(fromB64(att.sealPublicKey), key)),
    sha256: await sha256Hex(plain),
    replyKey: toB64(reply.publicKey),
  }),
});
const json = await res.json();
if (!res.ok) throw new Error(json.error);
const { verdict, details } = await openJson<{ verdict: Verdict; details: VerdictDetails }>(reply.secret, json.sealed);
console.log(`${verdict.decision.toUpperCase()} score ${verdict.score} (${verdict.rows} rows, enclave ${att.mode})`);
for (const c of verdict.checks) console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.name}  ${c.detail}`);
if (verdict.ai) console.log(`  AI agreement ${Math.round(verdict.ai.agreement * 100)}% on ${verdict.ai.scanned} rows, quality ${verdict.ai.qualityScore}, ${verdict.ai.flagged} flagged`);
if (verdict.aiError) console.log(`  AI error ${verdict.aiError}`);
for (const r of verdict.reasons) console.log(`  - ${r}`);
console.log(`  ${details.judgements.length} judgements, ${details.sample.length} sample rows`);
