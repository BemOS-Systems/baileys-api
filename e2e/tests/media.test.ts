// GET /media/:messageId. A paired socket writes these files as messages
// arrive; offline the test drops one into the instance's media volume.
import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { api, dirs } from "../support/harness";

const messageId = `E2EMEDIA${Date.now()}`;
const bytes = new Uint8Array([0, 1, 2, 3, 254, 255]);

afterAll(async () => {
  await rm(`${dirs.media}/${messageId}`, { force: true });
});

describe("GET /media/:messageId", () => {
  test("401 without a key", async () => {
    expect(
      (await api("GET", `/media/${messageId}`, { key: null })).status,
    ).toBe(401);
  });

  test("422 for an id outside [A-Z0-9]{1,64}", async () => {
    for (const id of ["lowercase", "A".repeat(65), "..%2F..%2Fpackage.json"]) {
      const res = await api("GET", `/media/${id}`);
      expect(`${id} ${res.status}`).toBe(`${id} 422`);
    }
  });

  test("404 File not found for an unknown id", async () => {
    const res = await api("GET", "/media/NOSUCHMEDIA1");

    expect(res.status).toBe(404);
    expect(res.text).toBe("File not found");
  });

  test("200 streams the stored bytes", async () => {
    await Bun.write(`${dirs.media}/${messageId}`, bytes);

    const response = await fetch(
      `${process.env.BAILEYS_URL}/media/${messageId}`,
      { headers: { "x-api-key": process.env.E2E_USER_KEY as string } },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000",
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });
});
