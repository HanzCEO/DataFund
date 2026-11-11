// Bounty spec parsing and the rules every task type follows. Used by the server, the enclave and the UI.
import type { Access, DatasetSpec, TaskType } from "./types";

/** Fields a task needs, with their type. Classification keeps free-form fields. */
export const TASK_FIELDS: Record<Exclude<TaskType, "classification">, Record<string, string>> = {
  qa: { question: "string", answer: "string" },
  preference: { prompt: "string", response_a: "string", response_b: "string", preferred: "a|b" },
};

export const TASK_INFO: Record<TaskType, { name: string; blind: string; answer: string; minAgreement: number }> = {
  classification: { name: "Classification", blind: "picks a label", answer: "Label", minAgreement: 0.8 },
  qa: { name: "Question and answer", blind: "answers each question", answer: "Answer", minAgreement: 0.6 },
  preference: { name: "Preference pairs", blind: "picks the better response", answer: "Preferred", minAgreement: 0.7 },
};

/** Smallest sample a requester sees, and the share of a file any one review may show. */
export const MIN_SAMPLE = 100;
export const MAX_DISCLOSURE = 0.2;
/** Manual bounties need enough rows that a sample stays a small part of the file. */
export const MANUAL_MIN_ROWS = Math.ceil(MIN_SAMPLE / MAX_DISCLOSURE);
/** Proposals expire after 72 h on this DAO. Review has to end well before that. */
export const MAX_REVIEW_HOURS = 60;

export const ACCESS_INFO: Record<Access, string> = {
  public: "Public after payout",
  requester: "Requester only",
};

export function parseSpec(description: string): Required<DatasetSpec> {
  const s = JSON.parse(description);
  if (!s || typeof s !== "object" || !s.title || !s.fields || !s.format) throw new Error("Bounty description is not a dataset spec");
  const task: TaskType = s.task ?? "classification";
  if (!(task in TASK_INFO)) throw new Error(`Unknown task type ${task}`);
  if (task !== "classification") {
    for (const [f, t] of Object.entries(TASK_FIELDS[task]))
      if (s.fields[f] !== t) throw new Error(`A ${task} bounty needs the field ${f} (${t})`);
  }
  const review = s.review === "manual" ? "manual" : "auto";
  const access = s.access === "requester" ? "requester" : "public";
  const minRows = Math.max(1, Number(s.minRows) || 1);
  return {
    title: String(s.title),
    format: s.format === "csv" ? "csv" : "jsonl",
    fields: s.fields,
    guidelines: String(s.guidelines ?? ""),
    task,
    review,
    access,
    requester: typeof s.requester === "string" ? s.requester : "",
    minRows: review === "manual" ? Math.max(minRows, MANUAL_MIN_ROWS) : minRows,
    minAgreement: clamp(Number(s.minAgreement) || TASK_INFO[task].minAgreement, 0.3, 1),
    sampleSize: Math.max(MIN_SAMPLE, Math.floor(Number(s.sampleSize) || MIN_SAMPLE)),
    reviewHours: clamp(Number(s.reviewHours) || 48, 1, MAX_REVIEW_HOURS),
  };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** The field holding the submitted answer for a task, if any. */
export function answerField(spec: DatasetSpec): string | undefined {
  if (spec.task === "qa") return "answer";
  if (spec.task === "preference") return "preferred";
  return Object.keys(spec.fields).find((f) => spec.fields[f].includes("|"));
}

export function labelsOf(spec: DatasetSpec | null | undefined): string[] {
  const f = spec ? answerField(spec) : undefined;
  return f && spec!.fields[f].includes("|") ? spec!.fields[f].split("|") : [];
}
