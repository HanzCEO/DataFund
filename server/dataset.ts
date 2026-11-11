import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { readFile } from "node:fs/promises";
import { PUBLIC_URL } from "./config.js";
import { uploadPath } from "./store.js";
import type { Check, DatasetSpec } from "../shared/types.js";

export const MAX_BYTES = 2 * 1024 * 1024;

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Fetch a dataset by URL. Our own uploads are read from disk. External URLs are SSRF-guarded. */
export async function fetchDataset(url: string): Promise<string> {
  const own = `${PUBLIC_URL}/api/files/`;
  if (url.startsWith(own)) {
    const name = url.slice(own.length);
    if (!/^[a-f0-9]{64}\.(jsonl|csv)$/.test(name)) throw new Error("Bad file name");
    return readFile(uploadPath(name), "utf8");
  }

  let current = new URL(url);
  for (let hop = 0; hop < 4; hop++) {
    await assertPublicHttps(current);
    const res = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location")!, current);
      continue;
    }
    if (!res.ok) throw new Error(`Fetch failed with HTTP ${res.status}`);
    return readCapped(res);
  }
  throw new Error("Too many redirects");
}

async function assertPublicHttps(u: URL) {
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

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
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
  return Buffer.concat(chunks).toString("utf8");
}

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

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE = /(?:\+?\d[\s().-]?){9,}\d/;
const INJECTION = /ignore (all |any )?(previous|prior|above) instructions|you are (now )?an? (ai|assistant)|system prompt|score (this|it) (100|highly)/i;

/** Deterministic checks. Returns checks plus a 0-100 structural score. Any hard failure forces rejection. */
export function structuralChecks(rows: Row[], parseErrors: number, spec: DatasetSpec) {
  const checks: Check[] = [];
  const fieldNames = Object.keys(spec.fields);
  const enums = Object.fromEntries(
    Object.entries(spec.fields).filter(([, t]) => t.includes("|")).map(([k, t]) => [k, t.split("|")]),
  );

  checks.push({ name: "Parses cleanly", ok: parseErrors === 0, detail: parseErrors ? `${parseErrors} unparseable lines` : `${spec.format.toUpperCase()} OK` });
  checks.push({ name: "Enough rows", ok: rows.length >= spec.minRows, detail: `${rows.length} rows (min ${spec.minRows})` });

  const badSchema = rows.filter((r) =>
    fieldNames.some((f) => {
      const v = r[f], t = spec.fields[f];
      if (v === undefined || v === null || v === "") return true;
      if (enums[f]) return !enums[f].includes(String(v));
      if (t === "number") return Number.isNaN(Number(v));
      return typeof v !== "string" && typeof v !== "number";
    }),
  ).length;
  checks.push({ name: "Matches schema", ok: badSchema === 0, detail: badSchema ? `${badSchema} rows with missing/invalid fields` : `has fields ${fieldNames.join(", ")}` });

  const textField = fieldNames.find((f) => spec.fields[f] === "string") ?? fieldNames[0];
  const norm = rows.map((r) => String(r[textField] ?? "").toLowerCase().replace(/\s+/g, " ").trim());
  const dupes = norm.length - new Set(norm).size;
  checks.push({ name: "No duplicates", ok: dupes <= Math.floor(rows.length * 0.05), detail: `${dupes} duplicate rows` });

  const pii = norm.filter((t) => EMAIL.test(t) || PHONE.test(t)).length;
  checks.push({ name: "No personal data", ok: pii === 0, detail: pii ? `${pii} rows look like they contain emails/phone numbers` : "no emails or phone numbers found" });

  const inj = norm.filter((t) => INJECTION.test(t)).length;
  checks.push({ name: "No prompt injection", ok: inj === 0, detail: inj ? `${inj} rows try to instruct the AI verifier` : "clean" });

  for (const [f, labels] of Object.entries(enums)) {
    const counts = labels.map((l) => rows.filter((r) => String(r[f]) === l).length);
    const maxShare = rows.length ? Math.max(...counts) / rows.length : 1;
    checks.push({
      name: `Balanced "${f}"`,
      ok: maxShare <= 0.75,
      detail: labels.map((l, i) => `${counts[i]} ${l}`).join(", "),
    });
  }

  const passed = checks.filter((c) => c.ok).length;
  const hardFail = checks.some((c) => !c.ok && ["Enough rows", "Matches schema", "No personal data", "No prompt injection"].includes(c.name));
  return { checks, structuralScore: Math.round((passed / checks.length) * 100), hardFail, textField };
}
