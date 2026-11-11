import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Verdict } from "../shared/types.js";

const DATA_DIR = process.env.DATA_DIR ?? "data";
const UPLOADS = join(DATA_DIR, "uploads");
const FILE = join(DATA_DIR, "verdicts.json");
mkdirSync(UPLOADS, { recursive: true });

export const uploadPath = (name: string) => join(UPLOADS, name);

type Db = { verdicts: Record<string, Verdict>; attempts: Record<string, number> };
let db: Db = { verdicts: {}, attempts: {} };
try {
  db = { ...db, ...JSON.parse(readFileSync(FILE, "utf8")) };
} catch {
  // first run
}

function save() {
  writeFileSync(FILE + ".tmp", JSON.stringify(db, null, 2));
  renameSync(FILE + ".tmp", FILE);
}

export const getVerdict = (proposalId: number) => db.verdicts[proposalId];
export const allVerdicts = () => db.verdicts;
export function putVerdict(v: Verdict) {
  db.verdicts[v.proposalId!] = v;
  save();
}
export function bumpAttempt(proposalId: number): number {
  db.attempts[proposalId] = (db.attempts[proposalId] ?? 0) + 1;
  save();
  return db.attempts[proposalId];
}
