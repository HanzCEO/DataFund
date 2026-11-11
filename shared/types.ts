// Shapes shared by the server and the web UI.

/** Bounty spec stored as JSON in the on-chain bounty description. */
export interface DatasetSpec {
  title: string;
  format: "jsonl" | "csv";
  /** field name -> "string" | "number" | "a|b|c" (allowed labels) */
  fields: Record<string, string>;
  minRows: number;
  guidelines: string;
}

/** JSON stored in the bounty_done proposal description. */
export interface SubmissionRef {
  url: string;
  sha256: string;
  note?: string;
}

export interface BountyView {
  id: number;
  description: string;
  token: string;
  amount: string;
  times: number;
  max_deadline: string;
}

export interface BountyClaim {
  bounty_id: number;
  start_time: string;
  deadline: string;
  completed: boolean;
}

export interface ProposalView {
  id: number;
  proposer: string;
  description: string;
  kind: Record<string, any> | string;
  status: string;
  vote_counts: Record<string, [string, string, string]>;
  votes: Record<string, string>;
  submission_time: string;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface RowJudgement {
  row: number;
  text: string;
  submittedLabel: string;
  aiLabel: string;
  agrees: boolean;
  reason: string;
}

export interface Verdict {
  proposalId?: number;
  bountyId: number;
  contributor?: string;
  url: string;
  sha256: string;
  rows: number;
  checks: Check[];
  structuralScore: number;
  ai?: {
    model: string;
    completionId?: string;
    sampled: number;
    agreement: number;
    qualityScore: number;
    summary: string;
    judgements: RowJudgement[];
  };
  aiError?: string;
  score: number;
  decision: "approve" | "reject";
  reasons: string[];
  createdAt: string;
  voteTx?: string;
  voteError?: string;
}
