import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramChannel } from "./channel.js";

const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as never;
const response = (result: unknown) => ({ ok: true, json: async () => ({ ok: true, result }) });

afterEach(() => vi.unstubAllGlobals());

describe("TelegramChannel", () => {
  it("rejects invalid message IDs and still allows a later send", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response({ message_id: 46 }));
    vi.stubGlobal("fetch", fetchMock);
    const channel = new TelegramChannel(
      {
        token: "test-token",
        allowedUsers: new Set(["123"]),
        maxAgeMs: 600_000,
        getOffset: () => 0,
        saveOffset: () => {},
      },
      logger,
    );
    await expect(channel.sendText("tg:123", "first")).rejects.toThrow("valid message ID");
    await expect(channel.sendText("tg:123", "second")).resolves.toBe("46");
  });
  it("accepts only authorized private messages and persists the polling offset", async () => {
    let offset = 0;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ url: "" }))
      .mockResolvedValueOnce(
        response([
          null,
          { update_id: 9, message: { from: { id: 123 } } },
          {
            update_id: 10,
            message: {
              message_id: 1,
              date: Math.floor(Date.now() / 1000),
              chat: { id: 999, type: "private" },
              from: { id: 999 },
              text: "ignored",
            },
          },
          {
            update_id: 11,
            message: {
              message_id: 2,
              date: Math.floor(Date.now() / 1000),
              chat: { id: 123, type: "group" },
              from: { id: 123 },
              text: "ignored",
            },
          },
          {
            update_id: 12,
            message: {
              message_id: 3,
              date: Math.floor(Date.now() / 1000),
              chat: { id: 123, type: "private" },
              from: { id: 123 },
              text: "run task",
            },
          },
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);
    const channel = new TelegramChannel(
      {
        token: "test-token",
        allowedUsers: new Set(["123"]),
        maxAgeMs: 600_000,
        getOffset: () => offset,
        saveOffset: (value) => {
          offset = value;
        },
      },
      logger,
    );
    const message = new Promise<{ jid: string; text: string }>((resolve) =>
      channel.on("message", (event) => {
        void channel.stop();
        resolve(event);
      }),
    );
    await channel.start();
    await expect(message).resolves.toMatchObject({ jid: "tg:123", text: "run task" });
    expect(offset).toBe(13);
  });

  it("sends text to the correct private chat", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ message_id: 44 }));
    vi.stubGlobal("fetch", fetchMock);
    const channel = new TelegramChannel(
      {
        token: "test-token",
        allowedUsers: new Set(["123"]),
        maxAgeMs: 600_000,
        getOffset: () => 0,
        saveOffset: () => {},
      },
      logger,
    );
    channel.setFooterProvider(() => "agent · 1s");
    expect(await channel.sendText("tg:123", "Done", { agentReply: true })).toBe("44");
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body).toMatchObject({ chat_id: "123", text: "Done\n\nagent · 1s" });
  });

  it("omits agent metadata from bridge messages", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ message_id: 44 }));
    vi.stubGlobal("fetch", fetchMock);
    const channel = new TelegramChannel(
      {
        token: "test-token",
        allowedUsers: new Set(["123"]),
        maxAgeMs: 600_000,
        getOffset: () => 0,
        saveOffset: () => {},
      },
      logger,
    );
    const footer = vi.fn(() => "claude · default · 0m");
    channel.setFooterProvider(footer);
    await channel.sendText("tg:123", "Available commands:");

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.text).toBe("Available commands:");
    expect(footer).not.toHaveBeenCalled();
  });

  it("appends agent metadata to every reply chunk within the delivery limit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ message_id: 44 }));
    vi.stubGlobal("fetch", fetchMock);
    const channel = new TelegramChannel(
      {
        token: "test-token",
        allowedUsers: new Set(["123"]),
        maxAgeMs: 600_000,
        getOffset: () => 0,
        saveOffset: () => {},
      },
      logger,
    );
    const footer = "m".repeat(512);
    channel.setFooterProvider(() => footer);
    await channel.sendText("tg:123", "x".repeat(8000), { agentReply: true });

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    for (const [, init] of fetchMock.mock.calls) {
      const body = JSON.parse(init.body as string);
      expect(body.text).toMatch(new RegExp(`\n\n${footer}$`));
      expect(body.text.length).toBeLessThanOrEqual(4000);
    }
  });

  it("retries a transient API response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ ok: false }) })
      .mockResolvedValueOnce(response({ message_id: 45 }));
    vi.stubGlobal("fetch", fetchMock);
    const channel = new TelegramChannel(
      {
        token: "test-token",
        allowedUsers: new Set(["123"]),
        maxAgeMs: 600_000,
        getOffset: () => 0,
        saveOffset: () => {},
      },
      logger,
    );
    expect(await channel.sendText("tg:123", "Done")).toBe("45");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("downloads a photo within the configured size limit", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ file_path: "photos/image.jpg", file_size: 3 }))
      .mockResolvedValueOnce(new Response("img", { headers: { "content-type": "image/jpeg" } }));
    vi.stubGlobal("fetch", fetchMock);
    const channel = new TelegramChannel(
      {
        token: "test-token",
        allowedUsers: new Set(["123"]),
        maxAgeMs: 600_000,
        getOffset: () => 0,
        saveOffset: () => {},
      },
      logger,
    );

    await expect(channel.downloadMedia("tg:file-id")).resolves.toEqual({
      buffer: Buffer.from("img"),
      mimeType: "image/jpeg",
    });
    expect(fetchMock.mock.calls[1]![0]).toContain("/file/bottest-token/photos/image.jpg");
  });

  it("waits for polling to stop before returning from stop", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ url: "" }))
      .mockImplementationOnce(
        (_url, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")));
          }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const channel = new TelegramChannel(
      {
        token: "test-token",
        allowedUsers: new Set(["123"]),
        maxAgeMs: 600_000,
        getOffset: () => 0,
        saveOffset: () => {},
      },
      logger,
    );

    await channel.start();
    await channel.stop();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
