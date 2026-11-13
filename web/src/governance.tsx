// The DAO page (anyone) and the council page (council members only). Both read /api/dao for the full policy and
// every proposal, and send proposals and votes straight from the user's wallet.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ArrowUpRight, Gavel, ShieldAlert, ShieldCheck, Wallet } from "lucide-react";
import type { ProposalView, Verdict } from "../../shared/types";
import { api, type Config, type RunFn, type State } from "./api";
import { TGAS, callDao, showSignIn, toNear, toYocto } from "./near";
import { describe, ProposalRow } from "./App";
import { useAttestation } from "./submission";

type VotePolicy = { weight_kind: string; quorum: string; threshold: [number, number] | string };
type Role = { name: string; kind: "Everyone" | { Group: string[] } | { Member: string }; permissions: string[]; vote_policy: Record<string, VotePolicy> };
type Policy = { roles: Role[]; default_vote_policy: VotePolicy; proposal_bond: string; proposal_period: string; bounty_bond: string; bounty_forgiveness_period: string };
export type DaoInfo = { config: { name: string; purpose: string; metadata: string }; policy: Policy; proposals: ProposalView[]; verdicts: Record<string, Verdict> };
type Props = { cfg: Config; state: State; account: string | null; isCouncil: boolean; run: RunFn };
type Action = "VoteApprove" | "VoteReject" | "VoteRemove" | "Finalize";

const ICON = { size: 20, strokeWidth: 1.75 } as const;
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const pad = (n: number) => String(n).padStart(2, "0");
const nsToMs = (ns: string | bigint) => Number(BigInt(ns) / 1_000_000n);
const hours = (ns: string) => Math.round(nsToMs(ns) / 3_600_000);

// ---------- Policy helpers ----------

/** Sputnik's name for a proposal kind, as used in permissions ("transfer:VoteApprove") and per-kind vote policies. */
const SPECIAL: Record<string, string> = { ChangeConfig: "config", ChangePolicy: "policy", FunctionCall: "call", SetStakingContract: "set_vote_token" };
const kindKey = (p: ProposalView) => (typeof p.kind === "string" ? p.kind : Object.keys(p.kind)[0]);
const kindLabel = (k: string) => SPECIAL[k] ?? k.replace(/^ChangePolicy/, "Policy").replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();

const membersOf = (r: Role) => (typeof r.kind === "string" ? [] : "Group" in r.kind ? r.kind.Group : [r.kind.Member]);
const can = (r: Role, label: string, action: string) =>
  r.permissions.some((p) => p === "*:*" || p === `*:${action}` || p === `${label}:*` || p === `${label}:${action}`);

/** Approvals a group role needs to pass a proposal of this kind. Mirrors Sputnik's max(quorum, n × ratio + 1) capped at n. */
function needed(policy: Policy, role: Role, label: string): number | undefined {
  const vp = role.vote_policy?.[label] ?? policy.default_vote_policy;
  if (vp.weight_kind !== "RoleWeight") return undefined;
  const n = membersOf(role).length;
  const byRatio = Array.isArray(vp.threshold) ? Math.min(n, Math.floor((n * vp.threshold[0]) / vp.threshold[1]) + 1) : Number(vp.threshold);
  return Math.max(byRatio, Number(vp.quorum));
}

const expiresAt = (p: ProposalView, policy: Policy) => nsToMs(BigInt(p.submission_time) + BigInt(policy.proposal_period));

function untilText(ms: number) {
  if (ms <= 0) return "voting closed";
  const h = Math.floor(ms / 3_600_000);
  if (h >= 48) return `${Math.floor(h / 24)} d left`;
  if (h >= 1) return `${h} h left`;
  return `${Math.max(1, Math.floor(ms / 60_000))} min left`;
}

const ACTION_TEXT: Record<string, string> = {
  AddProposal: "propose",
  VoteApprove: "approve",
  VoteReject: "reject",
  VoteRemove: "remove spam",
  Finalize: "finalize",
  "*": "do anything",
};
/** "approve and reject payouts" from ["bounty_done:VoteApprove", "bounty_done:VoteReject"]. */
function permissionText(perms: string[]): string {
  const byKind = new Map<string, string[]>();
  for (const p of perms) {
    const [kind, action] = p.split(":");
    byKind.set(kind, [...(byKind.get(kind) ?? []), ACTION_TEXT[action] ?? action]);
  }
  return [...byKind]
    .map(([kind, acts]) => `${acts.join(", ")} ${kind === "*" ? "anything" : kind === "bounty_done" ? "payouts" : kind.replace(/_/g, " ")}`)
    .join(". ");
}

