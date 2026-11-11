// Wallet SDKs expect Node's Buffer in the browser.
import { Buffer } from "buffer";
(globalThis as any).Buffer ??= Buffer;
