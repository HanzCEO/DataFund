// Generates the demo datasets in web/public/examples. Deterministic. Reruns give the same files.
// Run with npx tsx scripts/make-examples.ts
import { writeFileSync } from "node:fs";

const OUT = "web/public/examples";
let state = 20261111;
const rnd = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
const write = (name: string, rows: object[]) => writeFileSync(`${OUT}/${name}`, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

/** Unique rows by a key, up to n. */
function unique<T>(n: number, make: () => T, key: (t: T) => string): T[] {
  const seen = new Set<string>(), out: T[] = [];
  for (let guard = 0; out.length < n && guard < n * 50; guard++) {
    const t = make();
    if (!seen.has(key(t))) seen.add(key(t)), out.push(t);
  }
  return out;
}

// ---------- Question and answer ----------
const CAPITALS: [string, string][] = [
  ["France", "Paris"], ["Japan", "Tokyo"], ["Kenya", "Nairobi"], ["Canada", "Ottawa"], ["Australia", "Canberra"],
  ["Brazil", "Brasília"], ["Egypt", "Cairo"], ["Norway", "Oslo"], ["Peru", "Lima"], ["Thailand", "Bangkok"],
  ["Portugal", "Lisbon"], ["Vietnam", "Hanoi"], ["Chile", "Santiago"], ["Ghana", "Accra"], ["Poland", "Warsaw"],
  ["Turkey", "Ankara"], ["Indonesia", "Jakarta"], ["Argentina", "Buenos Aires"], ["Sweden", "Stockholm"], ["Morocco", "Rabat"],
];
type QA = { question: string; answer: string };
function qa(): QA {
  const k = int(0, 5);
  if (k === 0) { const a = int(12, 99), b = int(12, 99); return { question: `What is ${a} × ${b}?`, answer: String(a * b) }; }
  if (k === 1) { const a = int(100, 999), b = int(100, 999); return { question: `What is ${a} + ${b}?`, answer: String(a + b) }; }
  if (k === 2) { const km = int(2, 90); return { question: `How many meters are in ${km} kilometers?`, answer: String(km * 1000) }; }
  if (k === 3) { const h = int(2, 30); return { question: `How many minutes are in ${h} hours?`, answer: String(h * 60) }; }
  if (k === 4) { const [c, cap] = pick(CAPITALS); return { question: `What is the capital of ${c}?`, answer: cap }; }
  const a = int(200, 999), b = int(10, 199);
  return { question: `What is ${a} minus ${b}?`, answer: String(a - b) };
}
const qaRows = unique(600, qa, (r) => r.question);
const wrongAnswer = (r: QA): QA =>
  /^\d+$/.test(r.answer) ? { ...r, answer: String(Number(r.answer) + pick([-10, -3, 7, 11, 100])) } : { ...r, answer: pick(CAPITALS.map((c) => c[1]).filter((c) => c !== r.answer)) };
write("qa-good.jsonl", qaRows);
write("qa-wrong.jsonl", qaRows.map((r, i) => (i % 2 ? wrongAnswer(r) : r)));

// ---------- Preference pairs ----------
const NAMES = ["Ana", "Ben", "Chen", "Dara", "Eli", "Fatima", "Goran", "Hana", "Ivan", "Jun", "Kofi", "Lena", "Mateo", "Nia", "Omar", "Priya"];
const ITEMS = ["blender", "backpack", "desk lamp", "rain jacket", "coffee grinder", "keyboard", "water bottle", "yoga mat", "phone case", "toaster"];
type Pref = { prompt: string; response_a: string; response_b: string; preferred: "a" | "b" };
function pref(): Pref {
  const k = int(0, 2);
  let prompt: string, good: string, bad: string;
  if (k === 0) {
    const a = int(12, 99), b = int(12, 99);
    prompt = `What is ${a} times ${b}? Show the result.`;
    good = `${a} × ${b} = ${a * b}.`;
    bad = `${a} × ${b} = ${a * b + pick([-12, 9, 21, 100])}.`;
  } else if (k === 1) {
    const name = pick(NAMES), item = pick(ITEMS), days = int(3, 25);
    prompt = `Write a short reply to ${name}, who wants to return a ${item} bought ${days} days ago. Returns are allowed within 30 days.`;
    good = `Hi ${name}, thanks for reaching out. Your ${item} is within our 30-day window and we can take it back. I've emailed you a return label.`;
    bad = pick([`No returns. Read the policy.`, `Hi ${name}, unfortunately returns are only possible within 7 days. We can't help.`]);
  } else {
    const city = pick(CAPITALS);
    prompt = `In one sentence, what is the capital of ${city[0]}?`;
    good = `The capital of ${city[0]} is ${city[1]}.`;
    bad = `The capital of ${city[0]} is ${pick(CAPITALS.filter((c) => c[1] !== city[1]))[1]}.`;
  }
  const goodFirst = rnd() < 0.5;
  return goodFirst ? { prompt, response_a: good, response_b: bad, preferred: "a" } : { prompt, response_a: bad, response_b: good, preferred: "b" };
}
const prefRows = unique(600, pref, (r) => r.prompt + r.response_a + r.response_b);
write("pref-good.jsonl", prefRows);
write("pref-flipped.jsonl", prefRows.map((r, i) => (i % 2 ? { ...r, preferred: r.preferred === "a" ? "b" : "a" } : r)));

// ---------- SMS classification, large ----------
const BRANDS = ["ParcelGo", "SwiftShip", "MetroBank", "UnionPay", "TelcoOne", "StreamFlix", "CloudDrive", "TaxOffice"];
const SITES = ["parcelgo-fee.top", "secure-metrobank.help", "refund-taxoffice.click", "verify-telco1.info", "prize-claim.win", "wallet-restore.app"];
type Sms = { text: string; label: "scam" | "legit" };
function sms(): Sms {
  if (rnd() < 0.5) {
    const t = int(0, 5), brand = pick(BRANDS), site = pick(SITES), amt = int(2, 99);
    const text = [
      `${brand}: your parcel is on hold. Pay a ${amt}.${int(10, 99)} USD fee within 24h at ${site} or it will be returned.`,
      `${brand} security alert. Your account is locked. Verify your card now at ${site} to avoid closure.`,
      `Congratulations! Your number won ${amt},000 USD in the ${brand} draw. Claim at ${site} before midnight.`,
      `You have a pending tax refund of ${amt * 37} USD. Submit your bank details at ${site} today.`,
      `Your ${brand} subscription failed to renew. Update payment at ${site} or lose access in ${int(2, 12)} hours.`,
      `Send ${amt} USDT to double it instantly! Limited ${brand} promo, details at ${site}.`,
    ][t];
    return { text, label: "scam" };
  }
  const t = int(0, 5), name = pick(NAMES), h = int(8, 18), m = pick(["00", "15", "30", "45"]);
  const text = [
    `Hi, this is Dr. ${name}'s office confirming your appointment on ${pick(["Monday", "Tuesday", "Thursday", "Friday"])} at ${h}:${m}. Reply C to confirm.`,
    `${pick(BRANDS)}: your parcel was delivered to the front desk at ${h}:${m}. No action needed.`,
    `Your verification code is ${int(100000, 999999)}. It expires in ${int(5, 15)} minutes. Never share it.`,
    `Hey it's ${name}, running ${int(5, 25)} min late, save me a seat!`,
    `Reminder from the library. "${pick(["Dune", "Beloved", "Emma", "Kindred", "Ulysses"])}" is due back on the ${int(2, 28)}th.`,
    `${name}, your table for ${int(2, 8)} at ${h}:${m} tonight is confirmed. See you soon.`,
  ][t];
  return { text, label: "legit" };
}
const smsRows = unique(600, sms, (r) => r.text);
write("sms-scam-large.jsonl", smsRows);
// A facade. The first 70% is honest, the rest has its labels flipped, hoping a reviewer only looks at the top.
write("sms-scam-facade.jsonl", smsRows.map((r, i) => (i >= 420 ? { ...r, label: r.label === "scam" ? "legit" : "scam" } : r)));

console.log(`wrote ${qaRows.length} QA, ${prefRows.length} preference and ${smsRows.length} SMS rows`);