// ---------- Data ----------

let lastDao: DaoInfo | undefined;

function useDao() {
  const [dao, setDao] = useState<DaoInfo | undefined>(lastDao);
  const [err, setErr] = useState("");
  const reload = useCallback(async () => {
    try {
      const d = await api<DaoInfo>("/api/dao");
      lastDao = d;
      setDao(d);
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  useEffect(() => {
    reload();
    const t = setInterval(reload, 8000);
    return () => clearInterval(t);
  }, [reload]);
  return { dao, err, reload };
}

/** Wraps run() and reloads the DAO data once the chain has had a moment to settle. */
const withReload = (run: RunFn, reload: () => void): RunFn => async (label, f) => {
  await run(label, f);
  setTimeout(reload, 2000);
};

const vote = (cfg: Config, p: ProposalView, action: Action) => callDao(cfg.daoId, "act_proposal", { id: p.id, action, proposal: p.kind }, 0n, 200n * TGAS);
const propose = (cfg: Config, state: State, description: string, kind: object | string) =>
  callDao(cfg.daoId, "add_proposal", { proposal: { description, kind } }, BigInt(state.proposalBond));

function Loading({ err, title }: { err: string; title: string }) {
  return (
    <section className="panel">
      <h1 className="page-title">{title}</h1>
      <p className={err ? "small err" : "small muted"}>{err ? `Couldn't load the DAO (${err.slice(0, 200)}). Retrying…` : "Loading the DAO…"}</p>
    </section>
  );
}

// ---------- Proposal forms ----------

type FormKind = "funds" | "join" | "poll" | "add" | "remove" | "retire";
const FORM_TABS: Record<FormKind, string> = {
  funds: "Request funds",
  join: "Join the council",
  poll: "Community poll",
  add: "Add a member",
  remove: "Remove a member",
  retire: "Retire a verifier",
};

function ProposalForm({ cfg, state, account, run, kinds, sendLabel }: { cfg: Config; state: State; account: string | null; run: RunFn; kinds: FormKind[]; sendLabel?: (k: FormKind) => string }) {
  const [tab, setTab] = useState<FormKind>(kinds[0]);
  const [who, setWho] = useState("");
  const [amount, setAmount] = useState("1");
  const [text, setText] = useState("");

  useEffect(() => {
    setWho(tab === "join" ? account ?? "" : tab === "remove" ? state.council.find((c) => c !== account) ?? "" : tab === "retire" ? state.verifiers[0] ?? "" : "");
    setText("");
  }, [tab, account, state.council, state.verifiers]);

  const choices = tab === "remove" ? state.council : tab === "retire" ? state.verifiers : undefined;
  let problem = "";
  if (tab !== "poll") {
    if (!who.trim()) problem = "Enter an account";
    else if (!ACCOUNT_RE.test(who.trim()) || who.length > 64) problem = "That isn't a valid NEAR account";
    else if ((tab === "join" || tab === "add") && state.council.includes(who.trim())) problem = `${who.trim()} is already on the council`;
    else if (tab === "remove" && state.council.length <= 1) problem = "The council needs at least one member";
  }
  if (tab === "funds") {
    try {
      if (toYocto(amount) <= 0n) problem ||= "Enter an amount above zero";
      else if (toYocto(amount) > BigInt(state.available)) problem ||= `The treasury has ${toNear(state.available)} NEAR available`;
    } catch {
      problem ||= "Enter an amount in NEAR";
    }
  }
  if (!text.trim()) problem ||= tab === "poll" ? "Write the question" : "Say why";

  const submit = () => {
    const w = who.trim();
    const t = text.trim();
    const [label, desc, kind]: [string, string, object | string] =
      tab === "funds"
        ? ["Funding request", t, { Transfer: { token_id: "", receiver_id: w, amount: toYocto(amount).toString(), msg: null } }]
        : tab === "join" || tab === "add"
          ? ["Council proposal", t, { AddMemberToRole: { member_id: w, role: "council" } }]
          : tab === "remove"
            ? ["Council proposal", t, { RemoveMemberFromRole: { member_id: w, role: "council" } }]
            : tab === "retire"
              ? ["Verifier proposal", t, { RemoveMemberFromRole: { member_id: w, role: "verifier" } }]
              : ["Poll", t, "Vote"];
    run(label, () => propose(cfg, state, desc, kind)).then(() => setText(""));
  };

  const bond = BigInt(state.proposalBond) > 0n ? `Posting it locks a ${toNear(state.proposalBond)} NEAR bond.` : "Posting it is free apart from gas.";
  return (
    <div className="gov-form">
      {kinds.length > 1 && (
        <div className="tabs" role="tablist">
          {kinds.map((k) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
              {FORM_TABS[k]}
            </button>
          ))}
        </div>
      )}
      <div className="form">
        {tab !== "poll" &&
          (choices ? (
            <label>
              {tab === "retire" ? "Verifier" : "Member"}
              <select value={who} onChange={(e) => setWho(e.target.value)}>
                {choices.map((c) => (
                  <option key={c} value={c}>
                    {c === account ? `${c} (you)` : c}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label>
              {tab === "funds" ? "Send to" : "Account"}
              <input value={who} onChange={(e) => setWho(e.target.value)} placeholder="name.testnet" spellCheck={false} autoCapitalize="off" />
            </label>
          ))}
        {tab === "funds" && (
          <label>
            Amount in NEAR
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          </label>
        )}
        <label className="wide">
          {tab === "poll" ? "Question" : "Why"}
          <textarea
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              tab === "funds" ? "What the money is for and how the community benefits" :
              tab === "poll" ? "Should we fund a medical QA dataset next month?" :
              tab === "retire" ? "Why this verifier should go" : "Who they are and why they should help run the fund"
            }
          />
        </label>
      </div>
      <div className="row gov-submit">
        {account ? (
          <button onClick={submit} disabled={!!problem}>
            {sendLabel?.(tab) ?? "Send proposal"}
          </button>
        ) : (
          <button onClick={showSignIn}>
            <Wallet size={14} strokeWidth={1.75} aria-hidden /> Connect to propose
          </button>
        )}
        <span className={`small ${problem && account ? "err" : "muted"}`}>{account && problem ? problem : `The council votes on it. ${bond}`}</span>
      </div>
    </div>
  );
}

// ---------- DAO page ----------

const FILTERS = { voting: "Voting", passed: "Passed", failed: "Failed", all: "All" } as const;
type Filter = keyof typeof FILTERS;
const matches = (p: ProposalView, f: Filter) =>
  f === "all" ? true : f === "voting" ? p.status === "InProgress" : f === "passed" ? p.status === "Approved" : p.status !== "InProgress" && p.status !== "Approved";

export function DaoPage({ cfg, state, account, isCouncil, run }: Props) {
  const { dao, err, reload } = useDao();
  const [filter, setFilter] = useState<Filter>("voting");
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(25);
  const act = useMemo(() => withReload(run, reload), [run, reload]);
  if (!dao) return <Loading err={err} title="DAO" />;

  const { policy, config, proposals } = dao;
  const voting = proposals.filter((p) => p.status === "InProgress").length;
  const daoUrl = `${cfg.explorer}/address/${cfg.daoId}`;
  const needle = q.trim().toLowerCase();
  const rows = proposals
    .filter((p) => matches(p, filter))
    .map((p) => ({ p, d: describe(p) }))
    .filter(({ p, d }) => !needle || `${pad(p.id)} ${d.title} ${d.sub ?? ""} ${p.description} ${p.proposer}`.toLowerCase().includes(needle));
  const council = policy.roles.find((r) => r.name === "council");

  return (
    <>
      <section id="dao" className="panel">
        <header className="panel-head">
          <span className="small muted">Sputnik DAO on {cfg.network}</span>
          <a href={daoUrl} target="_blank" rel="noreferrer" aria-label="DAO account on the explorer" title="DAO account on the explorer">
            <ArrowUpRight {...ICON} />
          </a>
        </header>
        <h1 className="page-title">{config.name || cfg.daoId}</h1>
        {config.purpose && <p className="page-lede">{config.purpose}</p>}
        <dl className="stats">
          <div><dt>Treasury</dt><dd className="num">{toNear(state.available)} <small>NEAR</small></dd></div>
          <div><dt>Council</dt><dd className="num">{state.council.length} <small>{state.council.length === 1 ? "member" : "members"}</small></dd></div>
          <div><dt>Proposals</dt><dd className="num">{proposals.length}</dd></div>
          <div><dt>Open votes</dt><dd className="num">{voting}</dd></div>
        </dl>
        {isCouncil && (
          <Link className="steps-cta gov-cta" to="/council">
            <Gavel size={16} strokeWidth={1.75} aria-hidden /> Open the council desk
          </Link>
        )}
      </section>

      <section id="ask" className="panel">
        <header className="panel-head">
          <h2>Ask the DAO</h2>
          <span className="small muted">Anyone can propose</span>
        </header>
        <ProposalForm cfg={cfg} state={state} account={account} run={act} kinds={["funds", "join", "poll"]} />
      </section>

      <section id="proposals" className="panel">
        <header className="panel-head">
          <h2>Proposals</h2>
          <label className="search gov-search">
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter proposals" aria-label="Filter proposals" />
          </label>
        </header>
        <div className="tabs gov-filter" role="tablist">
          {(Object.keys(FILTERS) as Filter[]).map((f) => (
            <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? "on" : ""} onClick={() => { setFilter(f); setLimit(25); }}>
              {FILTERS[f]} <span className="num muted">{proposals.filter((p) => matches(p, f)).length}</span>
            </button>
          ))}
        </div>
        <div className="ledger">
          {rows.slice(0, limit).map(({ p, d }) => (
            <ProposalRow
              key={p.id}
              p={p}
              d={d}
              cfg={cfg}
              account={account}
              canVote={!!account && !!council && membersOf(council).includes(account) && p.status === "InProgress" && !(account in p.votes) && expiresAt(p, policy) > Date.now()}
              verdict={dao.verdicts[p.id]}
              run={act}
            />
          ))}
          {!rows.length && <p className="empty">{needle ? `Nothing matches “${q.trim()}”.` : filter === "voting" ? "Nothing is up for a vote right now." : "No proposals here yet."}</p>}
        </div>
        {rows.length > limit && (
          <button className="ghost gov-more" onClick={() => setLimit(limit + 25)}>
            Show {Math.min(25, rows.length - limit)} more
          </button>
        )}
      </section>

      <section id="rules" className="panel">
        <header className="panel-head">
          <h2>Members and rules</h2>
          <span className="small muted">Read live from the contract</span>
        </header>
        <div className="roles">
          {policy.roles.map((r) => {
            const members = membersOf(r);
            const need = members.length ? needed(policy, r, "transfer") : undefined;
            return (
              <article key={r.name} className="role">
                <div className="role-head">
                  <b>{r.name}</b>
                  <span className="small muted">{typeof r.kind === "string" ? "Everyone" : `${members.length} ${members.length === 1 ? "member" : "members"}`}</span>
                </div>
                <p className="small muted">Can {permissionText(r.permissions)}.{need ? ` A vote passes with ${need} of ${members.length} approving.` : ""}</p>
                {members.length > 0 && (
                  <ul className="members">
                    {members.map((m) => (
                      <li key={m} className="num">
                        {m === cfg.verifier ? "Verifier enclave " : ""}
                        <a href={`${cfg.explorer}/address/${m}`} target="_blank" rel="noreferrer">{m.length > 32 ? `${m.slice(0, 12)}…${m.slice(-6)}` : m}</a>
                        {m === account && <span className="tag">you</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            );
          })}
        </div>
        <dl className="facts">
          <div><dt>Proposal bond</dt><dd className="num">{toNear(policy.proposal_bond)} NEAR</dd></div>
          <div><dt>Voting window</dt><dd className="num">{hours(policy.proposal_period)} h</dd></div>
          <div><dt>Bounty claim bond</dt><dd className="num">{toNear(policy.bounty_bond)} NEAR</dd></div>
          <div><dt>Bond refund window</dt><dd className="num">{hours(policy.bounty_forgiveness_period)} h</dd></div>
        </dl>
      </section>
    </>
  );
}

// ---------- Council page ----------

export function CouncilPage({ cfg, state, account, isCouncil, run }: Props) {
  const { dao, err, reload } = useDao();
  const act = useMemo(() => withReload(run, reload), [run, reload]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  if (!account || !isCouncil) {
    return (
      <section className="panel gate">
        <span className="step-icon" aria-hidden><Gavel {...ICON} /></span>
        <h1 className="page-title">Council desk</h1>
        <p className="page-lede">
          {account ? `${account} isn't on the council. This desk is where members vote, finalize and manage the fund.` : "Connect a council wallet to vote, finalize and manage the fund."}
        </p>
        <p className="small muted">Council members are {state.council.join(", ") || "not set"}.</p>
        <div className="row">
          {!account && (
            <button onClick={showSignIn}>
              <Wallet size={14} strokeWidth={1.75} aria-hidden /> Connect wallet
            </button>
          )}
          <Link className="button-link ghost-link" to="/dao#ask">Ask to join the council</Link>
        </div>
      </section>
    );
  }
  if (!dao) return <Loading err={err} title="Council desk" />;

  const { policy, proposals } = dao;
  const council = policy.roles.find((r) => r.name === "council")!;
  const open = proposals.filter((p) => p.status === "InProgress");
  const live = open.filter((p) => expiresAt(p, policy) > now);
  const mayVote = (p: ProposalView) => can(council, kindLabel(kindKey(p)), "VoteApprove");
  const todo = live.filter((p) => mayVote(p) && !(account in p.votes)).sort((a, b) => expiresAt(a, policy) - expiresAt(b, policy));
  const waiting = live.filter((p) => mayVote(p) && account in p.votes);
  const finalize = open.filter((p) => expiresAt(p, policy) <= now);
  const canFinalize = finalize.length > 0 && finalize.some((p) => can(council, kindLabel(kindKey(p)), "Finalize"));
  const recent = proposals.filter((p) => p.status !== "InProgress" && account in p.votes).slice(0, 5);

  const card = (p: ProposalView, actions: ReactNode) => (
    <VoteCard key={p.id} p={p} dao={dao} cfg={cfg} council={council} account={account} now={now} actions={actions} />
  );

  return (
    <>
      <section id="council" className="panel">
        <header className="panel-head">
          <span className="small muted">Signed in as {account}</span>
          <Link className="small muted" to="/dao">Whole DAO <ArrowUpRight size={14} strokeWidth={1.75} className="inline-icon" aria-hidden /></Link>
        </header>
        <h1 className="page-title">Council desk</h1>
        <p className="page-lede">
          You're one of {state.council.length} council {state.council.length === 1 ? "member" : "members"}. Most proposals pass with {needed(policy, council, "transfer")} approving. Votes close after {hours(policy.proposal_period)} h.
        </p>
        <dl className="stats">
          <div className={todo.length ? "hot" : ""}><dt>Needs your vote</dt><dd className="num">{todo.length}</dd></div>
          <div><dt>Waiting on others</dt><dd className="num">{waiting.length}</dd></div>
          <div><dt>To finalize</dt><dd className="num">{finalize.length}</dd></div>
          <div><dt>Treasury</dt><dd className="num">{toNear(state.available)} <small>NEAR</small></dd></div>
        </dl>
      </section>

      <section id="vote" className="panel">
        <header className="panel-head">
          <h2>Needs your vote</h2>
          <span className="small muted">Closest deadline first</span>
        </header>
        {todo.length ? (
          <div className="cards">
            {todo.map((p) =>
              card(p, <>
                <button onClick={() => act("Approve", () => vote(cfg, p, "VoteApprove"))}>Approve</button>
                <button className="ghost danger" onClick={() => act("Reject", () => vote(cfg, p, "VoteReject"))}>Reject</button>
                {can(council, kindLabel(kindKey(p)), "VoteRemove") && (
                  <button className="link gov-spam" onClick={() => act("Remove", () => vote(cfg, p, "VoteRemove"))} title="Votes to delete the proposal as spam">
                    Remove as spam
                  </button>
                )}
              </>),
            )}
          </div>
        ) : (
          <p className="empty">You're all caught up. Nothing is waiting for your vote.</p>
        )}
      </section>

      {finalize.length > 0 && (
        <section id="finalize" className="panel">
          <header className="panel-head">
            <h2>Ready to finalize</h2>
            <span className="small muted">Voting closed without a result</span>
          </header>
          <p className="small muted gov-note">Finalizing settles a closed proposal and returns its bond. It counts the votes cast and marks the rest expired.</p>
          <div className="cards">
            {finalize.map((p) =>
              card(p, canFinalize ? <button className="ghost" onClick={() => act("Finalize", () => vote(cfg, p, "Finalize"))}>Finalize</button> : null),
            )}
          </div>
        </section>
      )}

      <section id="manage" className="panel">
        <header className="panel-head">
          <h2>Council actions</h2>
          <span className="small muted">Each one becomes a proposal</span>
        </header>
        <ProposalForm
          cfg={cfg}
          state={state}
          account={account}
          run={act}
          kinds={["funds", "add", "remove", "retire", "poll"]}
          sendLabel={(k) => (k === "funds" ? "Propose payment" : k === "poll" ? "Start poll" : "Propose change")}
        />
        <p className="small muted gov-note">Your own proposal shows up under Needs your vote. Approve it there too.</p>
      </section>

      {(waiting.length > 0 || recent.length > 0) && (
        <section id="voted" className="panel">
          <header className="panel-head">
            <h2>Your votes</h2>
            <span className="small muted">Open and recent</span>
          </header>
          <div className="cards">
            {waiting.map((p) => card(p, null))}
            {recent.map((p) => card(p, null))}
          </div>
        </section>
      )}
    </>
  );
}

/** One proposal with what it does, the council tally, the deadline and the given actions. */
function VoteCard({ p, dao, cfg, council, account, now, actions }: { p: ProposalView; dao: DaoInfo; cfg: Config; council: Role; account: string; now: number; actions: ReactNode }) {
  const d = describe(p);
  const label = kindLabel(kindKey(p));
  const n = membersOf(council).length;
  const need = needed(dao.policy, council, label) ?? n;
  const [yes, no, rm] = (p.vote_counts[council.name] ?? ["0", "0", "0"]).map(Number);
  const mine = p.votes[account];
  const verdict = dao.verdicts[p.id];
  const k = typeof p.kind === "object" ? p.kind : undefined;
  const payout = k?.BountyDone as { bounty_id: number; receiver_id: string } | undefined;
  const isVerifier = k?.AddMemberToRole?.role === "verifier";
  const showDesc = !isVerifier && p.description && p.description !== d.sub && !p.description.startsWith("{");
  const left = expiresAt(p, dao.policy) - now;

  return (
    <article className="vote-card">
      <div className="vote-head">
        <span className="entry-id num">{pad(p.id)}</span>
        <div className="vote-title">
          <b>{d.title}</b>
          <span className="small muted">{[d.sub, `by ${p.proposer}`].filter(Boolean).join(", ")}</span>
        </div>
        <span className={`status s-${p.status}`}>{p.status === "InProgress" ? untilText(left) : p.status}</span>
      </div>
      {showDesc && <p className="vote-desc">{p.description}</p>}
      {payout && (
        <p className="small muted">
          {verdict ? `The verifier scored it ${verdict.score}. ` : "The verifier hasn't scored it yet. "}
          The enclave usually decides payouts. Vote only to overrule it. <Link to={`/bounty/${payout.bounty_id}`}>Bounty dashboard</Link>
        </p>
      )}
      {isVerifier && <AttestationCheck p={p} />}
      <div className="tally" role="img" aria-label={`${yes} approve, ${no} reject, ${need} needed of ${n}`}>
        <div className="tally-bar">
          {Array.from({ length: n }, (_, i) => (
            <i key={i} className={i < yes ? "t-yes" : i < yes + no ? "t-no" : i < yes + no + rm ? "t-rm" : ""} />
          ))}
        </div>
        <span className="small muted num">
          {yes} approve, {no} reject{rm ? `, ${rm} remove` : ""}. Needs {need} of {n}.{mine ? ` You voted ${mine}.` : ""}
        </span>
      </div>
      {actions && <div className="vote-actions">{actions}</div>}
    </article>
  );
}

/** For "add enclave to verifier role", compare the keys in the proposal with the enclave serving this app. */
function AttestationCheck({ p }: { p: ProposalView }) {
  const { att, err } = useAttestation();
  let claim: { sealPublicKey?: string; mode?: string; composeHash?: string | null; attestation?: string } = {};
  try {
    claim = JSON.parse(p.description);
  } catch {}
  const member = (p.kind as any).AddMemberToRole.member_id as string;
  const same = att && att.accountId === member && att.sealPublicKey === claim.sealPublicKey;
  const facts = [
    claim.mode === "tee" ? "Intel TDX attestation" : "Dev mode with no TEE attestation",
    claim.composeHash ? `compose hash ${claim.composeHash.slice(0, 12)}…` : "",
  ].filter(Boolean).join(", ");
  return (
    <div className={`att-check${same ? "" : " bad"}`}>
      {same ? <ShieldCheck size={16} aria-hidden /> : <ShieldAlert size={16} aria-hidden />}
      <span className="small">
        {!att ? (err ? "The live enclave is offline. Check the attestation by hand." : "Checking the live enclave…") : same ? "Matches the enclave serving this app." : "Doesn't match the enclave serving this app. Check before approving."}{" "}
        <span className="muted">{facts}.</span>{" "}
        {claim.attestation && <a href={claim.attestation} target="_blank" rel="noreferrer">Raw attestation</a>}
      </span>
    </div>
  );
}
