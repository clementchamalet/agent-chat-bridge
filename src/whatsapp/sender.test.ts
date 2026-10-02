import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhatsAppSender } from "./sender.js";
import { makeLogger } from "../utils/logger.js";
import * as configModule from "../config.js";

const JID = "15550009999";

describe("WhatsAppSender", () => {
  let sender: WhatsAppSender;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.spyOn(configModule, "config", "get").mockReturnValue({
      ...configModule.config,
      whatsappAccessToken: "test-token",
      whatsappPhoneNumberId: "123456",
      graphApiVersion: "v21.0",
    });
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    sender = new WhatsAppSender(makeLogger("fatal", "test"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function jsonResponse(body: unknown, ok = true, status = 200) {
    return { ok, status, json: async () => body };
  }

  it("keeps fenced replies with oversized footers inside the delivery limit", async () => {
    sender.setFooterProvider(() => "m".repeat(5000));
    fetchMock.mockResolvedValue(jsonResponse({ messages: [{ id: "wamid.chunk" }] }));
    await sender.sendText(JID, `\`\`\`\n${"x".repeat(7000)}\n\`\`\``, { agentReply: true });
    for (const [, init] of fetchMock.mock.calls) {
      const text = JSON.parse(init.body).text.body as string;
      expect(text.length).toBeLessThanOrEqual(3500);
      expect((text.match(/```/g) ?? []).length % 2).toBe(0);
    }
  });

  it("sends a text message with the expected Graph API shape", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ messages: [{ id: "wamid.1" }] }));

    const id = await sender.sendText(JID, "hello there");

    expect(id).toBe("wamid.1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://graph.facebook.com/v21.0/123456/messages");
    expect(init.headers.Authorization).toBe("Bearer test-token");
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: "whatsapp",
      to: JID,
      type: "text",
      text: { body: "hello there", preview_url: false },
    });
  });

  it("sends one request per chunk for long text, returning the last chunk's id", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ messages: [{ id: "wamid.first" }] }))
      .mockResolvedValueOnce(jsonResponse({ messages: [{ id: "wamid.second" }] }));

    const longText = "x".repeat(4000);
    const id = await sender.sendText(JID, longText);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(id).toBe("wamid.second");
  });

  it("omits agent metadata from bridge messages", async () => {
    const footer = vi.fn(() => "claude · default · 0m");
    sender.setFooterProvider(footer);
    fetchMock.mockResolvedValue(jsonResponse({ messages: [{ id: "wamid.help" }] }));

    await sender.sendText(JID, "Available commands:");

    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).text.body).toBe("Available commands:");
    expect(footer).not.toHaveBeenCalled();
  });

  it("appends agent metadata to every reply chunk", async () => {
    sender.setFooterProvider(() => "_DeepSeek V4 Pro · light · 2m_");
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ messages: [{ id: "wamid.first" }] }))
      .mockResolvedValueOnce(jsonResponse({ messages: [{ id: "wamid.second" }] }));

    await sender.sendText(JID, "x".repeat(4000), { agentReply: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(JSON.parse(init.body).text.body).toMatch(/\n\n_DeepSeek V4 Pro · light · 2m_$/);
    }
  });

  it("serializes sends for one WhatsApp pair", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fetchMock
      .mockImplementationOnce(async () => {
        await gate;
        return jsonResponse({ messages: [{ id: "wamid.first" }] });
      })
      .mockResolvedValueOnce(jsonResponse({ messages: [{ id: "wamid.second" }] }));

    const first = sender.sendText(JID, "first");
    const second = sender.sendText(JID, "second");
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).text.body).toBe("first");
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).text.body).toBe("second");
  });

  it("sends a reaction referencing the target message id", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));

    await sender.react(JID, "✅", "wamid.target");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://graph.facebook.com/v21.0/123456/messages");
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: "whatsapp",
      to: JID,
      type: "reaction",
      reaction: { message_id: "wamid.target", emoji: "✅" },
    });
  });

  it("swallows reaction errors without throwing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: "boom" } }, false, 400));
    await expect(sender.react(JID, "✅", "wamid.target")).resolves.toBeUndefined();
  });

  it("waits and retries a rate-limited send (#131056) instead of dropping the message", async () => {
    vi.useFakeTimers();
    try {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse(
            { error: { message: "(Business Account, Consumer Account) pair rate limit hit", code: 131056 } },
            false,
            400,
          ),
        )
        .mockResolvedValueOnce(jsonResponse({ messages: [{ id: "wamid.after-limit" }] }));

      const pending = sender.sendText(JID, "important reply");
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(pending).resolves.toBe("wamid.after-limit");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a network-level failure (not a real API error) and succeeds once the connection recovers", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse({ messages: [{ id: "wamid.retried" }] }));

    const id = await sender.sendText(JID, "hello there");

    expect(id).toBe("wamid.retried");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a real API error (bad request, invalid token, …) — only network-level failures", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: "Invalid parameter" } }, false, 400));
    await expect(sender.sendText(JID, "hello there")).rejects.toThrow("Invalid parameter");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("allows a later send after an earlier send fails", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: { message: "Invalid parameter" } }, false, 400))
      .mockResolvedValueOnce(jsonResponse({ messages: [{ id: "wamid.next" }] }));

    await expect(sender.sendText(JID, "first")).rejects.toThrow("Invalid parameter");
    await expect(sender.sendText(JID, "second")).resolves.toBe("wamid.next");
  });

  it("gives up after repeated network failures, rather than retrying forever", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockRejectedValue(new TypeError("fetch failed"));

      const promise = sender.sendText(JID, "hello there");
      const rejection = expect(promise).rejects.toThrow("fetch failed");
      await vi.runAllTimersAsync();
      await rejection;

      expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uploads media then sends a document message referencing the returned media id", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: "media-123" }))
      .mockResolvedValueOnce(jsonResponse({ messages: [{ id: "wamid.doc" }] }));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sender-test-"));
    const filePath = path.join(dir, "report.md");
    fs.writeFileSync(filePath, "# hello");

    await sender.sendDocument(JID, filePath);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [uploadUrl, uploadInit] = fetchMock.mock.calls[0]!;
    expect(uploadUrl).toBe("https://graph.facebook.com/v21.0/123456/media");
    expect(uploadInit.body).toBeInstanceOf(FormData);

    const [sendUrl, sendInit] = fetchMock.mock.calls[1]!;
    expect(sendUrl).toBe("https://graph.facebook.com/v21.0/123456/messages");
    expect(JSON.parse(sendInit.body)).toEqual({
      messaging_product: "whatsapp",
      to: JID,
      type: "document",
      document: { id: "media-123", filename: "report.md" },
    });

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ["count.py", "print(42)\n"],
    ["index.html", "<!doctype html><title>Tasks</title>"],
    ["README.md", "# Project\n"],
    ["data.json", '{"ok":true}\n'],
    ["report.csv", "name,count\nTasks,2\n"],
    ["changes.patch", "--- a/file\n+++ b/file\n"],
    ["main.ts", 'console.log("ready");\n'],
    ["Makefile", "all:\n\techo ready\n"],
    ["notes.txt", "Hello 🌍\r\n"],
    ["empty.py", ""],
  ])("uploads %s as plain text without changing its bytes or filename", async (name, content) => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: "media-text" }))
      .mockResolvedValueOnce(jsonResponse({ messages: [{ id: "wamid.doc" }] }));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sender-test-"));
    try {
      const file = path.join(dir, name);
      fs.writeFileSync(file, content);
      await sender.sendDocument(JID, file);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const form = fetchMock.mock.calls[0]![1].body as FormData;
      const attachment = form.get("file") as File;
      expect(form.get("type")).toBe("text/plain");
      expect(attachment.type).toBe("text/plain");
      expect(attachment.name).toBe(name);
      expect(Buffer.from(await attachment.arrayBuffer())).toEqual(Buffer.from(content));
      expect(JSON.parse(fetchMock.mock.calls[1]![1].body).document.filename).toBe(name);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves supported binary media types and a custom delivery filename", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: "media-pdf" }))
      .mockResolvedValueOnce(jsonResponse({ messages: [{ id: "wamid.doc" }] }));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sender-test-"));
    try {
      const file = path.join(dir, "report.PDF");
      const content = Buffer.from([37, 80, 68, 70, 0, 255]);
      fs.writeFileSync(file, content);
      await sender.sendDocument(JID, file, "results.pdf");
      const form = fetchMock.mock.calls[0]![1].body as FormData;
      const attachment = form.get("file") as File;
      expect(form.get("type")).toBe("application/pdf");
      expect(attachment.name).toBe("results.pdf");
      expect(Buffer.from(await attachment.arrayBuffer())).toEqual(content);
      expect(JSON.parse(fetchMock.mock.calls[1]![1].body).document.filename).toBe("results.pdf");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["archive.zip", Buffer.from([80, 75, 3, 4, 0])],
    ["invalid.txt", Buffer.from([255, 254])],
    ["binary.py", Buffer.from([97, 0, 98])],
  ])("rejects unsupported binary content in %s before uploading", async (name, content) => {
    fetchMock.mockResolvedValue(jsonResponse({ messages: [{ id: "wamid.err" }] }));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sender-test-"));
    try {
      const file = path.join(dir, name);
      fs.writeFileSync(file, content);
      await sender.sendDocument(JID, file);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toContain("/messages");
      expect(JSON.parse(init.body).text.body).toContain("WhatsApp does not support this file type");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a failure via sendText instead of throwing when the document upload fails", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: "upload failed" } }, false, 400));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sender-test-"));
    const filePath = path.join(dir, "notes.md");
    fs.writeFileSync(filePath, "content");

    fetchMock.mockResolvedValueOnce(jsonResponse({ messages: [{ id: "wamid.err" }] }));

    await sender.sendDocument(JID, filePath);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, errorNoticeInit] = fetchMock.mock.calls[1]!;
    expect(JSON.parse(errorNoticeInit.body).text.body).toContain("Failed to attach");

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
