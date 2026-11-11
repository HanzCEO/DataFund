// Creates the community data fund DAO from the public Sputnik DAO v2 factory.
// Run with OWNER=... VERIFIER=... DAO_NAME=... npm run setup:dao
// Requires the OWNER key in ~/.near-credentials/testnet (near-cli legacy keychain).
import { execFileSync } from "node:child_process";

const NETWORK = process.env.NEAR_NETWORK ?? "testnet";
const FACTORY = process.env.FACTORY ?? "sputnik-v2.testnet";
const OWNER = must("OWNER");
const VERIFIER = must("VERIFIER");
const DAO_NAME = must("DAO_NAME"); // becomes <DAO_NAME>.<FACTORY>
const DEPOSIT = process.env.DAO_DEPOSIT ?? "6 NEAR"; // ~4.75 NEAR is locked for contract storage

const NEAR = (n: number) => (BigInt(Math.round(n * 1000)) * 10n ** 21n).toString(); // NEAR -> yocto
const NS = (hours: number) => (BigInt(hours) * 3600n * 10n ** 9n).toString();

const policy = {
  roles: [
    // Anyone can propose (e.g. a new dataset bounty) by posting the proposal bond.
    { name: "all", kind: "Everyone", permissions: ["*:AddProposal"], vote_policy: {} },
    // Community council. Votes on bounties, transfers and membership.
    {
      name: "council",
      kind: { Group: [OWNER] },
      permissions: ["*:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize"],
      vote_policy: {},
    },
    // AI verifier bot. It can ONLY approve/reject bounty payouts. One vote decides.
    {
      name: "verifier",
      kind: { Group: [VERIFIER] },
      permissions: ["bounty_done:VoteApprove", "bounty_done:VoteReject"],
      vote_policy: {},
    },
  ],
  default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] },
  // Must be 0. On the deployed Sputnik v2, bounty_done() rejects deposits but
  // internally asserts deposit == proposal_bond. Any bond > 0 breaks payouts.
  proposal_bond: "0",
  proposal_period: NS(72),
  bounty_bond: NEAR(0.1),
  bounty_forgiveness_period: NS(24),
};

const args = {
  config: {
    name: DAO_NAME,
    purpose: "Community data fund. Pool money, fund dataset bounties and pay contributors when an AI verifier accepts their data.",
    metadata: "",
  },
  policy,
};

const createArgs = JSON.stringify({
  name: DAO_NAME,
  args: Buffer.from(JSON.stringify(args)).toString("base64"),
});

console.log(`Creating ${DAO_NAME}.${FACTORY} (owner ${OWNER}, verifier ${VERIFIER})`);
execFileSync(
  "npx",
  [
    "near", "contract", "call-function", "as-transaction", FACTORY, "create",
    "json-args", createArgs,
    "prepaid-gas", "300 Tgas", "attached-deposit", DEPOSIT,
    "sign-as", OWNER, "network-config", NETWORK, "sign-with-legacy-keychain", "send",
  ],
  { stdio: "inherit" },
);
console.log(`\nCreated DAO ${DAO_NAME}.${FACTORY}`);

function must(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env ${k}`);
  return v;
}
