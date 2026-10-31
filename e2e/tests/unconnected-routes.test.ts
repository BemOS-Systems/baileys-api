// Every per-phone route Rails can call, against a phone this instance does
// not hold. Without a paired WhatsApp account this is the whole observable
// contract of the messaging, presence, contact and group surfaces: auth,
// schema validation, and how "not connected" is reported.
import { describe, expect, test } from "bun:test";
import { api, newPhone } from "../support/harness";

const J = "5511988887777@s.whatsapp.net";
const G = "120363000000000000@g.us";
const KEY = { id: "3EB0E2E000000001", remoteJid: J, fromMe: false };

interface Route {
  method: string;
  action: string;
  body?: Record<string, unknown>;
  query?: Record<string, string>;
  // Routes whose handler maps "not connected" to 404.
  notFound?: boolean;
}

const routes: Route[] = [
  { method: "PATCH", action: "presence", body: { type: "available" } },
  { method: "POST", action: "presence-subscribe", body: { jids: [J] } },
  {
    method: "POST",
    action: "send-message",
    body: { jid: J, messageContent: { text: "hi" } },
    notFound: true,
  },
  { method: "POST", action: "read-messages", body: { keys: [KEY] } },
  {
    method: "POST",
    action: "chat-modify",
    body: {
      jid: J,
      mod: { markRead: true, lastMessages: [{ key: KEY, messageTimestamp: 1 }] },
    },
  },
  {
    method: "POST",
    action: "fetch-message-history",
    body: { count: 10, oldestMsgKey: KEY, oldestMsgTimestamp: 1 },
  },
  { method: "POST", action: "send-receipts", body: { keys: [KEY] } },
  { method: "DELETE", action: "messages", body: { jid: J, key: KEY } },
  {
    method: "PATCH",
    action: "messages",
    body: { jid: J, key: KEY, messageContent: { text: "edited" } },
  },
  { method: "GET", action: "profile-picture-url", query: { jid: J } },
  { method: "GET", action: "reachout-timelock", notFound: true },
  { method: "GET", action: "new-chat-cap", notFound: true },
  { method: "POST", action: "on-whatsapp", body: { jids: [J] } },
  { method: "GET", action: "business-profile", query: { jid: J } },
  { method: "GET", action: "group-metadata", query: { jid: G } },
  {
    method: "POST",
    action: "group-participants",
    body: { jid: G, participant: J, action: "add" },
  },
  { method: "POST", action: "group-subject", body: { jid: G, subject: "E2E" } },
  {
    method: "POST",
    action: "group-description",
    body: { jid: G, description: "E2E" },
  },
  {
    method: "POST",
    action: "update-profile-picture",
    body: { jid: J, image: Buffer.from("not really a jpeg").toString("base64") },
  },
  {
    method: "POST",
    action: "group-create",
    body: { subject: "E2E", participants: [J] },
  },
  { method: "POST", action: "group-leave", body: { jid: G } },
  {
    method: "GET",
    action: "group-request-participants-list",
    query: { jid: G },
  },
  {
    method: "POST",
    action: "group-request-participants-update",
    body: { jid: G, participants: [J], action: "approve" },
  },
  { method: "GET", action: "group-invite-code", query: { jid: G } },
  { method: "POST", action: "group-revoke-invite", body: { jid: G } },
  { method: "POST", action: "group-accept-invite", body: { code: "E2ECODE" } },
  {
    method: "POST",
    action: "group-revoke-invite-v4",
    body: { groupJid: G, invitedJid: J },
  },
  {
    method: "POST",
    action: "group-accept-invite-v4",
    body: { key: KEY, inviteMessage: { groupJid: G, inviteCode: "E2ECODE" } },
  },
  { method: "GET", action: "group-invite-info", query: { code: "E2ECODE" } },
  {
    method: "POST",
    action: "group-toggle-ephemeral",
    body: { jid: G, ephemeralExpiration: 86_400 },
  },
  {
    method: "POST",
    action: "group-setting-update",
    body: { jid: G, setting: "locked" },
  },
  {
    method: "POST",
    action: "group-member-add-mode",
    body: { jid: G, mode: "admin_add" },
  },
  {
    method: "POST",
    action: "group-join-approval-mode",
    body: { jid: G, mode: "on" },
  },
  { method: "GET", action: "group-fetch-all-participating" },
];

const phone = newPhone();
const pathOf = (route: Route, query = route.query) =>
  `/connections/${phone}/${route.action}${query ? `?${new URLSearchParams(query)}` : ""}`;

test("the table covers every per-phone action in the live OpenAPI doc", async () => {
  const doc = await api("GET", "/swagger/json", { key: null });
  const documented = Object.entries(doc.json.paths as Record<string, object>)
    .filter(([path]) => path.startsWith("/connections/{phoneNumber}/"))
    .flatMap(([path, ops]) =>
      Object.keys(ops).map(
        (method) =>
          `${method.toUpperCase()} ${path.replace("/connections/{phoneNumber}/", "")}`,
      ),
    )
    .filter((op) => op !== "POST import-session")
    .sort();
  const covered = routes.map((r) => `${r.method} ${r.action}`).sort();

  expect(covered).toEqual(documented);
});

for (const route of routes) {
  describe(`${route.method} /connections/:phone/${route.action}`, () => {
    test("401 without a key", async () => {
      const res = await api(route.method, pathOf(route), {
        key: null,
        body: route.body,
      });
      expect(res.status).toBe(401);
    });

    if (route.body || route.query) {
      test("422 for a request that breaks the schema", async () => {
        const res = await api(route.method, pathOf(route, route.query && {}), {
          body: route.body && {},
        });
        expect(res.status).toBe(422);
        expect(res.json.type).toBe("validation");
      });
    }

    const notConnected = async () => {
      const res = await api(route.method, pathOf(route), { body: route.body });
      expect(res.text).toBe("Phone number not connected");
      return res;
    };

    if (route.notFound) {
      test("404 Phone number not connected", async () => {
        expect((await notConnected()).status).toBe(404);
      });
    } else {
      test("rejected with 'Phone number not connected'", async () => {
        const res = await notConnected();
        expect(res.status).toBeGreaterThanOrEqual(400);
      });

      // KNOWN BUG: only send-message, reachout-timelock, new-chat-cap and
      // GET /connections/:phone map BaileysNotConnectedError to 404; every
      // other handler lets it escape to Elysia, which answers 500
      // (src/controllers/connections/index.ts, e.g. read-messages ~L450).
      test.todo("KNOWN BUG: 404, not 500, for a phone that is not connected", async () => {
        expect((await notConnected()).status).toBe(404);
      });
    }
  });
}
