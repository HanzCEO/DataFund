# DataFund, community-funded datasets on NEAR

**Track** Social Money (shared budgets and community rewards with Sputnik DAO)

DataFund lets a community pool NEAR in a Sputnik DAO treasury, vote on which datasets to fund, and pay
contributors automatically once an AI verifier accepts their work. Bounties, submissions and payout votes are
on-chain, and the app shows the checks and reasons behind each verdict.

## How it works

```
 Members ──chip in NEAR──▶  Sputnik DAO treasury
 Member  ──AddBounty proposal──▶ council votes ──▶ bounty is open
 Contributor ──bounty_claim (bond)──▶ uploads data ──bounty_done(url, sha256)──▶ BountyDone proposal
 Verifier bot ──fetch + hash check + structural checks + NEAR AI blind re-labelling──▶ VoteApprove / VoteReject
 DAO ──payout on approval──▶ Contributor
```

- **Treasury and governance.** A Sputnik DAO v2 created from the public factory `sputnik-v2.testnet` (no custom contract).
- **Verifier role.** The bot account is the only member of a `verifier` role whose permissions are just
  `bounty_done:VoteApprove` and `bounty_done:VoteReject`. It can vote on bounty payouts and nothing else. The human
  council can still vote on any proposal.
- **Verifier** (`server/verifier.ts`)
  1. Fetches the dataset (https only, private addresses blocked, 2 MB cap) and checks its sha256 against the one
     written on-chain at submission.
  2. Runs deterministic checks for clean parsing, minimum rows, schema and label values, duplicates, personal data
     (emails or phone numbers), prompt-injection attempts and label balance.
  3. Runs AI review on NEAR AI Cloud (`z-ai/glm-5.3-flash`, a TEE-verifiable model). A deterministic sample of
     rows (seeded by the file hash) is sent **without the submitted labels**. The model labels each row itself,
     and the verifier computes the agreement rate. Because the model never sees the labels it is grading,
     contributors can't steer the agreement rate.
  4. Score = 30% structural + 40% label agreement + 30% AI quality rating. It approves at 70 or more, provided
     no hard check failed. Label agreement under 80% counts as a hard failure, because a well-formed dataset with
     wrong labels passes every rule check.
- **Off-chain storage.** Only the URL and sha256 go on-chain. Contributors can link their own https file or
  upload one to the app, which stores it content-addressed under `data/uploads/`.

## Run it

You need Node 20+ (tested on Node 24). Rust is not needed.

```bash
npm install
cp .env.example .env          # optionally add NEAR_AI_API_KEY (https://cloud.near.ai)
npm run build                 # build the web UI
npx tsx server/index.ts       # API + watcher + UI on http://localhost:8787
```

For development with hot reload, run `npm run dev` (UI on http://localhost:5173).

`.env.example` points at the live demo DAO `datafund-41bbcc.sputnik-v2.testnet`. To run your own, do this.

```bash
npx near account create-account sponsor-by-faucet-service <owner>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
npx near account create-account sponsor-by-faucet-service <verifier>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
OWNER=<owner>.testnet VERIFIER=<verifier>.testnet DAO_NAME=<name> npm run setup:dao
```

Then set `DAO_ID=<name>.sputnik-v2.testnet` and `VERIFIER_ACCOUNT` in `.env`.

Chain reads and verifier votes rotate round-robin across the public keyless RPC providers from
[docs.near.org](https://docs.near.org/api/rpc/providers) (`server/rpc.ts`). A rate-limited or unreachable node is
skipped for 30 seconds. Set `NEAR_RPC_URLS` (comma-separated) to use your own list. The verifier key is read from
`~/.near-credentials/testnet/`, or from `VERIFIER_PRIVATE_KEY`.

## Try it

1. Open http://localhost:8787. The page shows the treasury balance, open bounties and an activity feed read from
   the DAO.
2. Click **Connect wallet** and sign in with a testnet account (MyNearWallet or Meteor). Then **Chip in** 1 NEAR.
   The available balance goes up once the transaction lands.
3. Open **Propose a dataset bounty**, fill in the title, labels and reward, and submit. A "New bounty" proposal
   appears in Activity. Once a council member clicks **Approve**, it moves to Open bounties.
4. On a bounty, click **Claim**, then **Submit dataset** → **good dataset** → **Precheck**. Every check passes.
   With **bad dataset**, the precheck rejects it for too few rows, a duplicate, an email/phone number and a
   prompt-injection attempt. With **mislabeled dataset**, every rule check passes but the verdict is still a
   rejection, because the AI's blind labels disagree with the submitted ones.
5. Load the good dataset again and click **Submit on-chain**. Within about 10 seconds a "Payout claim" shows up in
   Activity. It turns **Approved** after the verifier votes, the contributor's wallet receives the reward, and
   **Show AI verdict** lists every check plus a link to the vote transaction.
6. Click a bounty's cover or **Bounty dashboard** to open its dashboard. It shows the reward, slots, payouts,
   average score, every participant with their status and deadline, each submission's verdict and the brief.

### From the terminal (no browser wallet needed)

`scripts/demo.sh` signs each step with keys in `~/.near-credentials`, and the UI updates live.

```bash
scripts/demo.sh chip-in  you.testnet 2
scripts/demo.sh propose  you.testnet "Scam vs legit SMS" "scam|legit" 1    # prints proposal id
scripts/demo.sh approve  you.testnet <proposal-id>                           # each council member votes
scripts/demo.sh claim    you.testnet <bounty-id>
scripts/demo.sh submit   you.testnet <bounty-id> web/public/examples/sms-scam-good.jsonl
scripts/demo.sh status   you.testnet
```

These runs were verified on testnet.
- **Proposal #6.** A bounty that needed both council votes. It stayed `InProgress` after one vote and became
  `Approved` after the second.
- **Proposal #7.** A good dataset. The verifier scored it 96 and approved, and 1 NEAR was paid out.
- **Proposal #8.** A mislabeled dataset. Every rule check passed, but AI label agreement was 46%. The verifier
  rejected it and no payout was made.

## Notes and known limits

- **Sputnik v2 quirks on testnet.** The factory deploys an older contract version. `bounty_done` rejects attached
  deposits but checks `deposit == proposal_bond`. `proposal_bond` must be 0 for payouts to work. Also, a
  completed claim stays on record. Each account can complete a given bounty once. That works as a
  "one submission per contributor" rule.
- **Claim bond.** In this contract version the 0.1 NEAR claim bond is refunded only through `bounty_giveup`
  within the forgiveness period. Once work is submitted, the bond stays in the treasury as an anti-spam stake.
- Uploaded files are stored by this server. For production, swap in IPFS or another content-addressed store,
  since the on-chain sha256 already makes the storage location replaceable.
- Testnet only. No real funds.

## Built with

- [Sputnik DAO v2](https://github.com/near-daos/sputnik-dao-contract) for treasury, bounties, proposals and voting
- [NEAR AI Cloud](https://docs.near.ai/) for OpenAI-compatible inference on TEE-verifiable models
- near-api-js, NEAR Wallet Selector (MyNearWallet, Meteor), near-cli-rs
- Hono, React, Vite, TypeScript

## AI disclosure

Most of this code was written with Claude Code (Anthropic) under the author's direction. The author chose the
design, ran the testnet tests and reviewed the result.

## License

MIT. See [LICENSE](LICENSE).
