// Enclave state on the CVM's encrypted disk. Public verdicts and private details are kept apart.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Verdict, VerdictDetails } from "../shared/types.js";
import { DATA_DIR } from "./config.js";

mkdirSync(DATA_DIR, { recursive: true });
const FILE = join(DATA_DIR, "state.json");

type Db = { verdicts: Record<string, Verdict>; details: Record<string, VerdictDetails>; attempts: Record<string, number> };
let db: Db = { verdicts: {}, details: {}, attempts: {} };
try {
  db = { ...db, ...JSON.parse(readFileSync(FILE, "utf8")) };
} catch {
  // First run. Import verdicts from the old single-server store so past payouts keep their history.
  try {
    const old = JSON.parse(readFileSync(process.env.LEGACY_VERDICTS ?? "data/verdicts.json", "utf8"));
    for (const [id, v] of Object.entries<any>(old.verdicts ?? {}))
      db.verdicts[id] = { task: "classification", mode: "auto", encrypted: false, ...v, ai: v.ai && { ...v.ai, scanned: v.ai.sampled, fullScan: false, completionIds: v.ai.completionId ? [v.ai.completionId] : [], flagged: (v.ai.judgements ?? []).filter((j: any) => !j.agrees).length } };
  } catch {
    // nothing to import
  }
}

function save() {
  writeFileSync(FILE + ".tmp", JSON.stringify(db));
  renameSync(FILE + ".tmp", FILE);
}

export const getVerdict = (id: number): Verdict | undefined => db.verdicts[id];
export const getDetails = (id: number): VerdictDetails | undefined => db.details[id];
export const allVerdicts = () => db.verdicts;

export function putVerdict(v: Verdict, details?: VerdictDetails) {
  db.verdicts[v.proposalId!] = v;
  if (details) db.details[v.proposalId!] = details;
  save();
}

export function bumpAttempt(id: number): number {
  db.attempts[id] = (db.attempts[id] ?? 0) + 1;
  save();
  return db.attempts[id];
}
