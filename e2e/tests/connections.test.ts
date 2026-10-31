// Connection lifecycle against a standalone instance with no route to
// WhatsApp: the socket never opens, so everything observable is the gateway's
// own contract — the HTTP replies, the live-state read, and the
// connection.update webhooks it sends while it retries.
import { describe, expect, test } from "bun:test";
import {
  api,
  connect,
  deliveries,
  eventually,
  failNext,
  keys,
  newHook,
  newPhone,
  sleep,
  waitForDelivery,
} from "../support/harness";

const connectionLost = { statusCode: 408, reason: "connection_lost" };

describe("POST /connections/:phone", () => {
  test("accepts the connect and reports progress to the webhook", async () => {
    const phone = newPhone();
    const { hook, response } = await connect(phone, {
      token: "verify-me-123",
    });

    expect(response.status).toBe(200);
    expect(response.text).toBe("");

    // The envelope Rails parses: event + data + the verify token it set.
    const first = await waitForDelivery(hook.name);
    expect(first.contentType).toBe("application/json");
    expect(first.body).toEqual({
      event: "connection.update",
      data: { connection: "reconnecting", epoch: expect.any(Number) },
      webhookVerifyToken: "verify-me-123",
    });
    expect(first.body.data.epoch).toBeGreaterThan(0);

    // With no network the socket closes with a reason the consumer can act on.
    const lost = await waitForDelivery(
      hook.name,
      (d) => d.body.data.disconnect !== undefined,
    );
    expect(lost.body.data).toEqual({
      connection: "reconnecting",
      disconnect: connectionLost,
      epoch: first.body.data.epoch,
    });
    expect(lost.body.webhookVerifyToken).toBe("verify-me-123");

    await api("DELETE", `/connections/${phone}`);
  }, 30_000);

  test("GET returns the live state last reported to the webhook", async () => {
    const phone = newPhone();
    const { hook } = await connect(phone);
    await waitForDelivery(hook.name, (d) => d.body.data.disconnect);

    const res = await api("GET", `/connections/${phone}`);

    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      data: { connection: "reconnecting", disconnect: connectionLost },
    });

    const health = await api("GET", "/cluster/health", { key: null });
    expect(health.json.connectionCount).toBeGreaterThanOrEqual(1);

    await api("DELETE", `/connections/${phone}`);
  }, 30_000);

  test("a second POST re-targets the webhook URL and verify token", async () => {
    const phone = newPhone();
    const { hook: oldHook } = await connect(phone, { token: "old-token" });
    await waitForDelivery(oldHook.name);

    const { hook: newHookTarget, response } = await connect(phone, {
      token: "new-token",
    });
    expect(response.status).toBe(200);

    const delivery = await waitForDelivery(newHookTarget.name);
    expect(delivery.body.webhookVerifyToken).toBe("new-token");

    // Once the new hook is live, nothing reaches the old one. A delivery to
    // the old hook still in flight at re-POST time lands well before this
    // first new-hook event (the respawned socket needs ~5s to fail), so any
    // old-hook event after it is a real leak, not a race.
    await waitForDelivery(newHookTarget.name, (d) => d.at > delivery.at);
    expect(deliveries(oldHook.name).filter((d) => d.at > delivery.at)).toEqual(
      [],
    );

    await api("DELETE", `/connections/${phone}`);
  }, 30_000);

  test("accepts usePairingCode (the code itself needs a real WhatsApp)", async () => {
    const phone = newPhone();
    const { hook, response } = await connect(phone, {
      extra: { usePairingCode: true, clientName: "E2E" },
    });

    expect(response.status).toBe(200);
    const first = await waitForDelivery(hook.name);
    expect(first.body.data).not.toHaveProperty("pairingCode");

    await api("DELETE", `/connections/${phone}`);
  }, 30_000);

  test("retries a webhook the receiver rejects", async () => {
    const phone = newPhone();
    const hook = newHook("flaky");
    failNext(hook.name, 1);

    await api("POST", `/connections/${phone}`, {
      body: { webhookUrl: hook.url, webhookVerifyToken: "flaky-token" },
    });

    // Same payload twice: the 500 and then the retry that succeeds.
    await eventually(
      async () => deliveries(hook.name),
      (all) => all.length >= 2,
    );
    const [rejected, retried] = deliveries(hook.name);
    expect(retried.body).toEqual(rejected.body);
    expect(retried.at - rejected.at).toBeGreaterThanOrEqual(200);

    await api("DELETE", `/connections/${phone}`);
  }, 30_000);

  describe("validation", () => {
    const phone = newPhone();
    const valid = {
      webhookUrl: "http://tests:4000/hook/never",
      webhookVerifyToken: "abcdef",
    };

    test("422 for a phone without the + prefix", async () => {
      const res = await api("POST", "/connections/5511999990000", {
        body: valid,
      });
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({ type: "validation", on: "params" });
    });

    test("422 for a webhookUrl that is not a URI", async () => {
      const res = await api("POST", `/connections/${phone}`, {
        body: { ...valid, webhookUrl: "not a url" },
      });
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({ type: "validation", on: "body" });
    });

    test("422 for a verify token shorter than 6 characters", async () => {
      const res = await api("POST", `/connections/${phone}`, {
        body: { ...valid, webhookVerifyToken: "12345" },
      });
      expect(res.status).toBe(422);
    });

    test("422 when the webhook fields are missing", async () => {
      const res = await api("POST", `/connections/${phone}`, { body: {} });
      expect(res.status).toBe(422);
    });
  });
});

