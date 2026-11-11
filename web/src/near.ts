import { setupWalletSelector, type WalletSelector } from "@near-wallet-selector/core";
import { setupModal, type WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import "@near-wallet-selector/modal-ui/styles.css";
import { transactions } from "near-api-js";
import { Buffer } from "buffer";
import type { SignedRequest } from "../../shared/types";

export const TGAS = 1_000_000_000_000n;
const YOCTO = 10n ** 24n;

export function toNear(yocto: string | bigint, digits = 2): string {
  const v = BigInt(yocto);
  const whole = v / YOCTO;
  const frac = (v % YOCTO).toString().padStart(24, "0").slice(0, digits).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function toYocto(near: string): bigint {
  const [w, f = ""] = near.trim().split(".");
  if (!/^\d+$/.test(w || "0") || !/^\d*$/.test(f)) throw new Error("Invalid amount");
  return BigInt(w || "0") * YOCTO + BigInt((f + "0".repeat(24)).slice(0, 24));
}

let selector: WalletSelector;
let modal: WalletSelectorModal;

export async function initWallet(network: string, daoId: string) {
  selector = await setupWalletSelector({
    network: network as "testnet" | "mainnet",
    modules: [setupMyNearWallet(), setupMeteorWallet()],
  });
  modal = setupModal(selector, { contractId: daoId, description: "Sign in to chip in, vote and submit datasets." });
  return selector;
}

export const showSignIn = () => modal.show();

export async function signOut() {
  const w = await selector.wallet();
  await w.signOut();
}

export async function currentAccount(): Promise<string | null> {
  const s = selector.store.getState();
  return s.accounts.find((a) => a.active)?.accountId ?? null;
}

/** Call a DAO method from the user's wallet. */
export async function callDao(daoId: string, methodName: string, args: object, deposit = 0n, gas = 150n * TGAS) {
  const w = await selector.wallet();
  return w.signAndSendTransaction({
    receiverId: daoId,
    actions: [transactions.functionCall(methodName, args, gas, deposit)],
  });
}

export async function chipIn(daoId: string, amount: bigint) {
  const w = await selector.wallet();
  return w.signAndSendTransaction({ receiverId: daoId, actions: [transactions.transfer(amount)] });
}

/** Sign a NEP-413 message for the enclave. Nothing is sent on-chain and it costs no gas. */
export async function signReview(daoId: string, message: object): Promise<SignedRequest> {
  const w = await selector.wallet();
  if (!("signMessage" in w) || typeof w.signMessage !== "function") throw new Error("This wallet can't sign messages");
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
  const callbackUrl = window.location.href;
  const msg = JSON.stringify(message);
  const signed = await w.signMessage({ message: msg, recipient: daoId, nonce, callbackUrl });
  if (!signed?.signature) throw new Error("The wallet returned no signature");
  return {
    accountId: signed.accountId,
    publicKey: signed.publicKey,
    signature: signed.signature,
    message: msg,
    nonce: nonce.toString("base64"),
    recipient: daoId,
    callbackUrl,
  };
}
