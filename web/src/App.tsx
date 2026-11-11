import { useCallback, useEffect, useMemo, useState } from "react";
import type { BountyClaim, BountyView, DatasetSpec, ProposalView, Verdict } from "../../shared/types";
import { TGAS, callDao, chipIn, currentAccount, initWallet, showSignIn, signOut, toNear, toYocto } from "./near";

type Config = { daoId: string; network: string; explorer: string; verifier: string; aiEnabled: boolean; model: string; minScore: number };
type Bounty = BountyView & { claims: number; spec: DatasetSpec | null };
type State = {
  available: string;
  total: string;
  council: string[];
  bountyBond: string;
  proposalBond: string;
  bounties: Bounty[];
  proposals: ProposalView[];
  verdicts: Record<string, Verdict>;
};

const api = async <T,>(path: string, body?: unknown): Promise<T> => {
  const res = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
};

export default function App() {
  const [cfg, setCfg] = useState<Config>();
  const [state, setState] = useState<State>();
  const [account, setAccount] = useState<string | null>(null);
  const [claims, setClaims] = useState<BountyClaim[]>([]);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string }>();
  const [loadErr, setLoadErr] = useState("");

  const refresh = useCallback(async () => {
    try {
      setState(await api<State>("/api/state"));
      setLoadErr("");
    } catch (e) {
      setLoadErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    api<Config>("/api/config").then(async (c) => {
      setCfg(c);
      const sel = await initWallet(c.network, c.daoId);
      setAccount(await currentAccount());
      sel.store.observable.subscribe(async () => setAccount(await currentAccount()));
    });
    refresh();
    const t = setInterval(refresh, 6000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (!account) return setClaims([]);
    api<BountyClaim[]>(`/api/claims/${account}`).then(setClaims).catch(() => setClaims([]));
  }, [account, state]);

  const run = useCallback(
    async (label: string, f: () => Promise<unknown>) => {
      try {
        await f();
        setToast({ kind: "ok", msg: `${label}: done` });
        setTimeout(refresh, 1500);
      } catch (e) {
        setToast({ kind: "err", msg: `${label}: ${(e as Error).message}` });
      }
      setTimeout(() => setToast(undefined), 6000);
    },
    [refresh],
  );

  if (!cfg || !state) return <div className="loading">{loadErr ? `Couldn't load chain data: ${loadErr.slice(0, 200)}. Retrying…` : "Loading DataFund…"}</div>;
  const isCouncil = !!account && state.council.includes(account);

  return (
    <>
      <header className="top">
        <div className="brand">
          <span className="logo" aria-hidden>≡</span>
          <div>
            <strong>DataFund</strong>
            <small>community-funded datasets on NEAR</small>
          </div>
        </div>
        <div className="top-right">
          <span className="pill">{cfg.network}</span>
          {account ? (
            <button className="ghost" onClick={() => signOut()} title="Sign out">
              {account}
              {isCouncil && <span className="tag">council</span>}
            </button>
          ) : (
            <button onClick={showSignIn}>Connect wallet</button>
          )}
        </div>
      </header>

      <main>
        <Steps />

        <section className="grid2">
          <Treasury cfg={cfg} state={state} account={account} run={run} />
          <VerifierCard cfg={cfg} />
        </section>

        <section>
          <div className="section-head">
            <h2>Open bounties</h2>
            <span className="muted">Claim one, submit your data, and get paid automatically if it passes.</span>
          </div>
          <div className="bounties">
            {state.bounties.filter((b) => b.times > 0).map((b) => (
              <BountyCard key={b.id} b={b} cfg={cfg} state={state} account={account} claim={claims.find((c) => c.bounty_id === b.id)} run={run} />
            ))}
            {!state.bounties.some((b) => b.times > 0) && <p className="muted">No open bounties yet. Propose one below.</p>}
          </div>
        </section>

        <ProposeBounty cfg={cfg} state={state} account={account} run={run} />

        <section>
          <div className="section-head">
            <h2>Activity</h2>
            <span className="muted">Every proposal and vote lives in the Sputnik DAO contract.</span>
          </div>
          <div className="activity">
            {state.proposals.map((p) => (
              <ProposalRow key={p.id} p={p} cfg={cfg} state={state} isCouncil={isCouncil} verdict={state.verdicts[p.id]} run={run} />
            ))}
          </div>
        </section>
      </main>

      <footer>
        DAO <a href={`${cfg.explorer}/address/${cfg.daoId}`} target="_blank" rel="noreferrer">{cfg.daoId}</a> · Built for NEAR HACKATHON 2026
      </footer>
      {toast && <div className={`toast ${toast.kind}`}>{toast.msg}</div>}
    </>
  );
}

function Steps() {
  const steps = [
    ["Chip in", "Anyone sends NEAR to the community treasury."],
    ["Fund a bounty", "Members propose a dataset; the council votes it in."],
    ["Contribute", "Contributors claim the bounty and submit their data."],
    ["AI verifies & pays", "The verifier checks the data and its vote releases the payout."],
  ];
  return (
    <ol className="steps">
      {steps.map(([t, d], i) => (
        <li key={t}>
          <span className="num">{i + 1}</span>
          <div>
            <strong>{t}</strong>
            <p>{d}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

type RunFn = (label: string, f: () => Promise<unknown>) => Promise<void>;

function Treasury({ cfg, state, account, run }: { cfg: Config; state: State; account: string | null; run: RunFn }) {
  const [amount, setAmount] = useState("1");
  const reserved = state.bounties.reduce((s, b) => s + BigInt(b.amount) * BigInt(b.times), 0n);
  return (
    <div className="card">
      <h3>Community treasury</h3>
      <div className="big">{toNear(state.available)} <span>NEAR available</span></div>
      <p className="muted small">
        {toNear(reserved)} NEAR promised to open bounties · {toNear(BigInt(state.total) - BigInt(state.available))} NEAR locked for contract storage
      </p>
      <div className="row">
        <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" aria-label="Amount in NEAR" />
        <button disabled={!account} onClick={() => run("Chip in", () => chipIn(cfg.daoId, toYocto(amount)))}>
          Chip in
        </button>
      </div>
      {!account && <p className="muted small">Connect a wallet to chip in.</p>}
      <p className="muted small">Council: {state.council.join(", ")}</p>
    </div>
  );
}

function VerifierCard({ cfg }: { cfg: Config }) {
  return (
    <div className="card">
      <h3>AI verifier</h3>
      <p>
        <code>{cfg.verifier}</code> is the only member of the DAO's <em>verifier</em> role. It can only vote on bounty payouts, so
        it can't move funds any other way.
      </p>
      <ul className="small checklist">
        <li>Schema, row count, duplicates, personal data and prompt-injection checks</li>
        <li>
          {cfg.aiEnabled ? (
            <>Blind re-labelling of a sample by <code>{cfg.model}</code> on NEAR AI Cloud. The verifier computes agreement itself</>
          ) : (
            <>AI review is off (no NEAR AI key), so it runs structural checks only</>
          )}
        </li>
        <li>Approves at score ≥ {cfg.minScore}, otherwise rejects. Every reason is published below</li>
      </ul>
    </div>
  );
}

function BountyCard({ b, cfg, state, account, claim, run }: { b: Bounty; cfg: Config; state: State; account: string | null; claim?: BountyClaim; run: RunFn }) {
  const [open, setOpen] = useState(false);
  const spec = b.spec;
  const slots = b.times - b.claims;
  return (
    <div className="card bounty">
      <div className="bounty-head">
        <div>
          <span className="muted small">Bounty #{b.id}</span>
          <h3>{spec?.title ?? b.description.slice(0, 80)}</h3>
        </div>
        <div className="reward">
          {toNear(b.amount)} <span>NEAR</span>
        </div>
      </div>
      {spec && (
        <>
          <p>{spec.guidelines}</p>
          <div className="chips">
            <span className="chip">{spec.format.toUpperCase()}</span>
            <span className="chip">≥ {spec.minRows} rows</span>
            {Object.entries(spec.fields).map(([k, v]) => (
              <span className="chip" key={k}>
                {k}: {v.replaceAll("|", " | ")}
              </span>
            ))}
            <span className="chip">{slots} of {b.times} slots free</span>
          </div>
        </>
      )}
      <div className="row">
        {!account ? (
          <button className="ghost" onClick={showSignIn}>Connect to contribute</button>
        ) : claim?.completed ? (
          <span className="muted">You've submitted to this bounty. The verdict is in Activity.</span>
        ) : claim ? (
          <button onClick={() => setOpen(!open)}>{open ? "Hide" : "Submit dataset"}</button>
        ) : (
          <button
            disabled={slots <= 0}
            onClick={() =>
              run("Claim", () => callDao(cfg.daoId, "bounty_claim", { id: b.id, deadline: b.max_deadline }, BigInt(state.bountyBond), 50n * TGAS))
            }
          >
            Claim ({toNear(state.bountyBond)} NEAR bond)
          </button>
        )}
      </div>
      {open && claim && !claim.completed && spec && <SubmitPanel b={b} spec={spec} cfg={cfg} run={run} />}
    </div>
  );
}

function SubmitPanel({ b, spec, cfg, run }: { b: Bounty; spec: DatasetSpec; cfg: Config; run: RunFn }) {
  const [mode, setMode] = useState<"paste" | "url">("paste");
  const [content, setContent] = useState("");
  const [url, setUrl] = useState("");
  const [verdict, setVerdict] = useState<Verdict>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const resolve = async () => {
    if (mode === "url") return { url, sha256: "" };
    return api<{ url: string; sha256: string }>("/api/upload", { content, format: spec.format });
  };

  const loadSample = async (which: "good" | "bad" | "mislabeled") => setContent(await (await fetch(`/examples/sms-scam-${which}.jsonl`)).text());

  const precheck = async () => {
    setBusy(true);
    setErr("");
    try {
      const ref = await resolve();
      setVerdict(await api<Verdict>("/api/precheck", { bountyId: b.id, ...ref }));
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  };

  const submit = () =>
    run("Submit", async () => {
      const ref = await resolve();
      const sha = ref.sha256 || verdict?.sha256 || "";
      await callDao(cfg.daoId, "bounty_done", { id: b.id, description: JSON.stringify({ url: ref.url, sha256: sha }) }, 0n, 100n * TGAS);
    });

  return (
    <div className="submit">
      <div className="tabs">
        <button className={mode === "paste" ? "on" : ""} onClick={() => setMode("paste")}>Paste data</button>
        <button className={mode === "url" ? "on" : ""} onClick={() => setMode("url")}>Link (https)</button>
      </div>
      {mode === "paste" ? (
        <>
          <textarea rows={8} value={content} onChange={(e) => setContent(e.target.value)} placeholder={spec.format === "jsonl" ? '{"text": "...", "label": "..."}' : "text,label"} />
          <div className="row small">
            <span className="muted">Try a sample:</span>
            <button className="link" onClick={() => loadSample("good")}>good dataset</button>
            <button className="link" onClick={() => loadSample("bad")}>bad dataset</button>
            <button className="link" onClick={() => loadSample("mislabeled")}>mislabeled dataset</button>
          </div>
        </>
      ) : (
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://raw.githubusercontent.com/.../data.jsonl" />
      )}
      <div className="row">
        <button className="ghost" disabled={busy || (mode === "paste" ? !content : !url)} onClick={precheck}>
          {busy ? "Checking…" : "Precheck (free, no vote)"}
        </button>
        <button disabled={busy || (mode === "paste" ? !content : !url)} onClick={submit}>Submit on-chain</button>
      </div>
      {err && <p className="err">{err}</p>}
      {verdict && <VerdictView v={verdict} cfg={cfg} />}
    </div>
  );
}

function ProposeBounty({ cfg, state, account, run }: { cfg: Config; state: State; account: string | null; run: RunFn }) {
  const [f, setF] = useState({
    title: "", guidelines: "", format: "jsonl", textField: "text", labelField: "label", labels: "positive, negative",
    minRows: "20", reward: "1", slots: "3", hours: "48",
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const spec = useMemo<DatasetSpec>(() => {
    const labels = f.labels.split(",").map((s) => s.trim()).filter(Boolean);
    return {
      title: f.title.trim(),
      format: f.format as "jsonl" | "csv",
      fields: { [f.textField.trim() || "text"]: "string", ...(labels.length ? { [f.labelField.trim() || "label"]: labels.join("|") } : {}) },
      minRows: Number(f.minRows) || 1,
      guidelines: f.guidelines.trim(),
    };
  }, [f]);

  const propose = () =>
    run("Propose bounty", () =>
      callDao(
        cfg.daoId,
        "add_proposal",
        {
          proposal: {
            description: `New dataset bounty: ${spec.title}`,
            kind: {
              AddBounty: {
                bounty: {
                  description: JSON.stringify(spec),
                  token: "",
                  amount: toYocto(f.reward).toString(),
                  times: Number(f.slots),
                  max_deadline: (BigInt(Number(f.hours) * 3600) * 1_000_000_000n).toString(),
                },
              },
            },
          },
        },
        BigInt(state.proposalBond),
      ),
    );

  return (
    <section>
      <details className="card propose">
        <summary>
          <h2>Propose a dataset bounty</h2>
          <span className="muted">The council votes it in. Payouts come from the treasury.</span>
        </summary>
        <div className="form">
          <label>Title<input value={f.title} onChange={set("title")} placeholder="Customer support messages labeled by intent" /></label>
          <label className="wide">Guidelines<textarea rows={3} value={f.guidelines} onChange={set("guidelines")} placeholder="What makes a good row? What must be avoided?" /></label>
          <label>Format<select value={f.format} onChange={set("format")}><option value="jsonl">JSONL</option><option value="csv">CSV</option></select></label>
          <label>Text field<input value={f.textField} onChange={set("textField")} /></label>
          <label>Label field<input value={f.labelField} onChange={set("labelField")} /></label>
          <label>Allowed labels (comma-separated)<input value={f.labels} onChange={set("labels")} /></label>
          <label>Min rows<input value={f.minRows} onChange={set("minRows")} inputMode="numeric" /></label>
          <label>Reward per contributor (NEAR)<input value={f.reward} onChange={set("reward")} inputMode="decimal" /></label>
          <label>Contributor slots<input value={f.slots} onChange={set("slots")} inputMode="numeric" /></label>
          <label>Hours to deliver after claiming<input value={f.hours} onChange={set("hours")} inputMode="numeric" /></label>
        </div>
        <div className="row">
          <button disabled={!account || !spec.title} onClick={propose}>Propose bounty</button>
          {!account && <span className="muted small">Connect a wallet to propose.</span>}
        </div>
      </details>
    </section>
  );
}

function describe(p: ProposalView): { title: string; sub?: string } {
  const k = p.kind as any;
  if (typeof k === "string") return { title: k };
  if (k.AddBounty) {
    const b = k.AddBounty.bounty;
    let t = "dataset bounty";
    try {
      t = JSON.parse(b.description).title;
    } catch {}
    return { title: `New bounty: ${t}`, sub: `${toNear(b.amount)} NEAR × ${b.times} contributors` };
  }
  if (k.BountyDone) return { title: `Payout claim for bounty #${k.BountyDone.bounty_id}`, sub: `by ${k.BountyDone.receiver_id}` };
  if (k.Transfer) return { title: `Transfer ${toNear(k.Transfer.amount)} NEAR`, sub: `to ${k.Transfer.receiver_id}` };
  if (k.ChangePolicy) return { title: "Policy change", sub: p.description };
  if (k.AddMemberToRole) return { title: `Add ${k.AddMemberToRole.member_id} to ${k.AddMemberToRole.role}` };
  return { title: Object.keys(k)[0], sub: p.description };
}

function ProposalRow({ p, cfg, state, isCouncil, verdict, run }: { p: ProposalView; cfg: Config; state: State; isCouncil: boolean; verdict?: Verdict; run: RunFn }) {
  const [open, setOpen] = useState(false);
  const d = describe(p);
  const isPayout = typeof p.kind === "object" && "BountyDone" in p.kind;
  const voteAs = (action: "VoteApprove" | "VoteReject") =>
    run(action === "VoteApprove" ? "Approve" : "Reject", () => callDao(cfg.daoId, "act_proposal", { id: p.id, action, proposal: p.kind }, 0n, 200n * TGAS));
  void state;
  return (
    <div className="card proposal">
      <div className="proposal-head">
        <div>
          <span className="muted small">#{p.id} · {p.proposer}</span>
          <strong>{d.title}</strong>
          {d.sub && <span className="muted small">{d.sub}</span>}
        </div>
        <div className="proposal-right">
          {verdict && <span className={`score ${verdict.decision}`}>{verdict.score}</span>}
          <span className={`status s-${p.status}`}>{p.status === "InProgress" && isPayout ? "Verifying…" : p.status}</span>
        </div>
      </div>
      {Object.keys(p.votes).length > 0 && (
        <div className="votes small">
          {Object.entries(p.votes).map(([a, v]) => (
            <span key={a}>
              {a === cfg.verifier ? "🤖 " : ""}
              {a}: <b>{v}</b>
            </span>
          ))}
        </div>
      )}
      <div className="row">
        {verdict && (
          <button className="link" onClick={() => setOpen(!open)}>
            {open ? "Hide AI verdict" : "Show AI verdict"}
          </button>
        )}
        {isCouncil && p.status === "InProgress" && (
          <>
            <button className="ghost" onClick={() => voteAs("VoteApprove")}>Approve</button>
            <button className="ghost danger" onClick={() => voteAs("VoteReject")}>Reject</button>
          </>
        )}
      </div>
      {open && verdict && <VerdictView v={verdict} cfg={cfg} />}
    </div>
  );
}

function VerdictView({ v, cfg }: { v: Verdict; cfg: Config }) {
  return (
    <div className="verdict">
      <div className="verdict-head">
        <span className={`score big-score ${v.decision}`}>{v.score}</span>
        <div>
          <strong>{v.decision === "approve" ? "Approve payout" : "Reject"}</strong>
          <div className="muted small">
            {v.rows} rows · sha256 {v.sha256.slice(0, 12)}… · structural {v.structuralScore}
            {v.ai && ` · label agreement ${Math.round(v.ai.agreement * 100)}% · quality ${v.ai.qualityScore}`}
          </div>
        </div>
      </div>
      <ul className="checks">
        {v.checks.map((c) => (
          <li key={c.name} className={c.ok ? "ok" : "bad"}>
            <span>{c.ok ? "✓" : "✗"}</span> <b>{c.name}</b> <span className="muted">{c.detail}</span>
          </li>
        ))}
      </ul>
      {v.ai && (
        <div className="ai">
          <p>
            <b>AI review</b> <span className="muted small">({v.ai.model}, {v.ai.sampled} rows sampled blind{v.ai.completionId ? `, id ${v.ai.completionId}` : ""})</span>
          </p>
          <p>{v.ai.summary}</p>
          <table>
            <thead>
              <tr><th>Row</th><th>Text</th><th>Submitted</th><th>AI</th></tr>
            </thead>
            <tbody>
              {v.ai.judgements.slice(0, 12).map((j) => (
                <tr key={j.row} className={j.agrees ? "" : "disagree"}>
                  <td>{j.row}</td>
                  <td title={j.reason}>{j.text}</td>
                  <td>{j.submittedLabel}</td>
                  <td>{j.aiLabel}{j.agrees ? "" : " ⚠"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {v.aiError && <p className="err small">AI review failed: {v.aiError}</p>}
      <ul className="small reasons">
        {v.reasons.map((r) => <li key={r}>{r}</li>)}
      </ul>
      {v.voteTx && (
        <a className="small" href={`${cfg.explorer}/txns/${v.voteTx}`} target="_blank" rel="noreferrer">
          Verifier vote transaction ↗
        </a>
      )}
      {v.voteError && <p className="err small">Vote pending: {v.voteError}</p>}
    </div>
  );
}
