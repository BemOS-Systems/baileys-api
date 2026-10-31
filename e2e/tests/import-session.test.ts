// POST /connections/:phone/import-session: transplanting an extracted
// WhatsApp Web session. Offline the imported creds can never be proven, so
// this pins the HTTP contract and the webhook handoff, not a resumed login.
import { describe, expect, test } from "bun:test";
import { api, newHook, newPhone, waitForDelivery } from "../support/harness";

const b64 = (s: string) => Buffer.from(s).toString("base64");

const session = (phone: string) => ({
  noiseCandidates: [
    { private: b64("noise-priv-0"), public: b64("noise-pub-0") },
    { private: b64("noise-priv-1"), public: b64("noise-pub-1") },
  ],
  identityKey: { private: b64("id-priv"), public: b64("id-pub") },
  registrationId: 42,
  advSecretKey: b64("adv-secret"),
  account: {
    details: b64("acc-details"),
    accountSignatureKey: b64("acc-sig-key"),
    accountSignature: b64("acc-sig"),
    deviceSignature: b64("dev-sig"),
  },
  id: `${phone.slice(1)}:12@s.whatsapp.net`,
  lid: `${phone.slice(1)}@s.whatsapp.net`,
  pushName: "E2E",
});

describe("POST /connections/:phone/import-session", () => {
  test("202 and the imported socket reports to the webhook", async () => {
    const phone = newPhone();
    const hook = newHook("import");

    const res = await api("POST", `/connections/${phone}/import-session`, {
      body: {
        session: session(phone),
        candidateIndex: 1,
        webhookUrl: hook.url,
        webhookVerifyToken: "import-token",
      },
    });

    expect(res.status).toBe(202);
    expect(res.text).toBe("");
    const first = await waitForDelivery(hook.name);
    expect(first.body).toEqual({
      event: "connection.update",
      data: { connection: "reconnecting", epoch: expect.any(Number) },
      webhookVerifyToken: "import-token",
    });
    // A registered companion never asks for a QR.
    expect(first.body.data).not.toHaveProperty("qrDataUrl");
    expect((await api("GET", `/connections/${phone}`)).status).toBe(200);

    await api("DELETE", `/connections/${phone}`);
  }, 30_000);

  test("422 when candidateIndex is out of range", async () => {
    const phone = newPhone();
    const res = await api("POST", `/connections/${phone}/import-session`, {
      body: {
        session: session(phone),
        candidateIndex: 5,
        webhookUrl: "http://tests:4000/hook/never",
        webhookVerifyToken: "import-token",
      },
    });

    expect(res.status).toBe(422);
    expect(res.json).toEqual({
      error: "Unprocessable Entity",
      message: "noise candidate index 5 out of range (have 2)",
    });
    expect((await api("GET", `/connections/${phone}`)).status).toBe(404);
  });

  test("422 when a key is not canonical base64", async () => {
    const phone = newPhone();
    const res = await api("POST", `/connections/${phone}/import-session`, {
      body: {
        session: { ...session(phone), advSecretKey: "not base64!" },
        webhookUrl: "http://tests:4000/hook/never",
        webhookVerifyToken: "import-token",
      },
    });

    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ type: "validation", on: "body" });
  });

  test("422 when the webhook fields are missing", async () => {
    const phone = newPhone();
    const res = await api("POST", `/connections/${phone}/import-session`, {
      body: { session: session(phone) },
    });

    expect(res.status).toBe(422);
  });

  test("422 for an empty noiseCandidates list", async () => {
    const phone = newPhone();
    const res = await api("POST", `/connections/${phone}/import-session`, {
      body: {
        session: { ...session(phone), noiseCandidates: [] },
        webhookUrl: "http://tests:4000/hook/never",
        webhookVerifyToken: "import-token",
      },
    });

    expect(res.status).toBe(422);
  });
});
