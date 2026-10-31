// Cluster role: one stateless proxy in front of two workers that arbitrate
// phone ownership through Redis leases. Clients (Rails) only talk to the
// proxy; the tests also reach the workers directly to see the routing.
import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import {
  api,
  clusterRedis,
  connect,
  dirs,
  eventually,
  keys,
  newPhone,
  urls,
  waitForDelivery,
} from "../support/harness";

const workers = { "worker-1": urls.worker1, "worker-2": urls.worker2 } as const;
type WorkerId = keyof typeof workers;
const otherWorker = (id: WorkerId): WorkerId =>
  id === "worker-1" ? "worker-2" : "worker-1";

const health = async (base: string) =>
  (await api("GET", "/cluster/health", { base, key: null })).json;

// Where the proxy placed a phone, read from the workers' own answers: the
// owner serves the state, the other one redirects with 421.
async function ownerOf(phone: string): Promise<WorkerId> {
  const res = await api("GET", `/connections/${phone}`, {
    base: urls.worker1,
  });
  return res.status === 421 ? "worker-2" : "worker-1";
}

const redis = clusterRedis();
const seeded: string[] = [];
const seededFiles: string[] = [];

afterAll(async () => {
  for (const key of seeded) {
    await redis.del(key);
  }
  for (const file of seededFiles) {
    await rm(file, { force: true });
  }
  redis.close();
});

describe("proxy front door", () => {
  test("GET /cluster/health identifies the proxy", async () => {
    expect(await health(urls.proxy)).toEqual({
      instanceId: expect.any(String),
      role: "proxy",
      connectionCount: 0,
      draining: false,
    });
  });

  test("the workers register under their INSTANCE_ID", async () => {
    expect(await health(urls.worker1)).toMatchObject({
      instanceId: "worker-1",
      role: "worker",
    });
    expect(await health(urls.worker2)).toMatchObject({
      instanceId: "worker-2",
      role: "worker",
    });
  });

  test("GET /status is public and reports the proxy role", async () => {
    const res = await api("GET", "/status", { base: urls.proxy, key: null });
    expect(res.status).toBe(200);
    expect(res.json.cluster.role).toBe("proxy");
    expect(res.json.proxy.maxBodyBytes).toBe(65_536);
  });

  test("checks keys itself: 401 without, 200 with", async () => {
    const phone = newPhone();
    for (const path of ["/status/auth", `/connections/${phone}`]) {
      const res = await api("GET", path, { base: urls.proxy, key: null });
      expect(res.status).toBe(401);
      expect(
        (await api("GET", path, { base: urls.proxy, key: "nope" })).status,
      ).toBe(401);
    }
    expect(
      (await api("GET", "/status/auth", { base: urls.proxy })).status,
    ).toBe(200);
  });

  test("404 for any per-phone route of a phone nobody owns", async () => {
    const phone = newPhone();
    for (const [method, action] of [
      ["GET", ""],
      ["POST", "/send-message"],
      ["GET", "/group-fetch-all-participating"],
    ]) {
      const res = await api(method, `/connections/${phone}${action}`, {
        base: urls.proxy,
        body: method === "POST" ? {} : undefined,
      });
      expect(res.status).toBe(404);
      expect(res.json).toEqual({
        error: "Not Found",
        message: "Phone number not connected",
      });
    }
  });

  test("413 when a body exceeds PROXY_MAX_BODY_BYTES", async () => {
    const res = await api("POST", `/connections/${newPhone()}`, {
      base: urls.proxy,
      body: JSON.stringify({ pad: "x".repeat(70_000) }),
    });

    expect(res.status).toBe(413);
    expect(res.json).toEqual({
      error: "Payload Too Large",
      message: "Request body exceeds the 65536-byte limit",
    });
  });
});

