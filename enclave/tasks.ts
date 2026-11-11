// What the AI sees for each task type and how its blind answer is compared with the submitted one.
import { answerField, labelsOf } from "../shared/spec.js";
import type { Row, Spec } from "./dataset.js";

export interface BlindRow {
  n: number;
  /** Index in the file. */
  row: number;
  /** Fields shown to the model. The submitted answer is never among them. */
  shown: Record<string, string>;
  /** Preference only. True when A and B were swapped before showing them. */
  swap?: boolean;
}

/**
 * Build the blind view of a row. For preference pairs, about half the rows show B first. Models tend to prefer
 * whichever response comes first, and swapping cancels that out.
 */
export function blindRow(spec: Spec, row: Row, rowIndex: number, n: number, seedHex: string): BlindRow {
  const answer = answerField(spec);
  if (spec.task === "preference") {
    const swap = swapBit(seedHex, rowIndex);
    const a = String(row.response_a ?? ""), b = String(row.response_b ?? "");
    return { n, row: rowIndex, swap, shown: { prompt: String(row.prompt ?? ""), response_a: swap ? b : a, response_b: swap ? a : b } };
  }
  const shown = Object.fromEntries(
    Object.keys(spec.fields).filter((f) => f !== answer).map((f) => [f, String(row[f] ?? "")]),
  );
  return { n, row: rowIndex, shown };
}

function swapBit(seedHex: string, i: number): boolean {
  let h = parseInt(seedHex.slice(0, 8), 16) ^ Math.imul(i + 1, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  return ((h ^ (h >>> 13)) & 1) === 1;
}

/** One line telling the model what to produce for each row. */
export function instruction(spec: Spec): string {
  if (spec.task === "qa") return 'For each row, answer the question yourself. Give only the short final answer (a number, name or short phrase) in "answer".';
  if (spec.task === "preference") return 'For each row, decide which response better answers the prompt and follows the guidelines. Put "a" or "b" in "answer".';
  const labels = labelsOf(spec);
  const f = answerField(spec);
  return f ? `For each row, choose the correct "${f}" from ${labels.join(", ")} and put it in "answer".` : 'Put "-" in "answer" for each row.';
}

/** The submitted answer, in the same terms as the model's. */
export const submitted = (spec: Spec, row: Row) => {
  const f = answerField(spec);
  return f ? String(row[f] ?? "") : "";
};

/** Map the model's answer back to the file's terms (undoes the preference swap). */
export function unblind(spec: Spec, b: BlindRow, ai: string): string {
  const v = ai.trim();
  if (spec.task === "preference") {
    const ab = v.toLowerCase().replace(/[^ab]/g, "").slice(0, 1);
    if (!ab) return v;
    return b.swap ? (ab === "a" ? "b" : "a") : ab;
  }
  return v;
}

/** true, false, or "unsure" when only a second model call can tell (free-form QA answers). */
export function compare(spec: Spec, sub: string, ai: string): boolean | "unsure" {
  if (!answerField(spec)) return true;
  if (spec.task !== "qa") return sub.trim().toLowerCase() === ai.trim().toLowerCase();
  const a = normAnswer(sub), b = normAnswer(ai);
  if (a === b) return true;
  const x = asNumber(sub), y = asNumber(ai);
  if (x !== undefined && y !== undefined) return Math.abs(x - y) <= 1e-6 * Math.max(1, Math.abs(x), Math.abs(y));
  if (!a || !b) return false;
  return "unsure";
}

function normAnswer(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\b(the|a|an)\b/g, " ")
    .replace(/[^\p{L}\p{N}.\-/ ]/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/\.$/, "")
    .trim();
}

function asNumber(s: string): number | undefined {
  const m = s.replace(/,/g, "").match(/^\s*[-+]?\$?\s*(\d+(\.\d+)?|\.\d+)\s*%?\s*$/);
  if (!m) return undefined;
  const n = Number(s.replace(/[^\d.+-]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}
