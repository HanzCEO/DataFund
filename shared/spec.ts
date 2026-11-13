// Bounty spec parsing and the rules every task type follows. Used by the server, the enclave and the UI.
import type { Access, DatasetSpec, TaskType } from "./types";

/** Fields a task needs, with their type. Requesters may add more fields to any task. */
export const TASK_FIELDS: Record<Exclude<TaskType, "classification">, Record<string, string>> = {
  qa: { question: "string", answer: "string" },
  preference: { prompt: "string", response_a: "string", response_b: "string", preferred: "a|b" },
};

/** Fields a task fixes. Classification fixes none. */
export const taskFields = (task: TaskType): Record<string, string> => (task === "classification" ? {} : TASK_FIELDS[task]);

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

/** How a field type string reads. */
export type FieldKind = "string" | "number" | "boolean" | "labels";

export const FIELD_KINDS: Record<FieldKind, string> = {
  string: "Text",
  number: "Number",
  boolean: "True or false",
  labels: "One of these labels",
};

export const kindOf = (type: string): FieldKind =>
  type.includes("|") ? "labels" : type === "number" || type === "boolean" ? type : "string";

export const labelsOfType = (type: string) => (type.includes("|") ? type.split("|") : []);

/** A field name that works as a JSON key and a CSV header. */
export const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

export function parseSpec(description: string): Required<DatasetSpec> {
  const s = JSON.parse(description);
  if (!s || typeof s !== "object" || !s.title || !s.fields || typeof s.fields !== "object" || !s.format) throw new Error("Bounty description is not a dataset spec");
  const task: TaskType = s.task ?? "classification";
  if (!(task in TASK_INFO)) throw new Error(`Unknown task type ${task}`);
  const fields: Record<string, string> = {};
  for (const [f, t] of Object.entries(s.fields)) {
    if (!FIELD_NAME.test(f)) throw new Error(`Field name ${JSON.stringify(f)} is not allowed`);
    if (typeof t !== "string" || !t) throw new Error(`Field ${f} has no type`);
    if (t.includes("|") && new Set(labelsOfType(t).filter(Boolean)).size < 2) throw new Error(`Field ${f} needs at least two labels`);
    fields[f] = t;
  }
  if (!Object.keys(fields).length) throw new Error("A dataset spec needs at least one field");
  if (task !== "classification") {
    for (const [f, t] of Object.entries(TASK_FIELDS[task]))
      if (fields[f] !== t) throw new Error(`A ${task} bounty needs the field ${f} (${t})`);
  }
  const answer = task === "classification" ? classificationAnswer(fields, s.answer) : task === "qa" ? "answer" : "preferred";
  const optional = (Array.isArray(s.optional) ? (s.optional as unknown[]) : []).filter(
    (f: unknown): f is string => typeof f === "string" && f in fields && f !== answer && !(task !== "classification" && f in TASK_FIELDS[task]),
  );
  const notes = Object.fromEntries(
    Object.entries(s.notes && typeof s.notes === "object" ? s.notes : {})
      .filter(([f, n]) => f in fields && typeof n === "string" && n.trim())
      .map(([f, n]) => [f, (n as string).trim().slice(0, 500)]),
  );
  const review = s.review === "manual" ? "manual" : "auto";
  const access = s.access === "requester" ? "requester" : "public";
  const minRows = Math.max(1, Number(s.minRows) || 1);
  return {
    title: String(s.title),
    format: s.format === "csv" ? "csv" : "jsonl",
    fields,
    answer,
    optional: [...new Set(optional)],
    notes,
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

/** Classification checks a label field. Old specs without `answer` use their first label field. */
function classificationAnswer(fields: Record<string, string>, answer: unknown): string {
  if (answer === "") return "";
  if (typeof answer === "string") {
    if (!(answer in fields)) throw new Error(`The answer field ${answer} is not in the spec`);
    if (kindOf(fields[answer]) !== "labels") throw new Error(`The answer field ${answer} must be a set of labels`);
    return answer;
  }
  return Object.keys(fields).find((f) => kindOf(fields[f]) === "labels") ?? "";
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** The field holding the submitted answer for a task, if any. */
export function answerField(spec: DatasetSpec): string | undefined {
  if (spec.task === "qa") return "answer";
  if (spec.task === "preference") return "preferred";
  if (spec.answer !== undefined) return spec.answer || undefined;
  return Object.keys(spec.fields).find((f) => spec.fields[f].includes("|"));
}

export function labelsOf(spec: DatasetSpec | null | undefined): string[] {
  const f = spec ? answerField(spec) : undefined;
  return f ? labelsOfType(spec!.fields[f] ?? "") : [];
}
