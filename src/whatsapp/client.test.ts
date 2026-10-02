import { createHmac } from "node:crypto";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WhatsAppClient as WhatsAppClientType } from "./client.js";

const TEST_NUMBER = "15550009999";
const TEST_VERIFY_TOKEN = "test-verify-token";

async function freshClient(appSecret?: string): Promise<WhatsAppClientType> {
  vi.resetModules();
  vi.stubEnv("ALLOWED_NUMBERS", TEST_NUMBER);
  vi.stubEnv("WHATSAPP_VERIFY_TOKEN", TEST_VERIFY_TOKEN);
  vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "unused-in-these-tests");
  vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "unused-in-these-tests");
  vi.stubEnv("WEBHOOK_PORT", "0");
  if (appSecret) vi.stubEnv("WHATSAPP_APP_SECRET", appSecret);

  vi.spyOn(fs, "existsSync").mockReturnValue(false);

  const { WhatsAppClient } = await import("./client.js");
  const { makeLogger } = await import("../utils/logger.js");
  return new WhatsAppClient(makeLogger("error", "test"));
}

function sign(body: string, appSecret: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(body).digest("hex")}`;
}

describe("WhatsAppClient webhook server", () => {
  let client: WhatsAppClientType;
  let baseUrl: string;

  beforeEach(async () => {
    client = await freshClient();
    await client.start();
    baseUrl = `http://127.0.0.1:${client.getPort()}/webhook`;
  });

  afterEach(async () => {
    await client.stop();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("echoes hub.challenge back when the verify token matches", async () => {
    const url = `${baseUrl}?hub.mode=subscribe&hub.verify_token=${TEST_VERIFY_TOKEN}&hub.challenge=12345`;
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("12345");
  });

  it("rejects verification with the wrong token", async () => {
    const url = `${baseUrl}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345`;
    const res = await fetch(url);
    expect(res.status).toBe(403);
  });

  it("emits a message event for a text message from a whitelisted number", async () => {
    const received = new Promise<{ jid: string; text: string; key: string }>((resolve) => {
      client.on("message", (msg) => resolve(msg));
    });

    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entry: [
          {
            changes: [
              {
                field: "messages",
                value: {
                  messages: [{ id: "wamid.ABC123", from: TEST_NUMBER, type: "text", text: { body: "  /status  " } }],
                },
              },
            ],
          },
        ],
      }),
    });
    expect(res.status).toBe(200);

    const msg = await received;
    expect(msg).toEqual({ jid: TEST_NUMBER, text: "/status", key: "wamid.ABC123" });
  });

  it("drops a message from a non-whitelisted number", async () => {
    const onMessage = vi.fn();
    client.on("message", onMessage);

    await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entry: [
          {
            changes: [
              {
                field: "messages",
                value: { messages: [{ id: "wamid.X", from: "19998887777", type: "text", text: { body: "hi" } }] },
              },
            ],
          },
        ],
      }),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("ignores non-text message types (e.g. images, reactions)", async () => {
    const onMessage = vi.fn();
    client.on("message", onMessage);

    await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entry: [
          {
            changes: [
              { field: "messages", value: { messages: [{ id: "wamid.Y", from: TEST_NUMBER, type: "image" }] } },
            ],
          },
        ],
      }),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("returns 404 for any path other than /webhook", async () => {
    const res = await fetch(`http://localhost:${client.getPort()}/not-webhook`);
    expect(res.status).toBe(404);
  });

  it("drops a redelivered message with an id already seen (Meta webhook retry)", async () => {
    const onMessage = vi.fn();
    client.on("message", onMessage);

    const payload = JSON.stringify({
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: { messages: [{ id: "wamid.DUP", from: TEST_NUMBER, type: "text", text: { body: "hi" } }] },
            },
          ],
        },
      ],
    });

    await fetch(baseUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload });
    await fetch(baseUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload });
    await new Promise((r) => setTimeout(r, 20));

    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("drops a message whose timestamp is far older than the max age", async () => {
    const onMessage = vi.fn();
    client.on("message", onMessage);

    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 3600);
    await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entry: [
          {
            changes: [
              {
                field: "messages",
                value: {
                  messages: [
                    {
                      id: "wamid.STALE",
                      from: TEST_NUMBER,
                      type: "text",
                      text: { body: "hi" },
                      timestamp: staleTimestamp,
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("ignores malformed webhook entries without stopping the server", async () => {
    const onMessage = vi.fn();
    client.on("message", onMessage);

    const malformed = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entry: [
          null,
          { changes: [null, { value: { messages: [null, { id: 12, from: TEST_NUMBER, type: "text" }] } }] },
        ],
      }),
    });
    expect(malformed.status).toBe(200);
    expect(onMessage).not.toHaveBeenCalled();

    const healthy = await fetch(`http://127.0.0.1:${client.getPort()}/healthz`);
    expect(healthy.status).toBe(200);
  });
});

describe("WhatsAppClient webhook signature verification", () => {
  const APP_SECRET = "test-app-secret";
  let client: WhatsAppClientType;
  let baseUrl: string;

  beforeEach(async () => {
    client = await freshClient(APP_SECRET);
    await client.start();
    baseUrl = `http://localhost:${client.getPort()}/webhook`;
  });

  afterEach(async () => {
    await client.stop();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function payloadFor(id: string): string {
    return JSON.stringify({
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: { messages: [{ id, from: TEST_NUMBER, type: "text", text: { body: "hi" } }] },
            },
          ],
        },
      ],
    });
  }

  it("accepts a POST with a valid signature", async () => {
    const onMessage = vi.fn();
    client.on("message", onMessage);
    const body = payloadFor("wamid.SIGNED");

    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sign(body, APP_SECRET) },
      body,
    });

    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(onMessage).toHaveBeenCalledOnce();
  });

  it("rejects a POST with no signature header", async () => {
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payloadFor("wamid.NOSIG"),
    });
    expect(res.status).toBe(403);
  });

  it("rejects a digest without the sha256 prefix", async () => {
    const body = payloadFor("wamid.NO-PREFIX");
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sign(body, APP_SECRET).slice(7) },
      body,
    });
    expect(res.status).toBe(403);
  });

  it("rejects a POST signed with the wrong secret", async () => {
    const body = payloadFor("wamid.WRONGSIG");
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sign(body, "not-the-real-secret") },
      body,
    });
    expect(res.status).toBe(403);
  });

  it("rejects a POST whose body was tampered with after signing", async () => {
    const signature = sign(payloadFor("wamid.TAMPERED"), APP_SECRET);
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signature },
      body: payloadFor("wamid.DIFFERENT"), // signed for a different body
    });
    expect(res.status).toBe(403);
  });
});
