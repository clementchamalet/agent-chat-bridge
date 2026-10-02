import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { ChannelHub } from "./hub.js";

describe("ChannelHub", () => {
  it("stops both channels when either one fails to start", async () => {
    const whatsapp = Object.assign(new EventEmitter(), { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) });
    const telegram = Object.assign(new EventEmitter(), {
      start: vi.fn(async () => {
        throw new Error("Invalid token");
      }),
      stop: vi.fn(async () => {}),
    });
    const hub = new ChannelHub(whatsapp as never, null, telegram as never);
    await expect(hub.start()).rejects.toThrow("Invalid token");
    expect(whatsapp.stop).toHaveBeenCalledOnce();
    expect(telegram.stop).toHaveBeenCalledOnce();
  });
  it("keeps channel identities separate and routes outbound operations", async () => {
    const whatsapp = new EventEmitter();
    const telegram = Object.assign(new EventEmitter(), {
      sendText: vi.fn(async () => "telegram-message"),
      sendDocument: vi.fn(async () => {}),
      react: vi.fn(async () => {}),
      downloadMedia: vi.fn(async () => ({ buffer: Buffer.from("telegram"), mimeType: "image/jpeg" })),
      setFooterProvider: vi.fn(),
    });
    const whatsappSender = {
      sendText: vi.fn(async () => "whatsapp-message"),
      sendDocument: vi.fn(async () => {}),
      react: vi.fn(async () => {}),
      downloadMedia: vi.fn(async () => ({ buffer: Buffer.from("whatsapp"), mimeType: "image/jpeg" })),
      setFooterProvider: vi.fn(),
    };
    const hub = new ChannelHub(whatsapp as never, whatsappSender as never, telegram as never);
    const messages: string[] = [];
    hub.on("message", (message) => messages.push(message.jid));
    whatsapp.emit("message", { jid: "33612345678", key: "wa-1", text: "hello" });
    telegram.emit("message", { jid: "tg:12345", key: "1", text: "hello" });
    expect(messages).toEqual(["33612345678", "tg:12345"]);

    expect(await hub.sendText("33612345678", "one")).toBe("whatsapp-message");
    expect(await hub.sendText("tg:12345", "two")).toBe("telegram-message");
    expect(whatsappSender.sendText).toHaveBeenCalledWith("33612345678", "one", undefined);
    expect(telegram.sendText).toHaveBeenCalledWith("tg:12345", "two", undefined);
    await hub.sendText("33612345678", "reply", { agentReply: true });
    await hub.sendText("tg:12345", "reply", { agentReply: true });
    expect(whatsappSender.sendText).toHaveBeenLastCalledWith("33612345678", "reply", { agentReply: true });
    expect(telegram.sendText).toHaveBeenLastCalledWith("tg:12345", "reply", { agentReply: true });
    expect((await hub.downloadMedia("tg:photo"))?.buffer.toString()).toBe("telegram");
    expect((await hub.downloadMedia("wa-photo"))?.buffer.toString()).toBe("whatsapp");
  });
});
