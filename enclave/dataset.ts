// Parsing and deterministic checks. These run on every row inside the enclave.
import { answerField, kindOf, labelsOfType } from "../shared/spec.js";
import type { Check, DatasetSpec } from "../shared/types.js";

export type Spec = Required<DatasetSpec>;
export type Row = Record<string, unknown>;

export function parseRows(content: string, format: DatasetSpec["format"]): { rows: Row[]; errors: number } {
  const lines = content.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (format === "csv") {
    const [header, ...body] = lines;
    if (!header) return { rows: [], errors: 0 };
    const cols = splitCsv(header);
    let errors = 0;
    const rows = body.flatMap((l) => {
      const cells = splitCsv(l);
      if (cells.length !== cols.length) return errors++, [];
      return [Object.fromEntries(cols.map((c, i) => [c, cells[i]]))];
    });
    return { rows, errors };
  }
  let errors = 0;
  const rows = lines.flatMap((l) => {
    try {
      const v = JSON.parse(l);
      return v && typeof v === "object" && !Array.isArray(v) ? [v as Row] : (errors++, []);
    } catch {
      return errors++, [];
    }
  });
  return { rows, errors };
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") out.push(cur), (cur = "");
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** The part of a row that makes it unique. Two rows with the same input are duplicates whatever their answers. */
export function inputKey(row: Row, spec: Spec): string {
  const answer = answerField(spec);
  const fields = Object.keys(spec.fields).filter((f) => f !== answer);
  return fields.map((f) => String(row[f] ?? "")).join("␟").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Short text that identifies a row in a judgement table. */
export function rowText(row: Row, spec: Spec): string {
  if (spec.task === "qa") return String(row.question ?? "");
  if (spec.task === "preference") return String(row.prompt ?? "");
  const answer = answerField(spec);
  const f = Object.keys(spec.fields).find((k) => k !== answer && spec.fields[k] === "string") ?? Object.keys(spec.fields)[0];
  return String(row[f] ?? "");
}

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE = /(?:\+?\d[\s().-]?){9,}\d/;
const INJECTION = /ignore (all |any )?(previous|prior|above) instructions|you are (now )?an? (ai|assistant)|system prompt|score (this|it) (100|highly)|(always|must) (answer|choose|pick) ["']?[ab]\b/i;
const BOOL = new Set(["true", "false"]);
const HARD = ["Enough rows", "Matches schema", "No personal data", "No prompt injection"];

/** Deterministic checks over every row. Returns checks plus a 0-100 structural score. Any hard failure forces rejection. */
export function structuralChecks(rows: Row[], parseErrors: number, spec: Spec) {
  const checks: Check[] = [];
  const fieldNames = Object.keys(spec.fields);
  const optional = new Set(spec.optional);
  const answer = answerField(spec);

  checks.push({ name: "Parses cleanly", ok: parseErrors === 0, detail: parseErrors ? `${parseErrors} unparseable lines` : `${spec.format.toUpperCase()} OK` });
  checks.push({ name: "Enough rows", ok: rows.length >= spec.minRows, detail: `${rows.length} rows (min ${spec.minRows})` });

  const badSchema = rows.filter((r) =>
    fieldNames.some((f) => {
      const v = r[f], t = spec.fields[f];
      if (v === undefined || v === null || v === "") return !optional.has(f);
      const kind = kindOf(t);
      if (kind === "labels") return !labelsOfType(t).includes(String(v));
      if (kind === "number") return typeof v === "boolean" || Number.isNaN(Number(v));
      if (kind === "boolean") return !BOOL.has(String(v).toLowerCase());
      return typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean";
    }),
  ).length;
  checks.push({ name: "Matches schema", ok: badSchema === 0, detail: badSchema ? `${badSchema} rows with missing or invalid fields` : `has fields ${fieldNames.join(", ")}` });

  const keys = rows.map((r) => inputKey(r, spec));
  const dupes = keys.length - new Set(keys).size;
  checks.push({ name: "No duplicates", ok: dupes <= Math.floor(rows.length * 0.05), detail: `${dupes} duplicate rows` });

  // Personal data and injection can hide in any field, answers included.
  const texts = rows.map((r) => fieldNames.map((f) => String(r[f] ?? "")).join("\n"));
  const pii = texts.filter((t) => EMAIL.test(t) || PHONE.test(t)).length;
  checks.push({ name: "No personal data", ok: pii === 0, detail: pii ? `${pii} rows look like they contain emails or phone numbers` : "no emails or phone numbers found" });

  const inj = texts.filter((t) => INJECTION.test(t)).length;
  checks.push({ name: "No prompt injection", ok: inj === 0, detail: inj ? `${inj} rows try to instruct the AI verifier` : "clean" });

  if (spec.task === "preference") {
    const same = rows.filter((r) => String(r.response_a ?? "").trim() === String(r.response_b ?? "").trim()).length;
    checks.push({ name: "Responses differ", ok: same <= Math.floor(rows.length * 0.02), detail: `${same} rows with identical responses` });
  }

  // Only the checked answer has to be balanced. Other label fields (language, source) may be skewed on purpose.
  const labels = answer ? labelsOfType(spec.fields[answer] ?? "") : [];
  if (answer && labels.length) {
    const f = answer;
    const counts = labels.map((l) => rows.filter((r) => String(r[f]) === l).length);
    const maxShare = rows.length ? Math.max(...counts) / rows.length : 1;
    checks.push({ name: `Balanced "${f}"`, ok: maxShare <= 0.75, detail: labels.map((l, i) => `${counts[i]} ${l}`).join(", ") });
  }

  const passed = checks.filter((c) => c.ok).length;
  const hardFail = checks.some((c) => !c.ok && HARD.includes(c.name));
  return { checks, structuralScore: Math.round((passed / checks.length) * 100), hardFail };
}

/**
 * Deterministic sample of k indexes from n, seeded by a hex string. The seed is a block hash that nobody knew at
 * submission time, and anyone can rerun this to see which rows were picked.
 */
export function sampleIndexes(n: number, k: number, seedHex: string, exclude = new Set<number>()): number[] {
  const all = [...Array(n).keys()].filter((i) => !exclude.has(i));
  // xorshift128 seeded from 16 bytes of the seed.
  const s = [0, 1, 2, 3].map((i) => parseInt(seedHex.slice(i * 8, i * 8 + 8).padEnd(8, "0"), 16) >>> 0 || i + 1);
  const next = () => {
    let t = s[3];
    const x = s[0];
    s[3] = s[2], s[2] = s[1], s[1] = x;
    t ^= t << 11;
    t ^= t >>> 8;
    s[0] = (t ^ x ^ (x >>> 19)) >>> 0;
    return s[0];
  };
  for (let i = all.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.slice(0, Math.min(k, all.length)).sort((a, b) => a - b);
}
