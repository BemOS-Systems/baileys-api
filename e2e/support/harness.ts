// Shared plumbing for the black-box suite: env, an HTTP client that plays
// Rails, and the webhook receiver the SUT posts to (http://tests:4000).
//
// bun test runs every file in one process, so the receiver is a process-wide
// singleton: the first import binds the port, later imports reuse it.
import { RedisClient } from "bun";

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing env ${name} (run the suite through e2e/run.sh)`);
  }
  return value;
};

export const urls = {
  baileys: env("BAILEYS_URL"),
  proxy: env("PROXY_URL"),
  worker1: env("WORKER_1_URL"),
  worker2: env("WORKER_2_URL"),
  webhookBase: env("WEBHOOK_BASE_URL"),
};

export const keys = {
  user: env("E2E_USER_KEY"),
  user2: env("E2E_USER2_KEY"),
  admin: env("E2E_ADMIN_KEY"),
  revoked: env("E2E_REVOKED_KEY"),
};

export const dirs = {
  media: env("MEDIA_DIR"),
  worker1Media: env("WORKER_1_MEDIA_DIR"),
};

export const redisSecret = env("E2E_REDIS_PASSWORD");

// Gray-box arrangement only: seeding states the black box cannot reach
// offline (a dead lease owner, a media owner pointer) and nothing else.
export const clusterRedis = () => new RedisClient(env("REDIS_CLUSTER_URL"));

export interface ApiResponse {
  status: number;
  headers: Headers;
  text: string;
  json: any;
}

export async function api(
  method: string,
  path: string,
  {
    base = urls.baileys,
    key = keys.user,
    body,
  }: { base?: string; key?: string | null; body?: unknown } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = {};
  if (key !== null) {
    headers["x-api-key"] = key;
  }
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body:
      body === undefined
        ? undefined
        : typeof body === "string"
          ? body
          : JSON.stringify(body),
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, text, json };
}

// Unique per call so no two tests (or two runs on a reused stack) ever share
// a phone, its lease or its Redis auth state.
let phoneSeq = 0;
export function newPhone(): string {
  phoneSeq += 1;
  const stamp = `${Date.now()}`.slice(-6);
  return `+5519${stamp}${String(phoneSeq).padStart(3, "0")}`;
}

export const sleep = (ms: number) => Bun.sleep(ms);

export async function eventually<T>(
  probe: () => Promise<T>,
  done: (value: T) => boolean,
  { timeoutMs = 10_000, intervalMs = 250 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await probe();
  while (!done(last)) {
    if (Date.now() > deadline) {
      throw new Error(
        `condition not met in ${timeoutMs}ms; last value: ${JSON.stringify(last)}`,
      );
    }
    await sleep(intervalMs);
    last = await probe();
  }
  return last;
}

// --- webhook receiver -------------------------------------------------------

export interface Delivery {
  hook: string;
  at: number;
  contentType: string | null;
  body: any;
}

interface Receiver {
  deliveries: Delivery[];
  failures: Map<string, number>;
}

const globalKey = Symbol.for("baileys-api-e2e.receiver");
const g = globalThis as unknown as Record<symbol, Receiver | undefined>;

function receiver(): Receiver {
  const existing = g[globalKey];
  if (existing) {
    return existing;
  }
  const state: Receiver = { deliveries: [], failures: new Map() };
  Bun.serve({
    port: Number(env("WEBHOOK_PORT")),
    hostname: "0.0.0.0",
    async fetch(request) {
      const { pathname } = new URL(request.url);
      const hook = pathname.replace(/^\/hook\//, "");
      state.deliveries.push({
        hook,
        at: Date.now(),
        contentType: request.headers.get("content-type"),
        body: await request.json().catch(() => null),
      });
      const remaining = state.failures.get(hook) ?? 0;
      if (remaining > 0) {
        state.failures.set(hook, remaining - 1);
        return new Response("receiver says no", { status: 500 });
      }
      return new Response("ok");
    },
  });
  g[globalKey] = state;
  return state;
}

receiver();

// A webhook endpoint unique to the caller; its name keys every lookup below.
let hookSeq = 0;
export function newHook(label: string): { name: string; url: string } {
  hookSeq += 1;
  const name = `${label}-${Date.now()}-${hookSeq}`;
  return { name, url: `${urls.webhookBase}/hook/${name}` };
}

export function deliveries(hook: string): Delivery[] {
  return receiver().deliveries.filter((d) => d.hook === hook);
}

// The receiver answers 500 to the next `count` deliveries on this hook.
export function failNext(hook: string, count: number) {
  receiver().failures.set(hook, count);
}

export async function waitForDelivery(
  hook: string,
  match: (delivery: Delivery) => boolean = () => true,
  timeoutMs = 15_000,
): Promise<Delivery> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = deliveries(hook).find(match);
    if (found) {
      return found;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `no matching webhook on ${hook} within ${timeoutMs}ms; got ${JSON.stringify(deliveries(hook).map((d) => d.body))}`,
      );
    }
    await sleep(100);
  }
}

// Connects `phone` through `base` with a fresh hook; returns the hook.
export async function connect(
  phone: string,
  {
    base = urls.baileys,
    key = keys.user,
    token = "e2e-verify-token",
    extra = {},
  }: {
    base?: string;
    key?: string;
    token?: string;
    extra?: Record<string, unknown>;
  } = {},
) {
  const hook = newHook("conn");
  const response = await api("POST", `/connections/${phone}`, {
    base,
    key,
    body: { webhookUrl: hook.url, webhookVerifyToken: token, ...extra },
  });
  return { hook, response };
}
