// API-key auth (fail-closed), the admin guard and per-key connection ownership.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api, connect, keys, newPhone } from "../support/harness";

const unauthorized = {
  error: "Unauthorized",
  message: "Valid API key required",
};

describe("fail-closed API-key auth", () => {
  const phone = newPhone();
  const protectedRoutes: [string, string, unknown?][] = [
    ["GET", "/status/auth"],
    ["GET", `/connections/${phone}`],
    ["DELETE", `/connections/${phone}`],
    [
      "POST",
      `/connections/${phone}`,
      { webhookUrl: "http://tests:4000/hook/x", webhookVerifyToken: "abcdef" },
    ],
    [
      "POST",
      `/connections/${phone}/send-message`,
      { jid: "5511988887777@s.whatsapp.net", messageContent: { text: "hi" } },
    ],
    ["GET", "/media/ABC123"],
    ["POST", "/admin/connections/logout-all"],
  ];

  for (const [method, path, body] of protectedRoutes) {
    test(`${method} ${path.replace(phone, ":phone")} -> 401 without a key`, async () => {
      const res = await api(method, path, { key: null, body });
      expect(res.status).toBe(401);
      expect(res.json).toEqual(unauthorized);
    });

    test(`${method} ${path.replace(phone, ":phone")} -> 401 with an unknown key`, async () => {
      const res = await api(method, path, { key: "not-a-key", body });
      expect(res.status).toBe(401);
    });
  }

  test("a key deleted with manage-api-keys is rejected", async () => {
    // run.sh created and then deleted this key through the CLI before the
    // suite started, so no instance ever cached it.
    const res = await api("GET", "/status/auth", { key: keys.revoked });
    expect(res.status).toBe(401);
  });

  // KNOWN BUG: TypeBox validation runs before the auth beforeHandle, so an
  // unauthenticated caller gets 422 (echoing the schema violation) instead of
  // 401. src/middlewares/auth.ts:60 checks auth in onBeforeHandle, which
  // Elysia runs after params/body validation.
  test.todo("KNOWN BUG: an invalid body without a key is rejected with 401, not 422", async () => {
    const res = await api("POST", `/connections/${phone}/send-message`, {
      key: null,
      body: {},
    });
    expect(res.status).toBe(401);
  });
});

describe("admin guard", () => {
  test("a user key gets 404 NOT_FOUND (the route hides itself)", async () => {
    const res = await api("POST", "/admin/connections/logout-all", {
      key: keys.user,
    });
    expect(res.status).toBe(404);
    expect(res.text).toBe("NOT_FOUND");
  });

  test("an admin key passes", async () => {
    const res = await api("POST", "/admin/connections/logout-all", {
      key: keys.admin,
    });
    expect(res.status).toBe(200);
  });
});

describe("connection ownership", () => {
  const phone = newPhone();

  // A connect waits out the offline WhatsApp version fetch (~5s), and a
  // logout queues behind it.
  beforeAll(async () => {
    const { response } = await connect(phone, { key: keys.user });
    expect(response.status).toBe(200);
  }, 30_000);

  afterAll(async () => {
    await api("DELETE", `/connections/${phone}`, { key: keys.user });
  }, 30_000);

  test("the owning key can read the connection", async () => {
    expect((await api("GET", `/connections/${phone}`)).status).toBe(200);
  });

  const forbidden = {
    error: "Forbidden",
    message: "Connection not owned by this API key",
  };

  for (const [label, key] of [
    ["another user key", keys.user2],
    ["an admin key", keys.admin],
  ] as const) {
    test(`${label} gets 403 on read, send, reconnect and logout`, async () => {
      const calls: [string, string, unknown?][] = [
        ["GET", `/connections/${phone}`],
        [
          "POST",
          `/connections/${phone}/send-message`,
          {
            jid: "5511988887777@s.whatsapp.net",
            messageContent: { text: "x" },
          },
        ],
        [
          "POST",
          `/connections/${phone}`,
          {
            webhookUrl: "http://tests:4000/hook/steal",
            webhookVerifyToken: "steal1",
          },
        ],
        ["DELETE", `/connections/${phone}`],
      ];
      for (const [method, path, body] of calls) {
        const res = await api(method, path, { key, body });
        expect(`${method} ${res.status}`).toBe(`${method} 403`);
        expect(res.json).toEqual(forbidden);
      }
      // Still there for its owner.
      expect((await api("GET", `/connections/${phone}`)).status).toBe(200);
    });
  }
});
