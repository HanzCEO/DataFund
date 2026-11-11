// Ask the DAO to make an enclave its verifier. Reads the enclave's attestation, funds its implicit account for gas,
// and files proposals that (1) add it to the verifier role, with the attestation in the description, and (2) remove
// the old verifier. The council checks the attestation and votes.
//
// ENCLAVE_URL=https://<app>-8788.<gateway> PROPOSER=you.testnet [OLD_VERIFIER=old.testnet] [FUND=1] npm run enclave:approve
// Add ALLOW_DEV=true to approve a dev-mode enclave on testnet (no attestation, for demos only).
import { execFileSync } from "node:child_process";
import { sha256Hex } from "../shared/crypto.js";
import type { Attestation } from "../shared/types.js";

try {
  process.loadEnvFile(".env");
} catch {
  // optional
}
const must = (k: string) => process.env[k] || (() => { throw new Error(`Missing env ${k}`); })();
const NETWORK = process.env.NEAR_NETWORK ?? "testnet";
const DAO = must("DAO_ID");
const PROPOSER = must("PROPOSER");
const URL_ = must("ENCLAVE_URL").replace(/\/$/, "");
const FUND = process.env.FUND ?? "1";

const att = (await (await fetch(`${URL_}/attestation`)).json()) as Attestation;
if (att.mode !== "tee" && process.env.ALLOW_DEV !== "true") throw new Error("This enclave runs in dev mode (no TEE). Set ALLOW_DEV=true to approve it anyway on testnet");

const description = JSON.stringify({
  enclave: att.accountId,
  mode: att.mode,
  sealPublicKey: att.sealPublicKey,
  nearPublicKey: att.nearPublicKey,
  reportData: att.reportData,
  composeHash: att.composeHash ?? null,
  appId: att.appId ?? null,
  osImageHash: att.osImageHash ?? null,
  quoteSha256: att.quote ? await sha256Hex(att.quote) : null,
  attestation: `${URL_}/attestation`,
});
console.log(`Enclave ${att.accountId} (${att.mode})\n${description}\n`);

const near = (...args: string[]) => execFileSync("npx", ["near", ...args], { stdio: "inherit" });

if (Number(FUND) > 0) {
  console.log(`Funding ${att.accountId} with ${FUND} NEAR for gas`);
  near("tokens", PROPOSER, "send-near", att.accountId, `${FUND} NEAR`, "network-config", NETWORK, "sign-with-legacy-keychain", "send");
}

const propose = (desc: string, kind: object) =>
  near(
    "contract", "call-function", "as-transaction", DAO, "add_proposal",
    "json-args", JSON.stringify({ proposal: { description: desc, kind } }),
    "prepaid-gas", "100 Tgas", "attached-deposit", "0 NEAR",
    "sign-as", PROPOSER, "network-config", NETWORK, "sign-with-legacy-keychain", "send",
  );

propose(description, { AddMemberToRole: { member_id: att.accountId, role: "verifier" } });
if (process.env.OLD_VERIFIER)
  propose(`Retire the old verifier ${process.env.OLD_VERIFIER} in favour of enclave ${att.accountId}`, {
    RemoveMemberFromRole: { member_id: process.env.OLD_VERIFIER, role: "verifier" },
  });
console.log("\nProposals filed. Council members vote on them in the app or with scripts/demo.sh approve.");
