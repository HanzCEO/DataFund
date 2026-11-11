// End-to-end checks of the enclave verifier on the example datasets, run in-process with dev keys.
// Needs NEAR_AI_API_KEY for the AI cases. Run with npm run selftest (it sets ENCLAVE_DEV)

import { readFileSync } from "node:fs";
import { encryptFile, fromUtf8, open, seal, sha256Hex, toB64, utf8 } from "../shared/crypto.js";
import { parseSpec, TASK_FIELDS } from "../shared/spec.js";
import type { DatasetSpec } from "../shared/types.js";
import { initKeys } from "../enclave/keys.js";
import { sampleIndexes } from "../enclave/dataset.js";

const keys = await initKeys();
const { verify, aiEnabled } = await import("../enclave/verifier.js");

let failed = 0;
const expect = (name: string, ok: boolean, info = "") => {
  console.log(`${ok ? "pass" : "FAIL"}  ${name}${info ? `  (${info})` : ""}`);
  if (!ok) failed++;
};

// Crypto round trips.
{
  const { key, blob } = await encryptFile(utf8("hello"));
  const sealed = await seal(keys.sealPublicKey, key);
  const back = await open(keys.sealSecret, sealed);
  const { decryptFile } = await import("../shared/crypto.js");
  expect("seal and decrypt round trip", fromUtf8(await decryptFile(back, blob)) === "hello");
  let tampered = false;
  try {
    const bad = blob.slice();
    bad[bad.length - 1] ^= 1;
    await decryptFile(back, bad);
  } catch {
    tampered = true;
  }
  expect("tampered ciphertext is refused", tampered);
}

// Sampling is reproducible from the seed and changes with it.
{
  const a = sampleIndexes(600, 100, "ab".repeat(32)), b = sampleIndexes(600, 100, "ab".repeat(32)), c = sampleIndexes(600, 100, "cd".repeat(32));
  expect("same seed gives the same sample", a.join() === b.join());
  expect("another seed gives another sample", a.join() !== c.join());
  expect("sample has 100 distinct rows", new Set(a).size === 100);
}

const spec = (s: Partial<DatasetSpec>) => parseSpec(JSON.stringify({ title: "Test", format: "jsonl", minRows: 20, guidelines: "", ...s }));
const SMS = { fields: { text: "string", label: "scam|legit" }, guidelines: "Label each SMS as scam or legit." };

async function run(file: string, s: ReturnType<typeof parseSpec>, precheck = true) {
  const plain = readFileSync(`web/public/examples/${file}`);
  const { key, blob } = await encryptFile(plain);
  return verify({
    bountyId: 0, spec: s, plaintextAllowed: false, blob, precheck,
    ref: { v: 1, sha256: await sha256Hex(plain), key: toB64(await seal(keys.sealPublicKey, key)) },
    seed: { height: 1, hash: "11111111111111111111111111111111" },
  });
}

{
  const r = await run("sms-scam-bad.jsonl", spec(SMS));
  expect("bad SMS rejected on rules", r.verdict.decision === "reject" && !r.verdict.ai, r.verdict.reasons[0]);
}
{
  const plain = readFileSync("web/public/examples/sms-scam-good.jsonl");
  const { key, blob } = await encryptFile(plain);
  const r = await verify({ bountyId: 0, spec: spec(SMS), plaintextAllowed: false, blob, precheck: true, ref: { v: 1, sha256: "0".repeat(64), key: toB64(await seal(keys.sealPublicKey, key)) } });
  expect("wrong committed hash rejected", r.verdict.decision === "reject" && r.verdict.checks.some((c) => c.name === "Hash matches submission" && !c.ok));
}

if (!aiEnabled()) {
  console.log("NEAR_AI_API_KEY not set, skipping AI cases");
} else {
  const QA = { task: "qa" as const, fields: TASK_FIELDS.qa, guidelines: "Short factual questions with one short correct answer." };
  const PREF = { task: "preference" as const, fields: TASK_FIELDS.preference, guidelines: "Prefer the response that is correct, polite and follows the stated policy." };

  const cases: [string, string, Partial<DatasetSpec>, "approve" | "reject"][] = [
    ["good SMS approved", "sms-scam-good.jsonl", SMS, "approve"],
    ["mislabeled SMS rejected", "sms-scam-mislabeled.jsonl", SMS, "reject"],
    ["good QA approved", "qa-good.jsonl", QA, "approve"],
    ["wrong QA rejected", "qa-wrong.jsonl", QA, "reject"],
    ["good preference approved", "pref-good.jsonl", PREF, "approve"],
    ["flipped preference rejected", "pref-flipped.jsonl", PREF, "reject"],
  ];
  for (const [name, file, s, want] of cases) {
    const r = await run(file, spec(s));
    expect(name, r.verdict.decision === want && !r.verdict.aiError, `score ${r.verdict.score}, agreement ${Math.round((r.verdict.ai?.agreement ?? 0) * 100)}%${r.verdict.aiError ? `, ${r.verdict.aiError}` : ""}`);
  }

  // Full scan finds the junk that sits after the honest first 70% of the file.
  const facade = await run("sms-scam-facade.jsonl", spec(SMS), false);
  expect("facade caught by full scan", facade.verdict.decision === "reject" && facade.verdict.ai?.fullScan === true, `${facade.verdict.ai?.scanned} rows scanned, agreement ${Math.round((facade.verdict.ai?.agreement ?? 0) * 100)}%`);

  // Manual review. The requester gets 100 random rows plus flagged rows, never more than 20% of the file.
  const manual = await run("sms-scam-facade.jsonl", spec({ ...SMS, review: "manual" }), false);
  const shown = manual.details.sample.length;
  const late = manual.details.sample.filter((s) => s.row >= 420).length;
  expect("manual review waits for the requester", manual.verdict.decision === "review" && manual.verdict.autoDecision === "reject");
  expect("manual sample stays within 20%", shown >= 100 && shown <= 120, `${shown} rows shown, ${late} from the junk part`);
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
