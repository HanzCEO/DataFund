import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  Coins,
  ChevronRight,
  ExternalLink,
  Hand,
  Hourglass,
  Landmark,
  Layers,
  LayoutGrid,
  Minus,
  Plus,
  ScanSearch,
  Search,
  ShieldCheck,
  TriangleAlert,
  Upload,
  Wallet,
  X,
} from "lucide-react";
import type { Access, BountyClaim, DatasetSpec, ProposalView, ReviewMode, TaskType, Verdict } from "../../shared/types";
import { labelsOf, MANUAL_MIN_ROWS, MAX_REVIEW_HOURS, MIN_SAMPLE, TASK_FIELDS, TASK_INFO } from "../../shared/spec";
import { api, type Bounty, type Config, type RunFn, type State } from "./api";
import { EnclavePanel, SubmitPanel, VerdictView } from "./submission";
import { Link, Navigate, Route, Routes, useLocation, useMatch, useNavigate, useNavigationType, useParams } from "react-router";
import { TGAS, callDao, chipIn, currentAccount, initWallet, showSignIn, signOut, toNear, toYocto } from "./near";

type ClaimRow = BountyClaim & { account: string };
type BountyDetail = {
  bounty: Bounty | null;
  claims: ClaimRow[];
  submissions: { proposal: ProposalView; verdict: Verdict | null }[];
  checkedAccounts: number;
};
const ICON = { size: 20, strokeWidth: 1.75 } as const;
const pad = (n: number) => String(n).padStart(2, "0");
const titleOf = (b: Bounty) => b.spec?.title ?? b.description.slice(0, 80);
const nsToDate = (ns: string) => new Date(Number(BigInt(ns) / 1_000_000n));
/** yocto → NEAR as a float, for proportions only (never for amounts shown or sent). */
const nearFloat = (yocto: bigint) => Number(yocto / 10n ** 18n) / 1e6;
const shortName = (account: string) => {
  const name = account.split(".")[0];
  return name.length > 20 ? `${name.slice(0, 8)}…` : name;
};
const bountyPath = (id: number) => `/bounty/${id}`;
const parseId = (raw?: string) => (raw && /^\d+$/.test(raw) ? Number(raw) : undefined);

/**
 * Scroll on navigation, after the new view has rendered. Back and forward return to where that page was left.
 * A link with a hash lands on that section (smoothly within a page, instantly across pages). Anything else starts at the top.
 */