describe("DELETE /connections/:phone", () => {
  test("logs out: the connection is gone and the webhook goes quiet", async () => {
    const phone = newPhone();
    const { hook } = await connect(phone);
    await waitForDelivery(hook.name);
    const before = (await api("GET", "/cluster/health", { key: null })).json
      .connectionCount;

    const res = await api("DELETE", `/connections/${phone}`);

    expect(res.status).toBe(200);
    expect((await api("GET", `/connections/${phone}`)).status).toBe(404);
    const after = (await api("GET", "/cluster/health", { key: null })).json
      .connectionCount;
    expect(after).toBe(before - 1);

    // The retry loop fires every ~5s; a logged-out connection must not.
    const count = deliveries(hook.name).length;
    await sleep(6_000);
    expect(deliveries(hook.name)).toHaveLength(count);
  }, 30_000);

  test("is idempotent for a phone that was never connected", async () => {
    const res = await api("DELETE", `/connections/${newPhone()}`);
    expect(res.status).toBe(200);
  });
});

describe("GET /connections/:phone", () => {
  test("404 for a phone this instance does not hold", async () => {
    const res = await api("GET", `/connections/${newPhone()}`);

    expect(res.status).toBe(404);
    expect(res.json).toEqual({
      error: "Not Found",
      message: "Phone number not connected",
    });
  });
});

describe("POST /admin/connections/logout-all", () => {
  test("logs out every connection on the instance", async () => {
    const phones = [newPhone(), newPhone()];
    for (const phone of phones) {
      const { hook } = await connect(phone);
      await waitForDelivery(hook.name);
    }
    const before = (await api("GET", "/cluster/health", { key: null })).json
      .connectionCount;
    expect(before).toBeGreaterThanOrEqual(phones.length);

    const res = await api("POST", "/admin/connections/logout-all", {
      key: keys.admin,
    });

    expect(res.status).toBe(200);
    for (const phone of phones) {
      expect((await api("GET", `/connections/${phone}`)).status).toBe(404);
    }
    // Relative to this test's own count: whatever else the shared instance
    // held, at least this test's phones are gone.
    const after = (await api("GET", "/cluster/health", { key: null })).json
      .connectionCount;
    expect(after).toBeLessThanOrEqual(before - phones.length);
  }, 30_000);
});

describe("reconnect loop guard", () => {
  // Ten failed reconnects (one every ~5s with no network) trip the guard.
  test("gives up after 10 reconnects, quarantines and drops the connection", async () => {
    const phone = newPhone();
    const { hook } = await connect(phone, { token: "loop-token" });

    const gaveUp = await waitForDelivery(
      hook.name,
      (d) => d.body.data.error !== undefined,
      90_000,
    );

    expect(gaveUp.body).toEqual({
      event: "connection.update",
      data: {
        error: "reconnect_loop_detected",
        quarantine: { strikes: 1, until: expect.any(String) },
        epoch: expect.any(Number),
      },
      webhookVerifyToken: "loop-token",
    });
    expect(Date.parse(gaveUp.body.data.quarantine.until)).toBeGreaterThan(
      gaveUp.at - 1_000,
    );
    const reconnects = deliveries(hook.name).filter(
      (d) => d.body.data.connection === "reconnecting",
    );
    expect(reconnects).toHaveLength(10);
    expect((await api("GET", `/connections/${phone}`)).status).toBe(404);

    await api("DELETE", `/connections/${phone}`);
  }, 120_000);
});
