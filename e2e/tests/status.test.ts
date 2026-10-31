// Public and key-check endpoints of a standalone instance.
import { describe, expect, test } from "bun:test";
import { api, keys, redisSecret } from "../support/harness";

describe("GET /status", () => {
  test("is public and returns the running config", async () => {
    const res = await api("GET", "/status", { key: null });

    expect(res.status).toBe(200);
    expect(res.json.packageInfo.name).toBe("@fazer-ai/baileys-api");
    expect(res.json.env).toBe("production");
    expect(res.json.port).toBe(3025);
    expect(res.json.cluster.role).toBe("standalone");
    expect(res.json.webhook.retryPolicy).toEqual({
      maxRetries: 1,
      retryInterval: 200,
      backoffFactor: 1,
    });
  });

  test("never leaks the Redis password", async () => {
    const res = await api("GET", "/status", { key: null });

    expect(res.json.redis.url).toBe("redis://redis:6379");
    expect(res.json.redis.password).toBe("********");
    expect(res.text).not.toContain(redisSecret);
  });
});

describe("GET /status/auth", () => {
  test("401 without a key", async () => {
    const res = await api("GET", "/status/auth", { key: null });

    expect(res.status).toBe(401);
    expect(res.json).toEqual({
      error: "Unauthorized",
      message: "Valid API key required",
    });
  });

  test("401 with an unknown key", async () => {
    expect((await api("GET", "/status/auth", { key: "nope" })).status).toBe(
      401,
    );
  });

  test("401 with an empty key", async () => {
    expect((await api("GET", "/status/auth", { key: "" })).status).toBe(401);
  });

  test("200 OK with a user key and with an admin key", async () => {
    for (const key of [keys.user, keys.admin]) {
      const res = await api("GET", "/status/auth", { key });
      expect(res.status).toBe(200);
      expect(res.text).toBe("OK");
    }
  });
});

describe("GET /cluster/health", () => {
  test("is public and reports identity and load", async () => {
    const res = await api("GET", "/cluster/health", { key: null });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      instanceId: expect.any(String),
      role: "standalone",
      connectionCount: expect.any(Number),
      draining: false,
    });
  });
});

describe("Swagger", () => {
  test("GET /swagger serves the UI without a key", async () => {
    const res = await api("GET", "/swagger", { key: null });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.text).toContain("@fazer-ai/baileys-api");
  });

  test("GET /swagger/json documents every route the gateway serves", async () => {
    const res = await api("GET", "/swagger/json", { key: null });

    expect(res.status).toBe(200);
    expect(res.json.openapi).toMatch(/^3\./);
    expect(res.json.components.securitySchemes.xApiKey).toMatchObject({
      type: "apiKey",
      in: "header",
      name: "x-api-key",
    });
    const paths = res.json.paths;
    expect(Object.keys(paths)).toHaveLength(40);
    // The live-state read the checked-in swagger.json is missing.
    expect(paths["/connections/{phoneNumber}"]).toHaveProperty("get");
    expect(paths["/connections/{phoneNumber}"]).toHaveProperty("post");
    expect(paths["/connections/{phoneNumber}"]).toHaveProperty("delete");
    expect(paths["/admin/connections/logout-all"]).toHaveProperty("post");
    expect(paths["/media/{messageId}"]).toHaveProperty("get");
    expect(paths["/cluster/health"]).toHaveProperty("get");
  });
});