function useRouteScroll(ready: boolean) {
  const location = useLocation();
  const navType = useNavigationType();
  const saved = useRef(new Map<string, number>());
  const handled = useRef<string>(undefined);
  const lastPath = useRef<string>(undefined);

  useEffect(() => {
    history.scrollRestoration = "manual";
  }, []);

  useEffect(() => {
    const onScroll = () => saved.current.set(location.key, window.scrollY);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [location.key]);

  useEffect(() => {
    if (!ready || handled.current === location.key) return;
    handled.current = location.key;
    const samePage = lastPath.current === location.pathname;
    lastPath.current = location.pathname;

    // Never return a scroll call from here. Newer browsers return a Promise, and React would call it as the cleanup.
    const back = navType === "POP" ? saved.current.get(location.key) : undefined;
    const el = location.hash ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
    if (back !== undefined) window.scrollTo({ top: back, behavior: "instant" });
    else if (el) el.scrollIntoView({ block: "start", behavior: samePage ? "smooth" : "instant" });
    else if (!samePage) window.scrollTo({ top: 0, behavior: "instant" });
  }, [location, navType, ready]);
}
const greeting = (h = new Date().getHours()) => (h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening");

/** Cover palettes. Each bounty gets one by id, like titles in a book series. */
const THEMES = [
  { bg: "#1b3a9e", fg: "#f4f1ea", hot: "#ff5a2e" },
  { bg: "#151515", fg: "#f4f1ea", hot: "#ff5a2e" },
  { bg: "#dc3514", fg: "#fff6ef", hot: "#151515" },
  { bg: "#ece6d8", fg: "#151515", hot: "#dc3514" },
];
const themeVars = (id: number) => {
  const t = THEMES[id % THEMES.length];
  return { "--c-bg": t.bg, "--c-fg": t.fg, "--c-hot": t.hot } as CSSProperties;
};

/** Deterministic PRNG (mulberry32). A bounty's cover and spine look the same on every visit. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export default function App() {
  const [cfg, setCfg] = useState<Config>();
  const [state, setState] = useState<State>();
  const [account, setAccount] = useState<string | null>(null);
  const [claims, setClaims] = useState<BountyClaim[]>([]);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string }>();
  const [loadErr, setLoadErr] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<number>();
  const [proposeOpen, setProposeOpen] = useState(false);
  const navigate = useNavigate();
  const route = parseId(useMatch("/bounty/:id")?.params.id);
  useRouteScroll(!!cfg && !!state);

  // Links shared before the switch to React Router used #/bounty/<id>. Send them to the real path.
  useEffect(() => {
    const old = window.location.hash.match(/^#\/bounty\/(\d+)$/);
    if (old) navigate(bountyPath(Number(old[1])), { replace: true });
  }, [navigate]);

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
        setToast({ kind: "ok", msg: `${label} done` });
        setTimeout(refresh, 1500);
      } catch (e) {
        setToast({ kind: "err", msg: `${label} failed. ${(e as Error).message}` });
      }
      setTimeout(() => setToast(undefined), 6000);
    },
    [refresh],
  );

  /** The form lives on the overview. From a dashboard this goes there first, and useRouteScroll lands on it. */
  const openPropose = useCallback(() => {
    setProposeOpen(true);
    navigate("/#propose");
  }, [navigate]);

  /** On a dashboard the shelf switches dashboards. On the overview it switches the featured bounty. */
  const selectBounty = useCallback((id: number) => (route !== undefined ? navigate(bountyPath(id)) : setSelected(id)), [route, navigate]);

  if (!cfg || !state) return <AppSkeleton route={route} err={loadErr && `Couldn't load chain data (${loadErr.slice(0, 200)}). Retrying…`} />;

  const isCouncil = !!account && state.council.includes(account);
  const open = state.bounties.filter((b) => b.times > 0);
  const mine = open.find((b) => claims.some((c) => c.bounty_id === b.id && !c.completed));
  const featured = open.find((b) => b.id === (route ?? selected)) ?? (route === undefined ? mine ?? open[0] : undefined);
  const needle = query.trim().toLowerCase();
  const daoUrl = `${cfg.explorer}/address/${cfg.daoId}`;

  const overview = (
    <>
      <section id="overview" className="panel hero">
        <div className="topbar">
          <label className="search">
            <Search size={16} strokeWidth={1.75} aria-hidden />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search DataFund" aria-label="Search bounties and activity" />
          </label>
          <div className="crumbs">
            <a className="dao" href={daoUrl} target="_blank" rel="noreferrer">
              {cfg.daoId.split(".")[0]} / {cfg.network}
            </a>
            {account ? (
              <button className="who" onClick={() => signOut()} title="Sign out">
                {account}
                {isCouncil && <span className="tag">council</span>}
              </button>
            ) : (
              <button className="connect" onClick={showSignIn}>
                <Wallet size={14} strokeWidth={1.75} aria-hidden /> Connect wallet
              </button>
            )}
          </div>
        </div>

        <h1 className="greeting">
          <span>{greeting()},</span>
          <span>{account ? shortName(account) : "welcome to DataFund"}</span>
        </h1>

        {featured ? (
          <Featured
            key={featured.id}
            b={featured}
            cfg={cfg}
            state={state}
            account={account}
            claim={claims.find((c) => c.bounty_id === featured.id)}
            run={run}
          />
        ) : (
          <NoBounties onPropose={openPropose} />
        )}
      </section>

      <ProposeBounty cfg={cfg} state={state} account={account} run={run} open={proposeOpen} setOpen={setProposeOpen} />
      <ActivityPanel cfg={cfg} state={state} account={account} isCouncil={isCouncil} needle={needle} query={query} daoUrl={daoUrl} run={run} />
    </>
  );

  return (
    <>
      <div className="app">
        <Rail account={account} onPropose={openPropose} />

        <div className="col col-main">
          <Routes>
            <Route path="/" element={overview} />
            <Route
              path="/bounty/:id"
              element={<DashboardRoute cfg={cfg} state={state} account={account} isCouncil={isCouncil} claims={claims} run={run} />}
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>

        <div className="col col-side">
          <Shelf bounties={open} needle={needle} query={query} selected={featured} onSelect={selectBounty} onPropose={openPropose} />
          <Treasury cfg={cfg} state={state} account={account} daoUrl={daoUrl} run={run} />
          <EnclavePanel cfg={cfg} state={state} />
          <HowItWorks cfg={cfg} state={state} account={account} />
        </div>
      </div>

      <footer>
        DAO <a href={daoUrl} target="_blank" rel="noreferrer">{cfg.daoId}</a>, built for NEAR HACKATHON 2026
      </footer>
      {toast && <div className={`toast ${toast.kind}`} role="status">{toast.msg}</div>}
    </>
  );
}

/** DataFund mark, three labelled rows of a dataset, one label flagged. */
function Mark() {
  return (
    <svg className="mark" viewBox="0 0 30 30" aria-hidden>
      <rect width="30" height="30" fill="currentColor" />
      <g fill="var(--panel)">
        <rect x="4" y="7" width="13" height="4" />
        <rect x="20" y="7" width="6" height="4" />
        <rect x="4" y="13" width="8" height="4" />
        <rect x="4" y="19" width="11" height="4" />
        <rect x="20" y="19" width="6" height="4" />
      </g>
      <rect x="20" y="13" width="6" height="4" fill="var(--accent)" />
    </svg>
  );
}

function Rail({ account, onPropose }: { account: string | null; onPropose: () => void }) {
  // Shelf and treasury sit beside every page, so those links keep the current path. Overview and activity live on "/".
  const links: [string, string, ReactNode][] = [
    ["/#overview", "Overview", <LayoutGrid {...ICON} />],
    ["#bounties", "Open bounties", <Layers {...ICON} />],
    ["#treasury", "Treasury", <Landmark {...ICON} />],
    ["/#activity", "Activity", <Activity {...ICON} />],
  ];
  return (
    <aside className="rail">
      <Link to="/" aria-label="DataFund">
        <Mark />
      </Link>
      <nav aria-label="Sections">
        {links.map(([href, label, icon]) => (
          <Link key={href} to={href} aria-label={label} title={label}>
            {icon}
          </Link>
        ))}
        <Link
          to="/#propose"
          aria-label="Propose a bounty"
          title="Propose a bounty"
          onClick={(e) => {
            e.preventDefault();
            onPropose();
          }}
        >
          <Plus {...ICON} />
        </Link>
      </nav>
      {account ? (
        <button className="avatar" onClick={() => signOut()} title={`Sign out ${account}`} aria-label={`Sign out ${account}`}>
          {account.slice(0, 2)}
        </button>
      ) : (
        <button className="avatar out" onClick={showSignIn} title="Connect wallet" aria-label="Connect wallet">
          <Wallet size={16} strokeWidth={1.75} />
        </button>
      )}
    </aside>
  );
}

/** A bounty drawn as a poster, with rows of text with their label chips. The hero version sets the bounty number large. */
function Cover({ b, variant }: { b: Bounty; variant: "hero" | "face" }) {
  const labels = labelsOf(b.spec);
  const rand = rng(b.id * 7919 + 13);
  const rows = Array.from({ length: variant === "hero" ? 8 : 6 }, () => ({
    w: 26 + Math.round(rand() * 46),
    l: labels.length ? Math.floor(rand() * Math.min(labels.length, 3)) : 2,
  }));
  return (
    <div className={`cover cover-${variant}`} style={themeVars(b.id)} aria-hidden>
      {variant === "face" && <span className="cover-title">{titleOf(b)}</span>}
      <div className="cover-rows">
        {rows.map((r, i) => (
          <div className="cover-row" key={i}>
            <i style={{ width: `${r.w}%` }} />
            <b className={`l${r.l}`} />
          </div>
        ))}
      </div>
      {variant === "hero" && <span className="cover-num">{pad(b.id)}</span>}
    </div>
  );
}

/** The verifier's rules, one click away from the action they govern. */
function HowVerified({ cfg }: { cfg: Config }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="how">
      <button className="link small" aria-expanded={open} onClick={() => setOpen(!open)}>
        How payouts are verified
      </button>
      {open && (
        <ol className="rules">
          <li>
            <b>Encrypted in your browser</b>
            <span>Only the verifier enclave (an Intel TDX machine the DAO approved by vote) can decrypt it. Not the requester, not the server.</span>
          </li>
          <li>
            <b>Every row checked</b>
            <span>Schema, row count, duplicates, personal data and prompt-injection attempts, on the whole file.</span>
          </li>
          <li>
            <b>Blind AI redo</b>
            <span>
              {cfg.aiEnabled ? (
                <><code>{cfg.model}</code> redoes every row (500 random rows past 2,000) without seeing the submitted answers. Junk can't hide in the rows nobody looks at.</>
              ) : (
                <>Off (no NEAR AI key). Only structural checks run.</>
              )}
            </span>
          </li>
          <li>
            <b>Decision</b>
            <span>
              Automatic bounties pass at score ≥ {cfg.minScore}. Manual bounties let the requester review a sample picked by a block
              hash nobody knew at submission, with auto review as the fallback. The enclave casts the vote and can't vote on anything else.
            </span>
          </li>
          <li>
            <b>Release</b>
            <span>Once two RPC providers confirm the payout, the enclave releases the key. Public bounties publish it. Requester-only bounties hand it to the requester alone.</span>
          </li>
        </ol>
      )}
    </div>
  );
}

