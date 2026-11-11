// Wallet SDKs expect Node's Buffer in the browser.
import { Buffer } from "buffer";
(globalThis as any).Buffer ??= Buffer;
// The dev server pre-bundles near-api-js untransformed, and it reads process.env at import time.
if (import.meta.env.DEV) (globalThis as any).process ??= { env: {} };