describe("lease-owner routing", () => {
  test("a connect lands on one worker and the proxy follows the lease", async () => {
    const phone = newPhone();
    const { hook, response } = await connect(phone, { base: urls.proxy });
    expect(response.status).toBe(200);

    // The owning worker emits the webhooks, epoch-stamped by its lease.
    const first = await waitForDelivery(hook.name);
    expect(first.body.data).toMatchObject({ connection: "reconnecting" });
    expect(first.body.data.epoch).toBeGreaterThan(0);

    const owner = await ownerOf(phone);
    const other = otherWorker(owner);

    // The proxy forwards per-phone reads to the owner.
    const viaProxy = await api("GET", `/connections/${phone}`, {
      base: urls.proxy,
    });
    expect(viaProxy.status).toBe(200);
    expect(viaProxy.json.data.connection).toBe("reconnecting");

    // A request that lands on the wrong worker is told who owns the phone.
    const misdirected = await api(
      "POST",
      `/connections/${phone}/send-message`,
      {
        base: workers[other],
        body: {
          jid: "5511988887777@s.whatsapp.net",
          messageContent: { text: "x" },
        },
      },
    );
    expect(misdirected.status).toBe(421);
    expect(misdirected.headers.get("x-baileys-owner")).toBe(owner);
    expect(misdirected.json).toEqual({
      error: "Misdirected Request",
      message: "Connection is owned by another instance",
    });

    // An explicit connect on the wrong worker must not steal a live owner...
    const takeover = await api("POST", `/connections/${phone}`, {
      base: workers[other],
      body: { webhookUrl: hook.url, webhookVerifyToken: "e2e-verify-token" },
    });
    expect(takeover.status).toBe(409);
    expect(takeover.headers.get("x-baileys-owner")).toBe(owner);

    // ...and neither may a logout.
    const logout = await api("DELETE", `/connections/${phone}`, {
      base: workers[other],
    });
    expect(logout.status).toBe(421);
    expect(logout.headers.get("x-baileys-owner")).toBe(owner);

    // Through the proxy the logout reaches the owner and frees the lease.
    const deleted = await api("DELETE", `/connections/${phone}`, {
      base: urls.proxy,
    });
    expect(deleted.status).toBe(200);
    const gone = await api("GET", `/connections/${phone}`, {
      base: urls.proxy,
    });
    expect(gone.status).toBe(404);
  }, 30_000);

  test("after the phone moves to the other worker the proxy re-routes", async () => {
    const phone = newPhone();
    await connect(phone, { base: urls.proxy });
    const first = await ownerOf(phone);
    const second = otherWorker(first);

    // Free it on the first owner, then claim it explicitly on the other one.
    expect(
      (await api("DELETE", `/connections/${phone}`, { base: workers[first] }))
        .status,
    ).toBe(200);
    const { response } = await connect(phone, { base: workers[second] });
    expect(response.status).toBe(200);

    // The proxy may still cache the first owner; that worker answers 421 and
    // the proxy retries on the new one. Either way the caller sees the owner.
    const res = await api("GET", `/connections/${phone}`, {
      base: urls.proxy,
    });
    expect(res.status).toBe(200);
    expect(await ownerOf(phone)).toBe(second);
    expect((await health(workers[second])).connectionCount).toBeGreaterThan(0);

    await api("DELETE", `/connections/${phone}`, { base: urls.proxy });
  }, 30_000);

  test("503 + retry-after while a dead owner still holds the lease", async () => {
    const phone = newPhone();
    const key = `@baileys-api:cluster:lease:${phone}`;
    seeded.push(key);
    await redis.set(key, JSON.stringify({ owner: "ghost-worker", epoch: 1 }));

    const res = await api("GET", `/connections/${phone}`, {
      base: urls.proxy,
    });

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(res.json).toEqual({
      error: "Service Unavailable",
      message: "Connection owner is down, failover in progress",
    });

    // A worker serves locally rather than advertise an owner that is gone.
    const direct = await api("GET", `/connections/${phone}`, {
      base: urls.worker1,
    });
    expect(direct.status).toBe(404);
  });
});

describe("proxy media routing", () => {
  test("forwards GET /media to the worker that stored the file", async () => {
    const messageId = `E2ECLUSTER${Date.now()}`;
    const ownerKey = `@baileys-api:media-owner:${messageId}`;
    const file = `${dirs.worker1Media}/${messageId}`;
    seeded.push(ownerKey);
    seededFiles.push(file);
    await Bun.write(file, "cluster media");
    await redis.set(ownerKey, "worker-1");

    const res = await api("GET", `/media/${messageId}`, { base: urls.proxy });

    expect(res.status).toBe(200);
    expect(res.text).toBe("cluster media");
  });

  test("404 when no worker claims the file", async () => {
    const res = await api("GET", "/media/NOSUCHCLUSTERMEDIA", {
      base: urls.proxy,
    });
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: "Not Found", message: "File not found" });
  });

  test("404 when the claiming worker is gone", async () => {
    const messageId = `E2EGHOST${Date.now()}`;
    const ownerKey = `@baileys-api:media-owner:${messageId}`;
    seeded.push(ownerKey);
    await redis.set(ownerKey, "ghost-worker");

    const res = await api("GET", `/media/${messageId}`, { base: urls.proxy });
    expect(res.status).toBe(404);
  });

  test("401 without a key", async () => {
    const res = await api("GET", "/media/ANY", {
      base: urls.proxy,
      key: null,
    });
    expect(res.status).toBe(401);
  });
});

describe("admin fan-out", () => {
  test("a user key gets 404, no key 401", async () => {
    const path = "/admin/connections/logout-all";
    expect((await api("POST", path, { base: urls.proxy })).status).toBe(404);
    expect(
      (await api("POST", path, { base: urls.proxy, key: null })).status,
    ).toBe(401);
  });

  test("logout-all reaches every worker and empties them", async () => {
    // One phone per worker, so the fan-out has something to do on both.
    const phones = [newPhone(), newPhone()];
    await connect(phones[0], { base: urls.worker1 });
    await connect(phones[1], { base: urls.worker2 });
    await eventually(
      async () => [await health(urls.worker1), await health(urls.worker2)],
      (all) => all.every((h) => h.connectionCount > 0),
    );

    const res = await api("POST", "/admin/connections/logout-all", {
      base: urls.proxy,
      key: keys.admin,
    });

    expect(res.status).toBe(200);
    expect(
      [...res.json.results].sort((a, b) =>
        a.instanceId.localeCompare(b.instanceId),
      ),
    ).toEqual([
      { instanceId: "worker-1", status: 200 },
      { instanceId: "worker-2", status: 200 },
    ]);
    expect((await health(urls.worker1)).connectionCount).toBe(0);
    expect((await health(urls.worker2)).connectionCount).toBe(0);
  }, 30_000);
});