const STAGES = ["Claim", "Submit data", "AI verifies and pays"];

function Featured({ b, cfg, state, account, claim, run, inDashboard }: { b: Bounty; cfg: Config; state: State; account: string | null; claim?: BountyClaim; run: RunFn; inDashboard?: boolean }) {
  const [open, setOpen] = useState(false);
  const spec = b.spec;
  const slots = b.times - b.claims;
  const at = !claim ? 0 : claim.completed ? 2 : 1;

  let action: ReactNode;
  if (!account) {
    action = (
      <button className="act" onClick={showSignIn}>
        <Wallet {...ICON} aria-hidden /> Connect to contribute
      </button>
    );
  } else if (claim?.completed) {
    action = (
      <Link className="act quiet" to="/#activity">
        <Hourglass {...ICON} aria-hidden /> Submitted. Verdict in Activity
      </Link>
    );
  } else if (claim) {
    action = (
      <button className="act" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Upload {...ICON} aria-hidden /> {open ? "Hide submission" : "Submit dataset"}
      </button>
    );
  } else {
    action = (
      <button
        className="act"
        disabled={slots <= 0}
        onClick={() => run("Claim", () => callDao(cfg.daoId, "bounty_claim", { id: b.id, deadline: b.max_deadline }, BigInt(state.bountyBond), 50n * TGAS))}
      >
        <Hand {...ICON} aria-hidden /> Claim <small>{toNear(state.bountyBond)} NEAR bond</small>
      </button>
    );
  }

  return (
    <>
      {!inDashboard && (
      <div className="meta">
        <span className="meta-label">{claim && !claim.completed ? "You're contributing to" : "Open bounty"}</span>
        <div>
          <strong className="meta-title">{titleOf(b)}</strong>
          {account && (
            <span className="meta-sub num">
              {slots} of {b.times} slots open
            </span>
          )}
          <Link className="meta-link" to={bountyPath(b.id)}>
            Bounty dashboard <ArrowUpRight size={14} strokeWidth={1.75} className="inline-icon" aria-hidden />
          </Link>
        </div>
      </div>
      )}

      <div className={`feature${THEMES[b.id % THEMES.length].bg === "#dc3514" ? " on-red" : ""}`}>
        {inDashboard ? (
          <Cover b={b} variant="hero" />
        ) : (
          <Link className="cover-link" to={bountyPath(b.id)} aria-label={`Open the dashboard for bounty ${pad(b.id)}, ${titleOf(b)}`}>
            <Cover b={b} variant="hero" />
          </Link>
        )}
        <div className="feature-actions">
          <div className="reward">
            <small>Reward</small>
            <b className="num">{toNear(b.amount)} NEAR</b>
          </div>
          {action}
        </div>
      </div>

      {account ? (
        <div className="progress" aria-label="Your progress on this bounty">
          <span>Step {at + 1} of 3</span>
          <div className="segments">
            {STAGES.map((s, i) => (
              <i key={s} className={i < at ? "done" : i === at ? "now" : ""} />
            ))}
          </div>
          <span>{STAGES[at]}</span>
        </div>
      ) : (
        <div className="progress">
          <span>Slots claimed</span>
          <div className="segments">
            {Array.from({ length: Math.max(b.times, 1) }, (_, i) => (
              <i key={i} className={i < b.claims ? "done" : ""} />
            ))}
          </div>
          <span className="num">
            {b.claims} of {b.times} taken
          </span>
        </div>
      )}
      <HowVerified cfg={cfg} />

      {open && claim && !claim.completed && spec && <SubmitPanel b={b} spec={spec} cfg={cfg} state={state} run={run} />}
    </>
  );
}

function NoBounties({ onPropose }: { onPropose: () => void }) {
  return (
    <>
      <div className="meta">
        <span className="meta-label">Open bounty</span>
        <div>
          <strong className="meta-title">Nothing open yet</strong>
          <span className="meta-sub">The council votes new bounties in</span>
        </div>
      </div>
      <div className="feature">
        <div className="cover cover-hero cover-empty">
          <span>No open bounties</span>
        </div>
        <div className="feature-actions">
          <button className="act" onClick={onPropose}>
            <Plus {...ICON} aria-hidden /> Propose a bounty
          </button>
        </div>
      </div>
    </>
  );
}

const spineVars = (id: number) => {
  const r = rng(id * 31 + 7);
  return { ...themeVars(id), "--w": `${40 + Math.floor(r() * 3) * 6}px`, "--h": `${150 + Math.floor(r() * 4) * 8}px` } as CSSProperties;
};

function Shelf({ bounties, needle, query, selected, onSelect, onPropose }: { bounties: Bounty[]; needle: string; query: string; selected?: Bounty; onSelect: (id: number) => void; onPropose: () => void }) {
  const shown = needle ? bounties.filter((b) => titleOf(b).toLowerCase().includes(needle)) : bounties;
  const total = bounties.reduce((s, b) => s + BigInt(b.amount) * BigInt(b.times), 0n);
  const i = bounties.findIndex((b) => b.id === selected?.id);
  return (
    <section id="bounties" className="panel">
      <header className="panel-head">
        <h2>Open bounties</h2>
        <span className="small muted num">
          {bounties.length} open, {toNear(total)} NEAR
        </span>
      </header>
      <div className="shelf-row">
        <div className="shelf">
          {shown.map((b) =>
            b.id === selected?.id ? (
              <Link className="face" key={b.id} to={bountyPath(b.id)} title={`Open the dashboard for ${titleOf(b)}`}>
                <Cover b={b} variant="face" />
              </Link>
            ) : (
              <button key={b.id} className="spine" style={spineVars(b.id)} onClick={() => onSelect(b.id)} title={titleOf(b)} aria-label={`Show bounty ${pad(b.id)}, ${titleOf(b)}`}>
                <span>{titleOf(b)}</span>
              </button>
            ),
          )}
          {needle && !shown.length && <span className="shelf-empty">No bounty matches “{query.trim()}”</span>}
          <button className="spine spine-new" onClick={onPropose} aria-label="Propose a bounty" title="Propose a bounty">
            <Plus size={18} strokeWidth={1.75} />
          </button>
        </div>
        {bounties.length > 1 && (
          <button className="icon" onClick={() => onSelect(bounties[(i + 1) % bounties.length].id)} aria-label="Next bounty" title="Next bounty">
            <ChevronRight {...ICON} />
          </button>
        )}
      </div>
      {selected && <p className="shelf-meta">{briefLine(selected)}</p>}
    </section>
  );
}

