// Everything that touches dataset content in the browser. Files are encrypted here before they leave the page,
// and private answers from the enclave come back sealed to a one-time key held only by this page.
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Cpu, Download, ExternalLink, Lock, ShieldAlert, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { decryptFile, encryptFile, fromB64, fromUtf8, openJson, seal, sha256Hex, toB64, utf8, x25519Keypair } from "../../shared/crypto";
import { TASK_INFO } from "../../shared/spec";
import type { DatasetSpec, ProposalView, RowJudgement, SubmissionRef, Verdict, VerdictDetails } from "../../shared/types";
import { api, warmUp, type Attestation, type Bounty, type Config, type RunFn, type State } from "./api";
import { TGAS, callDao, signReview } from "./near";

type Spec = Required<DatasetSpec>;
// Public gateways often rate-limit (HTTP 429). Try several. The file is encrypted and its hash is checked.
const GATEWAYS = ["https://gateway.pinata.cloud", "https://ipfs.io", "https://dweb.link"];

// ---------- Attestation ----------

let attCache: Promise<Attestation> | undefined;
export const getAttestation = () => (attCache ??= api<Attestation>("/api/enclave/attestation").catch((e) => ((attCache = undefined), Promise.reject(e))));

/**
 * Whether the DAO approved this exact enclave. The seal key must appear in an approved AddMemberToRole proposal
 * that put the enclave's account in the verifier role. A tampered page or server can't fake a DAO vote.
 */
export function approvalOf(att: Attestation | undefined, state: State): { approved: boolean; proposal?: ProposalView; inRole: boolean } {
  if (!att) return { approved: false, inRole: false };
  const inRole = state.verifiers.includes(att.accountId);
  const proposal = state.proposals.find(
    (p) =>
      p.status === "Approved" && typeof p.kind === "object" && p.kind.AddMemberToRole?.member_id === att.accountId &&
      p.kind.AddMemberToRole?.role === "verifier" && p.description.includes(att.sealPublicKey),
  );
  return { approved: inRole && !!proposal, proposal, inRole };
}

export function useAttestation() {
  const [att, setAtt] = useState<Attestation>();
  const [err, setErr] = useState("");
  useEffect(() => {
    getAttestation().then(setAtt, (e) => setErr((e as Error).message));
  }, []);
  return { att, err };
}

const PHASE: Record<State["enclave"], string> = { awake: "Awake", asleep: "Asleep", waking: "Waking up", stopping: "Going to sleep", unknown: "Checking" };

