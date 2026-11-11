import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

// The public server keeps no datasets and no verdicts. Those live in the enclave.
const DATA_DIR = process.env.DATA_DIR ?? "data";
const FILE = join(DATA_DIR, "accounts.json");
mkdirSync(DATA_DIR, { recursive: true });

let accounts: string[] = [];
try {
  accounts = JSON.parse(readFileSync(FILE, "utf8"));
} catch {
  // First run. Carry over accounts from the old single-server store.
  try {
    accounts = JSON.parse(readFileSync(join(DATA_DIR, "verdicts.json"), "utf8")).accounts ?? [];
  } catch {
    // nothing to carry over
  }
}

/**
 * Accounts that connected a wallet to this app. The DAO contract keys claims by account and can't list who
 * claimed a bounty. The bounty dashboard checks these accounts, among others, to find participants.
 */
export const knownAccounts = () => accounts;
export function rememberAccount(accountId: string) {
  if (accounts.includes(accountId)) return;
  accounts.push(accountId);
  writeFileSync(FILE + ".tmp", JSON.stringify(accounts));
  renameSync(FILE + ".tmp", FILE);
}