/** What a contributor must deliver, in one line (format, size, labels, time). */
function briefLine(b: Bounty) {
  const hours = Number(BigInt(b.max_deadline) / 3_600_000_000_000n);
  const labels = labelsOf(b.spec);
  return [
    b.spec && TASK_INFO[b.spec.task].name,
    b.spec?.format.toUpperCase(),
    b.spec && `${b.spec.minRows}+ rows`,
    b.spec?.task === "classification" && labels.length && labels.join(" / "),
    b.spec?.review === "manual" && "reviewed by requester",
    b.spec?.access === "requester" && "private to requester",
    `${hours} h to deliver`,
  ].filter(Boolean).join(", ");
}

const WAFFLE = 60;

function Treasury({ cfg, state, account, daoUrl, run }: { cfg: Config; state: State; account: string | null; daoUrl: string; run: RunFn }) {
  const [amount, setAmount] = useState("1");
  const total = BigInt(state.total);
  const available = BigInt(state.available);
  const reserved = state.bounties.reduce((s, b) => s + BigInt(b.amount) * BigInt(b.times), 0n);
  const promised = reserved < available ? reserved : available;
  const free = available - promised;
  const storage = total - available;
  const whole = nearFloat(total) || 1;
  const promisedCells = Math.round((nearFloat(promised) / whole) * WAFFLE);
  const freeCells = Math.round((nearFloat(free) / whole) * WAFFLE);
  const breakdown = `${toNear(promised)} NEAR promised to bounties, ${toNear(free)} NEAR free, ${toNear(storage)} NEAR locked for storage`;
  return (
    <section id="treasury" className="panel">
      <header className="panel-head">
        <h2>Treasury</h2>
        <a href={daoUrl} target="_blank" rel="noreferrer" aria-label="DAO account on the explorer" title="DAO account on the explorer">
          <ArrowUpRight {...ICON} />
        </a>
      </header>
      <div className="treasury-body">
        <div>
          <div className="big-num">{toNear(state.available)}</div>
          <span className="big-unit">NEAR available</span>
        </div>
        <div className="waffle-wrap" title={breakdown}>
          <span className="num">{Math.round((nearFloat(promised) / whole) * 100)}% promised</span>
          <div className="waffle" role="img" aria-label={breakdown}>
            {Array.from({ length: WAFFLE }, (_, i) => (
              <i key={i} className={i < promisedCells ? "w-promised" : i < promisedCells + freeCells ? "w-free" : ""} />
            ))}
          </div>
        </div>
      </div>
      <div className="chip-in">
        <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" aria-label="Amount in NEAR" disabled={!account} />
        {account ? (
          <button onClick={() => run("Chip in", () => chipIn(cfg.daoId, toYocto(amount)))}>Chip in</button>
        ) : (
          <button onClick={showSignIn}>Connect to chip in</button>
        )}
      </div>
      <details className="more">
        <summary>Details</summary>
        <ul className="legend num">
          <li><i className="w-promised" />{toNear(promised)} promised to bounties</li>
          <li><i className="w-free" />{toNear(free)} free</li>
          <li><i />{toNear(storage)} locked for storage</li>
        </ul>
        <p className="council">Council members are {state.council.join(", ")}</p>
      </details>
    </section>
  );
}