export function EnclavePanel({ cfg, state }: { cfg: Config; state: State }) {
  const { att, err } = useAttestation();
  const { approved, proposal, inRole } = approvalOf(att, state);
  const short = (s?: string) => (s ? `${s.slice(0, 10)}…${s.slice(-6)}` : "None");
  return (
    <section id="enclave" className="panel">
      <header className="panel-head">
        <h2>Verifier enclave</h2>
        <span className={`tag ${att?.mode === "tee" ? "" : "warn"}`}>{att ? (att.mode === "tee" ? "Intel TDX" : "Dev mode") : err ? "Offline" : "…"}</span>
      </header>
      {cfg.scaling && (
        <p className="small muted enclave-phase">
          <span className={`status ${state.enclave === "awake" ? "s-Approved" : state.enclave === "waking" ? "s-InProgress" : ""}`}>{PHASE[state.enclave]}</span>{" "}
          {state.enclave === "awake" ? "Shuts down after a quiet spell to save cost." : "Starts on demand. The first request waits about a minute."}
        </p>
      )}
      <ul className="enclave-facts small">
        <li>
          {approved ? <ShieldCheck size={16} aria-hidden /> : <ShieldAlert size={16} aria-hidden className="warn-icon" />}
          <span>
            {approved ? (
              <>Approved by DAO vote in proposal <b className="num">{proposal!.id}</b></>
            ) : inRole ? (
              "In the verifier role, but no approved proposal names this seal key"
            ) : (
              "Not approved by the DAO yet. It can't vote on payouts"
            )}
          </span>
        </li>
        <li>
          <Lock size={16} aria-hidden />
          <span>Only this enclave can decrypt submissions. Datasets are encrypted in your browser and the key opens after payout.</span>
        </li>
        <li>
          <Cpu size={16} aria-hidden />
          <span>
            {cfg.aiEnabled ? <>AI checks run on <code>{cfg.model}</code> in NEAR AI's TEE</> : "AI checks are off (no NEAR AI key)"}
          </span>
        </li>
      </ul>
      <details className="more">
        <summary>Attestation</summary>
        <dl className="brief small">
          <dt>Account</dt>
          <dd><a href={`${cfg.explorer}/address/${att?.accountId}`} target="_blank" rel="noreferrer" className="num">{short(att?.accountId)}</a></dd>
          <dt>Seal key</dt><dd className="num">{short(att?.sealPublicKey)}</dd>
          <dt>Compose hash</dt><dd className="num">{short(att?.composeHash)}</dd>
          <dt>App id</dt><dd className="num">{short(att?.appId)}</dd>
          <dt>TDX quote</dt><dd>{att?.quote ? `${att.quote.length / 2} bytes` : "None (dev mode)"}</dd>
        </dl>
        <p className="small muted">
          The quote's report data is the enclave's NEAR key followed by its seal key. Check it with Phala's verifier and compare the
          compose hash with the one in the approval proposal. <a href="/api/enclave/attestation" target="_blank" rel="noreferrer">Raw attestation</a>
        </p>
      </details>
      {att?.mode === "dev" && <p className="small err">Dev mode keeps keys in a local file. Use it for testing only.</p>}
    </section>
  );
}

// ---------- Submitting ----------

const SAMPLES: Record<Spec["task"], [string, string][]> = {
  classification: [["good dataset", "sms-scam-good"], ["bad dataset", "sms-scam-bad"], ["mislabeled dataset", "sms-scam-mislabeled"], ["600 rows", "sms-scam-large"], ["facade", "sms-scam-facade"]],
  qa: [["good answers", "qa-good"], ["wrong answers", "qa-wrong"]],
  preference: [["good pairs", "pref-good"], ["flipped preferences", "pref-flipped"]],
};

type Sealed = { content: string; key: Uint8Array; blob: Uint8Array; sha256: string; sealedKey: string };

export function SubmitPanel({ b, spec, cfg, state, run }: { b: Bounty; spec: Spec; cfg: Config; state: State; run: RunFn }) {
  const { att, err: attErr } = useAttestation();
  const [mode, setMode] = useState<"ipfs" | "link">(cfg.pinning ? "ipfs" : "link");
  const [content, setContent] = useState("");
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<{ verdict: Verdict; details: VerdictDetails }>();
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const sealed = useRef<Sealed>(undefined);
  const { approved } = approvalOf(att, state);
  // Opening the form starts a sleeping enclave. It's usually awake by the time the file is ready.
  useEffect(() => {
    if (cfg.scaling) warmUp();
  }, [cfg.scaling]);
  const sleepy = cfg.scaling && state.enclave !== "awake";

  // One encryption per content. The hosted file, the precheck and the on-chain key must all match.
  const encrypt = async (): Promise<Sealed> => {
    if (!att) throw new Error(attErr || "Enclave not reachable");
    if (sealed.current?.content === content) return sealed.current;
    const plain = utf8(content);
    if (cfg.maxBytes && plain.length > cfg.maxBytes) throw new Error(`Dataset larger than ${cfg.maxBytes / 1024 / 1024} MB`);
    const { key, blob } = await encryptFile(plain);
    sealed.current = { content, key, blob, sha256: await sha256Hex(plain), sealedKey: toB64(await seal(fromB64(att.sealPublicKey), key)) };
    return sealed.current;
  };

  const step = async (label: string, f: () => Promise<void>) => {
    setBusy(label);
    setErr("");
    try {
      await f();
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy("");
  };

  const precheck = () =>
    step(sleepy ? "Waking the enclave (about a minute), then checking…" : "Checking in the enclave…", async () => {
      const s = await encrypt();
      const reply = x25519Keypair();
      const r = await api<{ sealed: string }>("/api/enclave/precheck", { bountyId: b.id, blob: toB64(s.blob), key: s.sealedKey, sha256: s.sha256, replyKey: toB64(reply.publicKey) });
      setResult(await openJson(reply.secret, r.sealed));
    });

  const downloadEncrypted = () =>
    step("Encrypting…", async () => {
      const s = await encrypt();
      saveFile(new Blob([s.blob as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" }), `bounty-${b.id}-${s.sha256.slice(0, 8)}.enc`);
    });

  const uploadIpfs = async (s: Sealed): Promise<string> => {
    const { url: signed } = await api<{ url: string }>("/api/enclave/upload-url", {});
    const form = new FormData();
    form.append("network", "public");
    form.append("file", new Blob([s.blob as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" }), "dataset.enc");
    const res = await fetch(signed, { method: "POST", body: form });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.data?.cid) throw new Error(`IPFS upload failed (HTTP ${res.status})`);
    return json.data.cid;
  };

  const submit = () =>
    run("Submit", async () => {
      const s = await encrypt();
      let ref: SubmissionRef;
      if (mode === "ipfs") {
        setBusy("Uploading encrypted file to IPFS…");
        ref = { v: 1, cid: await uploadIpfs(s), sha256: s.sha256, key: s.sealedKey };
      } else {
        if (!/^https:\/\/|^ipfs:\/\//.test(url)) throw new Error("Paste the https or ipfs:// link of the encrypted file you downloaded");
        ref = { v: 1, url, sha256: s.sha256, key: s.sealedKey };
      }
      setBusy("Waiting for your wallet…");
      await callDao(cfg.daoId, "bounty_done", { id: b.id, description: JSON.stringify(ref) }, 0n, 100n * TGAS);
    }).finally(() => setBusy(""));

  const loadSample = async (file: string) => setContent(await (await fetch(`/examples/${file}.jsonl`)).text());
  const loadFile = async (f?: File) => f && setContent(await f.text());

  const rows = useMemo(() => content.split(/\r?\n/).filter((l) => l.trim()).length - (spec.format === "csv" ? 1 : 0), [content, spec.format]);
  const empty = !content.trim();
  return (
    <div className="submit">
      {spec.guidelines && <p className="guidelines">{spec.guidelines}</p>}
      <p className="small muted lock-note">
        <Lock size={14} className="inline-icon" aria-hidden /> Your file is encrypted in this browser. Only the verifier enclave can read it,
        {spec.review === "manual" ? ` and the requester sees at most ${spec.sampleSize} random rows plus rows the AI flags (never over 20%).` : " and nobody else sees a row."}{" "}
        {spec.access === "requester" ? "Once you're paid, only the requester gets the key." : "The key is published once you're paid."}
      </p>
      {att && !approved && <p className="small err">This enclave is not approved by the DAO. Its votes won't count until the council adds it to the verifier role.</p>}
      <textarea
        rows={8}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={spec.format === "jsonl" ? JSON.stringify(Object.fromEntries(Object.keys(spec.fields).map((f) => [f, "…"]))) : Object.keys(spec.fields).join(",")}
        aria-label="Dataset"
      />
      <div className="row samples">
        <label className="link file-pick">
          Open a file
          <input type="file" accept=".jsonl,.csv,.txt,.json" onChange={(e) => loadFile(e.target.files?.[0])} />
        </label>
        <span className="muted">or try</span>
        {SAMPLES[spec.task].map(([label, file]) => (
          <button key={file} className="link" onClick={() => loadSample(file)}>{label}</button>
        ))}
        {!empty && <span className="muted num">{rows} rows</span>}
      </div>
      <div className="tabs" role="tablist" aria-label="Where the encrypted file goes">
        <button role="tab" aria-selected={mode === "ipfs"} className={mode === "ipfs" ? "on" : ""} disabled={!cfg.pinning} onClick={() => setMode("ipfs")} title={cfg.pinning ? "" : "IPFS upload is not configured on this enclave"}>
          Upload to IPFS
        </button>
        <button role="tab" aria-selected={mode === "link"} className={mode === "link" ? "on" : ""} onClick={() => setMode("link")}>Host it yourself</button>
      </div>
      {mode === "link" && (
        <div className="row">
          <button className="ghost" disabled={empty || !!busy} onClick={downloadEncrypted}>
            <Download size={16} aria-hidden /> Download encrypted file
          </button>
          <input className="grow" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://… or ipfs://… link to that file" aria-label="Encrypted file link" />
        </div>
      )}
      <div className="row">
        <button className="ghost" disabled={empty || !!busy} onClick={precheck}>Precheck (free, no vote)</button>
        <button disabled={empty || !!busy || (mode === "link" && !url)} onClick={submit}>Submit on-chain</button>
        {busy && <span className="small muted">{busy}</span>}
      </div>
      {err && <p className="err">{err}</p>}
      {result && <VerdictView v={result.verdict} cfg={cfg} details={result.details} precheck />}
    </div>
  );
}

function saveFile(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- Verdicts ----------

const decisionText: Record<Verdict["decision"], string> = { approve: "Approve payout", reject: "Reject", review: "Waiting for the requester" };

export function VerdictView({ v, cfg, details, account, precheck }: { v: Verdict; cfg: Config; details?: VerdictDetails; account?: string | null; precheck?: boolean }) {
  const task = v.task ?? "classification";
  // Old verdicts kept their judgements in public. New ones only show them to the requester or contributor.
  const legacy = (v.ai as { judgements?: RowJudgement[] } | undefined)?.judgements;
  const judgements = details?.judgements ?? legacy;
  const scanned = v.ai ? v.ai.scanned ?? (v.ai as any).sampled : 0;
  return (
    <div className="verdict">
      <div className="verdict-head">
        <span className={`score big-score ${v.decision}`}>{v.score}</span>
        <div>
          <strong>{precheck && v.decision !== "review" ? `Would ${v.decision}` : decisionText[v.decision]}</strong>
          <div className="muted small num">
            {[
              `${v.rows} rows`,
              `sha256 ${v.sha256.slice(0, 12)}…`,
              `structural ${v.structuralScore}`,
              v.ai && `${TASK_INFO[task].answer.toLowerCase()} agreement ${Math.round(v.ai.agreement * 100)}% on ${v.ai.fullScan ? "every row" : `${scanned} rows`}`,
              v.ai && `quality ${v.ai.qualityScore}`,
              v.encrypted && "encrypted",
              v.seed && `seed block ${v.seed.height}`,
            ].filter(Boolean).join(", ")}
          </div>
        </div>
      </div>
      <ul className="checks">
        {v.checks.map((c) => (
          <li key={c.name} className={c.ok ? "ok" : "bad"}>
            {c.ok ? <Check size={16} aria-label="passed" /> : <X size={16} aria-label="failed" />} <b>{c.name}</b> <span className="muted">{c.detail}</span>
          </li>
        ))}
      </ul>
      {v.ai && (
        <div className="ai">
          <p>
            <b>AI review</b>{" "}
            <span className="muted small">
              ({v.ai.model}, {v.ai.fullScan ? `all ${scanned} rows` : `${scanned} random rows`} redone blind, {v.ai.flagged ?? 0} flagged)
            </span>
          </p>
          <p>{v.ai.summary}</p>
          {judgements && judgements.length > 0 && <JudgementTable rows={judgements} task={task} limit={precheck ? 12 : 40} />}
        </div>
      )}
      {v.aiError && <p className="err small">AI review failed ({v.aiError})</p>}
      {v.review && (
        <p className="small">
          {v.review.decision
            ? <>Requester <b>{v.review.decidedBy}</b> chose to {v.review.decision}.</>
            : v.review.fallback
              ? <>Auto review decided because the requester didn't.</>
              : <>Requester <b>{v.review.requester ?? "unknown"}</b> has until {new Date(v.review.deadline).toLocaleString()} to review {v.review.sampleRows} rows. After that, auto review ({v.autoDecision}) decides.</>}
        </p>
      )}
      <ul className="small reasons">
        {v.reasons.map((r) => <li key={r}>{r}</li>)}
      </ul>
      {!precheck && v.proposalId !== undefined && account && <ReviewPanel v={v} cfg={cfg} account={account} />}
      {(v.releasedKey || (v.released && v.access === "requester")) && <DownloadDataset v={v} cfg={cfg} account={account} />}
      {v.voteTx && (
        <a className="small" href={`${cfg.explorer}/txns/${v.voteTx}`} target="_blank" rel="noreferrer">
          Verifier vote transaction <ExternalLink className="inline-icon" size={14} aria-hidden />
        </a>
      )}
      {v.voteError && <p className="err small">Vote pending ({v.voteError})</p>}
    </div>
  );
}

function JudgementTable({ rows, task, limit }: { rows: RowJudgement[]; task: Spec["task"]; limit: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, limit);
  const head = task === "qa" ? "Question" : task === "preference" ? "Prompt" : "Text";
  return (
    <>
      <table>
        <thead>
          <tr><th>Row</th><th>{head}</th><th>Submitted</th><th>AI</th></tr>
        </thead>
        <tbody>
          {shown.map((j) => (
            <tr key={j.row} className={j.agrees ? "" : "disagree"}>
              <td className="num">{j.row}</td>
              <td title={j.reason}>{j.text}</td>
              <td>{j.submittedLabel}</td>
              <td>
                {j.aiLabel}
                {!j.agrees && <TriangleAlert className="inline-icon" size={14} aria-label="disagrees" />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > limit && (
        <button className="link small" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${rows.length} rows`}</button>
      )}
    </>
  );
}

/** The requester reviews a sample and decides. The contributor can read the AI's notes on their own file. */
function ReviewPanel({ v, cfg, account }: { v: Verdict; cfg: Config; account: string }) {
  const role = account === v.review?.requester ? "requester" : account === v.contributor ? "contributor" : undefined;
  const [details, setDetails] = useState<VerdictDetails>();
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  if (!role || (role === "requester" && v.decision !== "review" && !details)) return null;
  if (role === "contributor" && !v.encrypted) return null;

  const message = (action: "view" | "approve" | "reject") => ({ app: "datafund", dao: cfg.daoId, action, proposalId: v.proposalId!, ts: Date.now() });
  const act = async (label: string, f: () => Promise<void>) => {
    setBusy(label);
    setErr("");
    try {
      await f();
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy("");
  };
  const open = () =>
    act("Sign in your wallet…", async () => {
      const request = await signReview(cfg.daoId, message("view"));
      const reply = x25519Keypair();
      const r = await api<{ sealed: string }>("/api/enclave/review", { request, replyKey: toB64(reply.publicKey) });
      setDetails(await openJson(reply.secret, r.sealed));
    });
  const decide = (action: "approve" | "reject") =>
    act("Sign in your wallet…", async () => {
      const request = await signReview(cfg.daoId, message(action));
      await api("/api/enclave/review/decide", { request });
      setBusy("");
      setErr(`Sent. The enclave votes ${action} within a few seconds.`);
    });

  const byRow = new Map((details?.judgements ?? []).map((j) => [j.row, j]));
  const cols = details?.sample[0] ? Object.keys(details.sample[0].data) : [];
  return (
    <div className="review">
      {!details ? (
        <div className="row">
          <button className="ghost" disabled={!!busy} onClick={open}>
            {role === "requester" ? `Review ${v.review?.sampleRows ?? ""} sample rows` : "See the AI's notes on my file"}
          </button>
          <span className="small muted">{busy || "Signing is free and private. Rows come back encrypted to this page."}</span>
        </div>
      ) : role === "requester" ? (
        <>
          <p className="small muted">
            {details.sample.length} rows from the encrypted file. Random rows come from a block hash nobody knew at submission, and
            rows marked <TriangleAlert size={12} className="inline-icon" aria-label="flagged" /> are ones the AI disagreed with.
          </p>
          <div className="table-wrap review-table">
            <table>
              <thead>
                <tr><th>Row</th>{cols.map((c) => <th key={c}>{c}</th>)}<th>AI</th></tr>
              </thead>
              <tbody>
                {details.sample.map((s) => {
                  const j = byRow.get(s.row);
                  return (
                    <tr key={s.row} className={j && !j.agrees ? "disagree" : ""}>
                      <td className="num">{s.row}</td>
                      {cols.map((c) => <td key={c}>{String(s.data[c] ?? "")}</td>)}
                      <td title={j?.reason}>{j ? <>{j.aiLabel}{!j.agrees && <TriangleAlert className="inline-icon" size={14} aria-label="disagrees" />}</> : <span className="muted">None</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {v.decision === "review" && (
            <div className="row">
              <button disabled={!!busy} onClick={() => decide("approve")}>Approve payout</button>
              <button className="ghost danger" disabled={!!busy} onClick={() => decide("reject")}>Reject</button>
              {busy && <span className="small muted">{busy}</span>}
            </div>
          )}
        </>
      ) : (
        <JudgementTable rows={details.judgements} task={v.task} limit={40} />
      )}
      {err && <p className={err.startsWith("Sent") ? "small" : "err small"}>{err}</p>}
    </div>
  );
}

/**
 * After payout. Public bounties publish the key. Requester-only bounties hand it to the requester, sealed to this
 * page, after a wallet signature. Either way the page fetches the encrypted file, decrypts it here and checks its hash.
 */
function DownloadDataset({ v, cfg, account }: { v: Verdict; cfg: Config; account?: string | null }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const privateFile = !v.releasedKey;
  const mine = !privateFile || (!!account && account === v.releaseTo);

  const keyOf = async (): Promise<Uint8Array> => {
    if (v.releasedKey) return fromB64(v.releasedKey);
    const request = await signReview(cfg.daoId, { app: "datafund", dao: cfg.daoId, action: "key", proposalId: v.proposalId!, ts: Date.now() });
    const reply = x25519Keypair();
    const r = await api<{ sealed: string }>("/api/enclave/key", { request, replyKey: toB64(reply.publicKey) });
    return fromB64((await openJson<{ key: string }>(reply.secret, r.sealed)).key);
  };

  const get = async () => {
    setBusy(true);
    setErr("");
    try {
      const key = await keyOf();
      const urls = v.cid ? GATEWAYS.map((g) => `${g}/ipfs/${v.cid}`) : [v.url.replace(/^ipfs:\/\//, `${GATEWAYS[0]}/ipfs/`)];
      let blob: Uint8Array | undefined;
      for (const u of urls) {
        try {
          const res = await fetch(u);
          if (res.ok) {
            blob = new Uint8Array(await res.arrayBuffer());
            break;
          }
        } catch {
          // next gateway
        }
      }
      if (!blob) throw new Error("No gateway returned the file");
      const plain = await decryptFile(key, blob);
      if ((await sha256Hex(plain)) !== v.sha256) throw new Error("Decrypted file doesn't match the committed hash");
      saveFile(new Blob([fromUtf8(plain)], { type: "text/plain" }), `datafund-${v.proposalId}-${v.sha256.slice(0, 8)}.jsonl`);
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  };
  if (!mine)
    return (
      <p className="small muted">
        <Lock size={14} className="inline-icon" aria-hidden /> Paid out. Only the requester{v.releaseTo ? ` (${v.releaseTo})` : ""} can download this dataset.
      </p>
    );
  return (
    <div className="row">
      <button className="ghost" disabled={busy} onClick={get}>
        <Download size={16} aria-hidden /> {busy ? "Decrypting…" : "Download dataset"}
      </button>
      <span className="small muted">{privateFile ? "Paid out. You sign once and the enclave hands the key to this page only." : "Paid out. The enclave released the key."}</span>
      {err && <span className="err small">{err}</span>}
    </div>
  );
}
