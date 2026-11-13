// Shapes shared by the public server, the enclave and the web UI.

/**
 * What the AI redoes blind for each row.
 * classification  picks a label from a closed set
 * qa              answers the question (short final answers)
 * preference      picks the better of two responses
 */
export type TaskType = "classification" | "qa" | "preference";

/** Who can get the file key after payout. public publishes it. requester hands it only to the bounty's requester. */
export type Access = "public" | "requester";

/** auto lets the enclave decide. manual lets the bounty's requester decide on a sample, with auto as the fallback. */
export type ReviewMode = "auto" | "manual";

/** Bounty spec stored as JSON in the on-chain bounty description. Fields after `guidelines` are optional for old bounties. */
export interface DatasetSpec {
  title: string;
  format: "jsonl" | "csv";
  /** field name -> "string" | "number" | "boolean" | "a|b|c" (one of these labels). The requester defines them. */
  fields: Record<string, string>;
  minRows: number;
  guidelines: string;
  task?: TaskType;
  review?: ReviewMode;
  /** Account that proposed the bounty. Checked against the AddBounty proposal before it may review. */
  requester?: string;
  /** Share of AI-checked rows that must match the submitted answer. */
  minAgreement?: number;
  /** Random rows shown to the requester in manual review. */
  sampleSize?: number;
  /** Hours the requester has to decide before auto review takes over. */
  reviewHours?: number;
  /** Who can decrypt the dataset after payout. Defaults to public. */
  access?: Access;
  /** Field the AI redoes blind and compares. Empty means no answer is checked. Fixed for qa and preference. */
  answer?: string;
  /** Fields a row may leave empty. */
  optional?: string[];
  /** What each field should hold, in the requester's words. Shown to contributors and to the AI. */
  notes?: Record<string, string>;
}

/** JSON stored in the bounty_done proposal description. */
export interface SubmissionRef {
  /** Version 1 means encrypted. Absent means a legacy plaintext link. */
  v?: 1;
  /** IPFS CID of the encrypted file. */
  cid?: string;
  /** https link to the encrypted file, used when there is no CID. */
  url?: string;
  /** sha256 of the plaintext dataset. */
  sha256: string;
  /** File key sealed to the enclave's public key (base64). */
  key?: string;
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

/** One AI-checked row. Contains dataset content, which is why it is never part of the public verdict. */
export interface RowJudgement {
  row: number;
  text: string;
  submittedLabel: string;
  aiLabel: string;
  agrees: boolean;
  reason: string;
}

/** Public verdict. It holds no dataset rows until the file key is released. */
export interface Verdict {
  proposalId?: number;
  bountyId: number;
  contributor?: string;
  cid?: string;
  url: string;
  sha256: string;
  rows: number;
  task: TaskType;
  mode: ReviewMode;
  encrypted: boolean;
  /** Block whose hash seeded the sample. Anyone can reproduce the sample from it. */
  seed?: { height: number; hash: string };
  checks: Check[];
  structuralScore: number;
  ai?: {
    model: string;
    completionIds: string[];
    /** Rows the AI redid blind. Equal to `rows` when the whole file was scanned. */
    scanned: number;
    fullScan: boolean;
    hasLabels: boolean;
    agreement: number;
    qualityScore: number;
    summary: string;
    /** Rows the AI disagreed with. */
    flagged: number;
  };
  aiError?: string;
  score: number;
  decision: "approve" | "reject" | "review";
  reasons: string[];
  createdAt: string;
  /** Manual review state. */
  review?: {
    requester?: string;
    deadline: string;
    sampleRows: number;
    decision?: "approve" | "reject";
    decidedBy?: string;
    decidedAt?: string;
    /** True when the requester did not decide in time and auto review decided instead. */
    fallback?: boolean;
  };
  /** Auto review's own decision, kept when a manual review overrides it. */
  autoDecision?: "approve" | "reject";
  /** Who can get the file key after payout. */
  access?: Access;
  /** The payout was confirmed and the key is available (to everyone, or to `releaseTo` only). */
  released?: boolean;
  /** Requester-only bounties. The verified requester who may fetch the key. */
  releaseTo?: string;
  /** File key (base64), published once the payout is approved. Public bounties only. */
  releasedKey?: string;
  voteTx?: string;
  voteError?: string;
  /** The enclave stopped retrying and left the proposal to the council. */
  abandoned?: boolean;
}

/** Private part of a verdict. Served sealed to the requester or contributor only. */
export interface VerdictDetails {
  judgements: RowJudgement[];
  /** Rows the requester sees in manual review, as submitted. */
  sample: { row: number; data: Record<string, unknown> }[];
}

/** What the enclave proves about itself. */
export interface Attestation {
  mode: "tee" | "dev";
  accountId: string;
  /** ed25519 key the enclave votes with (ed25519:base58). */
  nearPublicKey: string;
  /** x25519 key contributors seal file keys to (base64). */
  sealPublicKey: string;
  /** hex of nearPublicKey bytes followed by sealPublicKey bytes. Bound into the TDX quote. */
  reportData: string;
  quote?: string;
  eventLog?: string;
  composeHash?: string;
  appId?: string;
  osImageHash?: string;
}

/** Body of a NEP-413 signed request from a wallet. */
export interface SignedRequest {
  accountId: string;
  publicKey: string;
  /** base64 */
  signature: string;
  message: string;
  /** base64 of 32 bytes */
  nonce: string;
  recipient: string;
  callbackUrl?: string;
}

/** The JSON inside SignedRequest.message. */
export interface ReviewMessage {
  app: "datafund";
  dao: string;
  action: "view" | "approve" | "reject" | "key";
  proposalId: number;
  /** ms since epoch */
  ts: number;
}