/** How a contributor earns from a bounty, in five steps. Amounts come from the live DAO policy. */
function HowItWorks({ cfg, state, account }: { cfg: Config; state: State; account: string | null }) {
  const steps: [ReactNode, string, ReactNode][] = [
    [<ScanSearch {...ICON} />, "Pick a bounty", "Each open bounty says what data it wants, how many rows, and what it pays."],
    [<Hand {...ICON} />, "Claim a slot", <>Post a {toNear(state.bountyBond)} NEAR bond to reserve your spot. The clock starts now.</>],
    [<Upload {...ICON} />, "Submit your dataset", <>It's encrypted in your browser and stored on IPFS. Run the free precheck first to see your score.</>],
    [<ShieldCheck {...ICON} />, "The enclave verifies it", <>It checks every row and redoes them blind with AI. A score of {cfg.minScore} or more passes, or the requester reviews a sample.</>],
    [<Coins {...ICON} />, "Get paid", "The DAO pays the reward straight to your wallet. No one in between."],
  ];
  return (
    <section id="how" className="panel">
      <header className="panel-head">
        <h2>How it works</h2>
        <span className="small muted">Earn NEAR with data</span>
      </header>
      <ol className="steps">
        {steps.map(([icon, title, text], i) => (
          <li key={title} className={i === steps.length - 1 ? "last" : ""}>
            <span className="step-icon" aria-hidden>
              {icon}
            </span>
            <div>
              <b>
                <span className="step-n num">{pad(i + 1)}</span>
                {title}
              </b>
              <p>{text}</p>
            </div>
          </li>
        ))}
      </ol>
      {account ? (
        <Link className="steps-cta" to="#bounties">
          Browse open bounties <ArrowUpRight size={14} strokeWidth={1.75} className="inline-icon" aria-hidden />
        </Link>
      ) : (
        <button className="steps-cta" onClick={showSignIn}>
          <Wallet size={14} strokeWidth={1.75} aria-hidden /> Connect a wallet to start
        </button>
      )}
      <p className="small muted steps-note">The bond stays in the treasury once you submit. It keeps spam out.</p>
    </section>
  );
}

const bountyDone = (p: ProposalView) => (typeof p.kind === "object" ? (p.kind.BountyDone as { bounty_id: number; receiver_id: string } | undefined) : undefined);

function ProposeBounty({ cfg, state, account, run, open, setOpen }: { cfg: Config; state: State; account: string | null; run: RunFn; open: boolean; setOpen: (v: boolean) => void }) {
  const [f, setF] = useState({
    title: "", guidelines: "", format: "jsonl", task: "classification" as TaskType, review: "auto" as ReviewMode, access: "public" as Access,
    textField: "text", labelField: "label", labels: "positive, negative", minAgreement: "",
    minRows: "20", sampleSize: String(MIN_SAMPLE), reviewHours: "48", reward: "1", slots: "3", hours: "48",
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const manual = f.review === "manual";
  const spec = useMemo<DatasetSpec>(() => {
    const labels = f.labels.split(",").map((s) => s.trim()).filter(Boolean);
    const fields =
      f.task === "classification"
        ? { [f.textField.trim() || "text"]: "string", ...(labels.length ? { [f.labelField.trim() || "label"]: labels.join("|") } : {}) }
        : TASK_FIELDS[f.task];
    return {
      title: f.title.trim(),
      format: f.format as "jsonl" | "csv",
      fields,
      minRows: Math.max(Number(f.minRows) || 1, manual ? MANUAL_MIN_ROWS : 1),
      guidelines: f.guidelines.trim(),
      task: f.task,
      review: f.review,
      access: f.access,
      requester: account ?? "",
      minAgreement: (Number(f.minAgreement) || Math.round(TASK_INFO[f.task].minAgreement * 100)) / 100,
      ...(manual ? { sampleSize: Math.max(MIN_SAMPLE, Number(f.sampleSize) || MIN_SAMPLE), reviewHours: Math.min(MAX_REVIEW_HOURS, Math.max(1, Number(f.reviewHours) || 48)) } : {}),
    };
  }, [f, manual, account]);

  const propose = () =>
    run("Propose bounty", () =>
      callDao(
        cfg.daoId,
        "add_proposal",
        {
          proposal: {
            description: `New dataset bounty "${spec.title}"`,
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
    <section id="propose" className="panel">
      <details className="propose" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>
          <div>
            <h2>Propose a dataset bounty</h2>
            <p>The council votes it in. Payouts come from the treasury.</p>
          </div>
          <Plus className="when-closed" size={22} strokeWidth={1.75} aria-hidden />
          <Minus className="when-open" size={22} strokeWidth={1.75} aria-hidden />
        </summary>
        <div className="propose-body">
          <div className="form">
            <label className="wide">Title<input value={f.title} onChange={set("title")} placeholder="Customer support messages labeled by intent" /></label>
            <label className="wide">Guidelines<textarea rows={3} value={f.guidelines} onChange={set("guidelines")} placeholder="What makes a good row? What must be avoided?" /></label>
            <label>Task type
              <select value={f.task} onChange={set("task")}>
                {(Object.keys(TASK_INFO) as TaskType[]).map((t) => <option key={t} value={t}>{TASK_INFO[t].name}</option>)}
              </select>
            </label>
            <label>Format<select value={f.format} onChange={set("format")}><option value="jsonl">JSONL</option><option value="csv">CSV</option></select></label>
            {f.task === "classification" ? (
              <>
                <label>Text field<input value={f.textField} onChange={set("textField")} /></label>
                <label>Label field<input value={f.labelField} onChange={set("labelField")} /></label>
                <label className="wide">Allowed labels (comma-separated)<input value={f.labels} onChange={set("labels")} /></label>
              </>
            ) : (
              <p className="wide small muted form-note">
                Each row has {Object.keys(TASK_FIELDS[f.task]).map((k, i, all) => <Fragment key={k}><code>{k}</code>{i < all.length - 1 ? (i === all.length - 2 ? " and " : ", ") : ""}</Fragment>)}.
                The AI {TASK_INFO[f.task].blind} without seeing the submitted answer.
              </p>
            )}
            <label>Review
              <select value={f.review} onChange={set("review")}>
                <option value="auto">Automatic (enclave decides)</option>
                <option value="manual">Manual (I review a sample)</option>
              </select>
            </label>
            <label>Who gets the data
              <select value={f.access} onChange={set("access")}>
                <option value="public">Everyone, after payout</option>
                <option value="requester">Only me (requester)</option>
              </select>
            </label>
            <label>AI agreement needed (%)<input value={f.minAgreement} onChange={set("minAgreement")} inputMode="numeric" placeholder={String(Math.round(TASK_INFO[f.task].minAgreement * 100))} /></label>
            <label>Min rows<input value={f.minRows} onChange={set("minRows")} inputMode="numeric" /></label>
            {manual && (
              <>
                <label>Random rows I review<input value={f.sampleSize} onChange={set("sampleSize")} inputMode="numeric" /></label>
                <label>Hours I have to decide<input value={f.reviewHours} onChange={set("reviewHours")} inputMode="numeric" /></label>
                <p className="wide small muted form-note">
                  You'll see {spec.sampleSize} random rows plus rows the AI disagrees with, never more than 20% of a file. That keeps
                  contributors safe from a reject-and-keep. Manual bounties need at least {MANUAL_MIN_ROWS} rows. If you don't decide in{" "}
                  {spec.reviewHours} h, auto review decides.
                </p>
              </>
            )}
            <label>Reward per contributor (NEAR)<input value={f.reward} onChange={set("reward")} inputMode="decimal" /></label>
            <label>Contributor slots<input value={f.slots} onChange={set("slots")} inputMode="numeric" /></label>
            <label>Hours to deliver after claiming<input value={f.hours} onChange={set("hours")} inputMode="numeric" /></label>
          </div>
          <div className="row">
            <button disabled={!account || !spec.title} onClick={propose}>Propose bounty</button>
            {!account && <span className="muted small">Connect a wallet to propose.</span>}
            {account && (manual || f.access === "requester") && (
              <span className="muted small">
                You ({account}) will be the {manual && f.access === "requester" ? "reviewer and the only one who can download the data" : manual ? "reviewer" : "only one who can download the data"}.
              </span>
            )}
          </div>
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
    return { title: `New bounty "${t}"`, sub: `${toNear(b.amount)} NEAR × ${b.times} contributors` };
  }
  if (k.BountyDone) return { title: `Payout claim for bounty ${pad(k.BountyDone.bounty_id)}` };
  if (k.Transfer) return { title: `Transfer ${toNear(k.Transfer.amount)} NEAR`, sub: `to ${k.Transfer.receiver_id}` };
  if (k.ChangePolicy) return { title: "Policy change", sub: p.description };
  if (k.AddMemberToRole?.role === "verifier") return { title: "Approve verifier enclave", sub: `${k.AddMemberToRole.member_id.slice(0, 12)}…` };
  if (k.AddMemberToRole) return { title: `Add ${k.AddMemberToRole.member_id} to ${k.AddMemberToRole.role}` };
  if (k.RemoveMemberFromRole) return { title: `Remove ${k.RemoveMemberFromRole.member_id.slice(0, 20)} from ${k.RemoveMemberFromRole.role}` };
  return { title: Object.keys(k)[0], sub: p.description };
}

const when = (ns: string) => nsToDate(ns).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function ActivityPanel({ cfg, state, account, isCouncil, needle, query, daoUrl, run }: { cfg: Config; state: State; account: string | null; isCouncil: boolean; needle: string; query: string; daoUrl: string; run: RunFn }) {
  const rows = state.proposals
    .map((p) => ({ p, d: describe(p) }))
    .filter(({ p, d }) => !needle || `${d.title} ${d.sub ?? ""} ${p.proposer} ${p.status}`.toLowerCase().includes(needle));
  return (
    <section id="activity" className="panel">
      <header className="panel-head">
        <h2>Activity</h2>
        <a className="small muted" href={daoUrl} target="_blank" rel="noreferrer" title="Every proposal and vote lives in the Sputnik DAO contract">
          On-chain <ArrowUpRight size={14} strokeWidth={1.75} className="inline-icon" aria-hidden />
        </a>
      </header>
      <div className="ledger">
        {rows.map(({ p, d }) => (
          <ProposalRow key={p.id} p={p} d={d} cfg={cfg} account={account} canVote={isCouncil && p.status === "InProgress" && !(account! in p.votes)} verdict={state.verdicts[p.id]} run={run} />
        ))}
        {!rows.length && <p className="empty">{needle ? `Nothing matches “${query.trim()}”.` : "No proposals yet."}</p>}
      </div>
    </section>
  );
}

/** One line per proposal with number, title, score and status. Details (who, when, votes, AI verdict) open on click. */
function ProposalRow({ p, d, cfg, account, canVote, verdict, run }: { p: ProposalView; d: { title: string; sub?: string }; cfg: Config; account: string | null; canVote: boolean; verdict?: Verdict; run: RunFn }) {
  const [open, setOpen] = useState(false);
  const isPayout = !!bountyDone(p);
  const voteAs = (action: "VoteApprove" | "VoteReject") =>
    run(action === "VoteApprove" ? "Approve" : "Reject", () => callDao(cfg.daoId, "act_proposal", { id: p.id, action, proposal: p.kind }, 0n, 200n * TGAS));
  return (
    <article className={`entry${open ? " open" : ""}`}>
      <button className="entry-line" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="entry-id num">{pad(p.id)}</span>
        <span className="entry-title">{d.title}</span>
        <span className="entry-score">
          {verdict && (
            <span className={`score ${verdict.decision}`} title="Verifier score">
              {verdict.score}
            </span>
          )}
        </span>
        <span className={`status s-${p.status}`}>{p.status === "InProgress" ? (isPayout ? (verdict?.decision === "review" ? "In review" : "Verifying") : "Voting") : p.status}</span>
        <ChevronDown className="entry-chev" size={16} strokeWidth={1.75} aria-hidden />
      </button>
      {canVote && (
        <div className="entry-vote">
          <span className="small muted">Waiting for your vote</span>
          <button className="ghost" onClick={() => voteAs("VoteApprove")}>Approve</button>
          <button className="ghost danger" onClick={() => voteAs("VoteReject")}>Reject</button>
        </div>
      )}
      {open && (
        <div className="entry-more">
          <div className="entry-sub">
            {[d.sub, `proposed by ${p.proposer}`, when(p.submission_time)].filter(Boolean).join(", ")}
            {isPayout && (
              <div>
                <Link to={bountyPath(bountyDone(p)!.bounty_id)}>Bounty dashboard</Link>
              </div>
            )}
          </div>
          {Object.keys(p.votes).length > 0 && (
            <div className="votes">
              {Object.entries(p.votes).map(([a, v]) => (
                <span key={a}>
                  {a === cfg.verifier ? "Verifier enclave" : a} voted <b>{v}</b>
                </span>
              ))}
            </div>
          )}
          {verdict && <VerdictView v={verdict} cfg={cfg} account={account} />}
        </div>
      )}
    </article>
  );
}

type ParticipantStatus = "Working" | "Revising" | "Overdue" | "Verifying" | "Paid" | "Rejected";
type Participant = {
  account: string;
  status: ParticipantStatus;
  /** The open claim if there is one, else the latest completed one. */
  claim?: ClaimRow;
  active: boolean;
  submissions: BountyDetail["submissions"];
  best?: number;
};

/** One row per account, joining its live claim (if any) with every payout proposal it made for this bounty. */
function participantsOf(detail: BountyDetail, now: number): Participant[] {
  const accounts = new Set([...detail.claims.map((c) => c.account), ...detail.submissions.map((s) => bountyDone(s.proposal)!.receiver_id)]);
  return [...accounts]
    .map((account) => {
      // Completed claims stay on record, and an account can hold several claims on one bounty. The open one wins.
      const mine = detail.claims.filter((c) => c.account === account);
      const active = mine.find((c) => !c.completed);
      const claim = active ?? mine.at(-1);
      const subs = detail.submissions.filter((s) => bountyDone(s.proposal)!.receiver_id === account);
      const scores = subs.flatMap((s) => (s.verdict ? [s.verdict.score] : []));
      const has = (status: string) => subs.some((s) => s.proposal.status === status);
      let status: ParticipantStatus;
      if (has("InProgress")) status = "Verifying";
      else if (active) {
        const due = Number((BigInt(active.start_time) + BigInt(active.deadline)) / 1_000_000n);
        status = due < now ? "Overdue" : subs.length ? "Revising" : "Working";
      } else if (has("Approved")) status = "Paid";
      else status = "Rejected";
      return { account, status, claim, active: !!active, submissions: subs, best: scores.length ? Math.max(...scores) : undefined };
    })
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.account.localeCompare(b.account));
}
const STATUS_ORDER: ParticipantStatus[] = ["Verifying", "Working", "Revising", "Overdue", "Paid", "Rejected"];
const STATUS_CLASS: Record<ParticipantStatus, string> = {
  Working: "s-InProgress",
  Revising: "s-InProgress",
  Verifying: "s-InProgress",
  Overdue: "s-Expired",
  Paid: "s-Approved",
  Rejected: "s-Rejected",
};

function timeLeft(ms: number) {
  if (ms <= 0) return "past deadline";
  const h = Math.floor(ms / 3_600_000);
  if (h >= 48) return `${Math.floor(h / 24)} d left`;
  if (h >= 1) return `${h} h left`;
  return `${Math.max(1, Math.floor(ms / 60_000))} min left`;
}

const detailCache = new Map<number, BountyDetail>();

/** Reads the bounty id from the URL. A non-numeric id goes back to the overview. */
function DashboardRoute({ claims, ...props }: { cfg: Config; state: State; account: string | null; isCouncil: boolean; claims: BountyClaim[]; run: RunFn }) {
  const id = parseId(useParams().id);
  if (id === undefined) return <Navigate to="/" replace />;
  return <BountyDashboard key={id} id={id} claim={claims.find((c) => c.bounty_id === id)} {...props} />;
}

function BountyDashboard({ id, cfg, state, account, isCouncil, claim, run }: { id: number; cfg: Config; state: State; account: string | null; isCouncil: boolean; claim?: BountyClaim; run: RunFn }) {
  // Start from the last copy seen this session. Back and forward then render at full height straight away,
  // and the saved scroll position holds instead of being shifted when fresh data arrives.
  const [detail, setDetail] = useState<BountyDetail | undefined>(() => detailCache.get(id));
  const [err, setErr] = useState("");

  useEffect(() => {
    let live = true;
    const load = () =>
      api<BountyDetail>(`/api/bounties/${id}`)
        .then((d) => {
          detailCache.set(id, d);
          if (live) (setDetail(d), setErr(""));
        })
        .catch((e) => live && setErr((e as Error).message));
    load();
    const t = setInterval(load, 8000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [id]);

  const back = (
    <Link className="back" to="/">
      <ArrowLeft size={16} strokeWidth={1.75} aria-hidden /> All bounties
    </Link>
  );

  if (!detail) return <DashboardSkeleton id={id} back={back} err={err && `Couldn't load bounty ${pad(id)} (${err}). Retrying…`} />;

  const b = state.bounties.find((x) => x.id === id) ?? detail.bounty;
  const now = Date.now();
  const people = participantsOf(detail, now);
  const subs = detail.submissions;
  const paid = subs.filter((s) => s.proposal.status === "Approved");
  const pending = subs.filter((s) => s.proposal.status === "InProgress");
  const scores = subs.flatMap((s) => (s.verdict ? [s.verdict.score] : []));
  const amount = BigInt(b?.amount ?? "0");
  const totalSlots = (b?.times ?? 0) + paid.length;
  const claimed = b?.claims ?? detail.claims.length;
  const open = Math.max(0, (b?.times ?? 0) - claimed);
  const spec = b?.spec ?? null;
  const hours = b ? Number(BigInt(b.max_deadline) / 3_600_000_000_000n) : undefined;

  const stats: [string, ReactNode, string][] = [
    ["Reward", `${toNear(amount)} NEAR`, "per accepted dataset"],
    ["Slots", `${open} open`, `${claimed} claimed, ${paid.length} paid, ${totalSlots} total`],
    ["Submissions", String(subs.length), pending.length ? `${pending.length} being verified` : "none pending"],
    ["Paid out", `${toNear(amount * BigInt(paid.length))} NEAR`, `of ${toNear(amount * BigInt(totalSlots))} NEAR budget`],
    ["Avg score", scores.length ? String(Math.round(scores.reduce((x, y) => x + y, 0) / scores.length)) : "None yet", `approve at ≥ ${cfg.minScore}`],
  ];

  return (
    <>
      <section className="panel hero">
        <div className="topbar">{back}</div>
        <h1 className="greeting dash-title">
          <span className="muted num">Bounty {pad(id)}</span>
          <span>{b ? titleOf(b) : "Closed bounty"}</span>
        </h1>
        {b && b.times > 0 ? (
          <Featured b={b} cfg={cfg} state={state} account={account} claim={claim} run={run} inDashboard />
        ) : (
          <p className="muted">Every slot of this bounty has been paid out. Its history stays below.</p>
        )}
      </section>

      <section className="panel dash-panel" aria-label="Bounty at a glance">
        <div className="stats">
          {stats.map(([label, value, sub]) => (
            <div className="stat" key={label}>
              <small>{label}</small>
              <b className="num">{value}</b>
              <span className="num">{sub}</span>
            </div>
          ))}
        </div>
        {totalSlots > 0 && (
          <div className="slotbar" role="img" aria-label={`${paid.length} paid, ${claimed} claimed, ${open} open of ${totalSlots} slots`}>
            {Array.from({ length: totalSlots }, (_, i) => (
              <i key={i} className={i < paid.length ? "paid" : i < paid.length + claimed ? "claimed" : ""} title={i < paid.length ? "Paid" : i < paid.length + claimed ? "Claimed" : "Open"} />
            ))}
          </div>
        )}
        {totalSlots > 0 && (
          <ul className="legend num">
            <li><i className="w-promised" />{paid.length} paid</li>
            <li><i className="w-claimed" />{claimed} claimed</li>
            <li><i />{open} open</li>
          </ul>
        )}
      </section>

      <section className="panel dash-panel">
        <header className="panel-head">
          <h2>Participants</h2>
          <span className="small muted num">{people.length} {people.length === 1 ? "contributor" : "contributors"}</span>
        </header>
        {people.length ? (
          <div className="table-wrap">
            <table className="people">
              <thead>
                <tr><th>Contributor</th><th>Status</th><th>Claimed</th><th>Deadline</th><th className="r">Submissions</th><th className="r">Best score</th></tr>
              </thead>
              <tbody>
                {people.map((p) => {
                  const due = p.active && p.claim && Number((BigInt(p.claim.start_time) + BigInt(p.claim.deadline)) / 1_000_000n);
                  return (
                    <tr key={p.account} className={p.account === account ? "you" : ""}>
                      <td>
                        <a href={`${cfg.explorer}/address/${p.account}`} target="_blank" rel="noreferrer">{p.account}</a>
                        {p.account === account && <span className="tag">you</span>}
                      </td>
                      <td><span className={`status ${STATUS_CLASS[p.status]}`}>{p.status}</span></td>
                      <td className="num">{p.claim ? when(p.claim.start_time) : <span className="muted">Not claimed</span>}</td>
                      <td className="num">{due ? <span title={new Date(due).toLocaleString()}>{timeLeft(due - now)}</span> : <span className="muted">{p.claim ? "Submitted" : "None"}</span>}</td>
                      <td className="num r">{p.submissions.length}</td>
                      <td className="num r">
                        {p.best !== undefined ? <span className={`score ${p.best >= cfg.minScore ? "approve" : "reject"}`}>{p.best}</span> : <span className="muted">None</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty">Nobody has claimed this bounty yet.</p>
        )}
        <p className="small muted footnote">
          The DAO contract stores claims by account and can't list them by bounty. This list checks the {detail.checkedAccounts} accounts
          DataFund knows about (connected wallets, proposers, council). A claim made from another app shows up once that account
          submits or connects here.
        </p>
      </section>

      <section className="panel dash-panel">
        <header className="panel-head">
          <h2>Submissions</h2>
          <span className="small muted num">{subs.length} total, {paid.length} paid</span>
        </header>
        <div className="ledger">
          {subs.map(({ proposal: p, verdict }) => (
            <ProposalRow
              key={p.id}
              p={p}
              d={{ title: bountyDone(p)!.receiver_id, sub: verdict?.rows ? `${verdict.rows} rows` : undefined }}
              cfg={cfg}
              account={account}
              canVote={isCouncil && p.status === "InProgress" && !(account! in p.votes)}
              verdict={verdict ?? undefined}
              run={run}
            />
          ))}
          {!subs.length && <p className="empty">No datasets submitted yet.</p>}
        </div>
      </section>

      {(spec || b) && (
        <section className="panel dash-panel">
          <header className="panel-head">
            <h2>Brief</h2>
          </header>
          {spec ? (
            <>
              {spec.guidelines && <p className="guidelines">{spec.guidelines}</p>}
              <dl className="brief">
                <dt>Task</dt><dd>{TASK_INFO[spec.task].name}</dd>
                <dt>Review</dt><dd>{spec.review === "manual" ? `Requester ${spec.requester || "(not set)"} reviews ${spec.sampleSize} random rows plus AI-flagged rows within ${spec.reviewHours} h, then auto review decides` : "Automatic, inside the enclave"}</dd>
                <dt>Access</dt><dd>{spec.access === "requester" ? `Only ${spec.requester || "the requester"} can download the data after payout` : "Public after payout"}</dd>
                <dt>AI agreement needed</dt><dd className="num">{Math.round(spec.minAgreement * 100)}%</dd>
                <dt>Format</dt><dd>{spec.format.toUpperCase()}</dd>
                <dt>Minimum rows</dt><dd className="num">{spec.minRows}</dd>
                {hours !== undefined && (<><dt>Time to deliver</dt><dd className="num">{hours} h after claiming</dd></>)}
                {Object.entries(spec.fields).map(([field, type]) => (
                  <Fragment key={field}>
                    <dt><code>{field}</code></dt>
                    <dd>{type.includes("|") ? type.split("|").join(" / ") : type}</dd>
                  </Fragment>
                ))}
              </dl>
            </>
          ) : (
            <p className="guidelines">{b!.description}</p>
          )}
        </section>
      )}
    </>
  );
}

/** A placeholder block in the shape of the content it stands in for. */
function Sk({ w, h, className = "" }: { w?: number | string; h?: number | string; className?: string }) {
  return <span className={`sk ${className}`} style={{ width: w, height: h }} aria-hidden />;
}

/** Placeholder rows for a ledger or table while data loads. */
function SkRows({ n, cols }: { n: number; cols: (number | string)[] }) {
  return (
    <div className="sk-rows" aria-hidden>
      {Array.from({ length: n }, (_, i) => (
        <div className="sk-row" key={i}>
          {cols.map((w, j) => (
            <Sk key={j} w={w} h={12} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** First paint before config and chain state arrive. Mirrors the real layout so nothing jumps when data lands. */
function AppSkeleton({ route, err }: { route?: number; err?: string }) {
  return (
    <div className="app" aria-busy="true">
      {route === undefined && <span className="sr-only" role="status">{err || "Loading DataFund"}</span>}
      <aside className="rail" aria-hidden>
        <Mark />
        <nav>
          {Array.from({ length: 5 }, (_, i) => (
            <Sk key={i} w={20} h={20} />
          ))}
        </nav>
        <Sk w={32} h={32} />
      </aside>

      <div className="col col-main">
        {route !== undefined ? (
          <DashboardSkeleton id={route} back={<Sk w={110} h={16} />} err={err} />
        ) : (
        <>
        <section className="panel hero" aria-hidden>
          <div className="topbar">
            <Sk w={200} h={16} />
            <Sk w={180} h={24} />
          </div>
          {err && <p className="err sk-err">{err}</p>}
          <div className="greeting sk-greeting">
            <Sk w="42%" h="0.9em" />
            <Sk w="64%" h="0.9em" />
          </div>
          <div className="meta">
            <Sk w={80} h={12} />
            <div className="sk-stack">
              <Sk w="60%" h={14} />
              <Sk w={110} h={12} />
            </div>
          </div>
          <Sk className="sk-cover" />
          <div className="progress">
            <Sk w={90} h={12} />
            <Sk w="100%" h={3} />
            <Sk w={70} h={12} />
          </div>
        </section>
        <section id="propose" className="panel sk-propose" aria-hidden>
          <Sk w="100%" h={72} />
        </section>
        <section id="activity" className="panel" aria-hidden>
          <header className="panel-head">
            <Sk w={80} h={14} />
          </header>
          <SkRows n={5} cols={[20, "55%", 64]} />
        </section>
        </>
        )}
      </div>

      <div className="col col-side">
        <section id="bounties" className="panel" aria-hidden>
          <header className="panel-head">
            <Sk w={120} h={14} />
            <Sk w={80} h={12} />
          </header>
          <div className="shelf sk-shelf">
            <Sk w={136} h={192} />
            {[166, 150, 174].map((h, i) => (
              <Sk key={i} w={40} h={h} />
            ))}
          </div>
          <Sk w="70%" h={12} className="sk-gap" />
        </section>
        <section id="treasury" className="panel" aria-hidden>
          <header className="panel-head">
            <Sk w={80} h={14} />
          </header>
          <div className="treasury-body">
            <div className="sk-stack">
              <Sk w={120} h={44} />
              <Sk w={90} h={12} />
            </div>
            <Sk w={108} h={64} />
          </div>
          <Sk w="100%" h={40} className="sk-gap" />
        </section>
        <section id="how" className="panel" aria-hidden>
          <header className="panel-head">
            <Sk w={110} h={14} />
          </header>
          <div className="sk-stack sk-steps">
            {Array.from({ length: 5 }, (_, i) => (
              <div className="sk-step" key={i}>
                <Sk w={40} h={40} />
                <div className="sk-stack">
                  <Sk w={120} h={14} />
                  <Sk w="85%" h={10} />
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

/** The bounty dashboard's shape while its participants and submissions load. */
function DashboardSkeleton({ id, back, err }: { id: number; back: ReactNode; err?: string }) {
  return (
    <>
      <section className="panel hero" aria-busy="true">
        <span className="sr-only" role="status">{err || `Loading bounty ${pad(id)}`}</span>
        <div className="topbar">{back}</div>
        {err && <p className="err sk-err">{err}</p>}
        <div className="greeting dash-title sk-greeting" aria-hidden>
          <Sk w={110} h="0.4em" />
          <Sk w="70%" h="0.9em" />
        </div>
        <Sk className="sk-cover" />
        <div className="progress" aria-hidden>
          <Sk w={90} h={12} />
          <Sk w="100%" h={3} />
          <Sk w={70} h={12} />
        </div>
      </section>
      <section className="panel dash-panel" aria-hidden>
        <div className="stats">
          {Array.from({ length: 5 }, (_, i) => (
            <div className="stat" key={i}>
              <Sk w={56} h={10} />
              <Sk w={88} h={28} />
              <Sk w={110} h={10} />
            </div>
          ))}
        </div>
        <Sk w="100%" h={8} className="sk-gap" />
      </section>
      <section className="panel dash-panel" aria-hidden>
        <header className="panel-head">
          <Sk w={110} h={14} />
          <Sk w={80} h={12} />
        </header>
        <SkRows n={3} cols={["34%", 64, 100, 70, 24, 32]} />
      </section>
    </>
  );
}
