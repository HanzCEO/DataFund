import { providers } from "near-api-js";

/** Public, keyless endpoints from https://docs.near.org/api/rpc/providers. archival-rpc.*.near.org is left out as "severely rate limited". */
export const PUBLIC_RPCS: Record<string, string[]> = {
  testnet: [
    "https://test.rpc.fastnear.com",
    "https://near-testnet.drpc.org",
    "https://testnet-rpc.intea.rs",
    "https://api.zan.top/near-testnet",
  ],
  mainnet: [
    "https://free.rpc.fastnear.com",
    "https://near.drpc.org",
    "https://rpc.intea.rs",
    "https://rpc.shitzuapes.xyz",
    "https://api.zan.top/near-mainnet",
  ],
};

const COOLDOWN_MS = 30_000;

/** Errors that say "this node can't serve you right now", as opposed to a real answer (contract panic, unknown account…). */
function isTransient(e: unknown): boolean {
  const err = e as { cause?: unknown; type?: string; message?: string; name?: string };
  if (typeof err.cause === "number" && (err.cause === 408 || err.cause === 429 || err.cause >= 500)) return true;
  if (err.type === "RetriesExceeded" || err.type === "TimeoutError") return true;
  const msg = `${err.name ?? ""} ${err.message ?? ""}`;
  return /fetch failed|Failed to fetch|FetchError|ECONN|ETIMEDOUT|ENOTFOUND|socket|rate limit|-429|Too Many Requests|unavailable/i.test(msg);
}

/**
 * Round-robin over several RPC nodes. Each request starts at the next node in turn. If that node is rate-limited
 * or down, the request moves on to the following one and the failing node sits out for 30 s.
 * Every JsonRpcProvider method goes through sendJsonRpc, which is the only thing overridden here.
 */
export class RoundRobinProvider extends providers.JsonRpcProvider {
  private readonly nodes: { url: string; rpc: InstanceType<typeof providers.JsonRpcProvider>; downUntil: number }[];
  private next = 0;

  constructor(urls: string[]) {
    if (!urls.length) throw new Error("RoundRobinProvider needs at least one RPC URL");
    super({ url: urls[0] });
    // One attempt per node. Rotating to another node beats retrying a rate-limited one.
    this.nodes = urls.map((url) => ({ url, rpc: new providers.JsonRpcProvider({ url }, { retries: 1 }), downUntil: 0 }));
  }

  get urls() {
    return this.nodes.map((n) => n.url);
  }

  override async sendJsonRpc<T>(method: string, params: object): Promise<T> {
    const start = this.next++ % this.nodes.length;
    const order = this.nodes.map((_, i) => this.nodes[(start + i) % this.nodes.length]);
    const now = Date.now();
    // Healthy nodes first. Cooling-down ones are a last resort, not skipped outright.
    const tries = [...order.filter((n) => n.downUntil <= now), ...order.filter((n) => n.downUntil > now)];
    let last: unknown;
    for (const node of tries) {
      try {
        const result = await node.rpc.sendJsonRpc<T>(method, params);
        node.downUntil = 0;
        return result;
      } catch (e) {
        if (!isTransient(e)) throw e;
        node.downUntil = Date.now() + COOLDOWN_MS;
        last = e;
        console.warn(`[rpc] ${node.url} failed ${method} (${String((e as Error).message ?? e).slice(0, 120)})`);
      }
    }
    throw last;
  }
}
