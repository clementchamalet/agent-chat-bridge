import { EventEmitter } from "node:events";
import type { IncomingMessage, MessageSender, Reaction, SendTextOptions } from "./types.js";
import type { WhatsAppClient } from "../whatsapp/client.js";
import type { WhatsAppSender } from "../whatsapp/sender.js";
import type { TelegramChannel } from "../telegram/channel.js";

export declare interface ChannelHub {
  on(event: "message", listener: (message: IncomingMessage) => void): this;
}

export class ChannelHub extends EventEmitter implements MessageSender {
  constructor(
    private readonly whatsapp: WhatsAppClient | null,
    private readonly whatsappSender: WhatsAppSender | null,
    private readonly telegram: TelegramChannel | null,
  ) {
    super();
    whatsapp?.on("message", (message) => this.emit("message", message));
    telegram?.on("message", (message) => this.emit("message", message));
  }

  private sender(jid: string): MessageSender {
    const sender = jid.startsWith("tg:") ? this.telegram : this.whatsappSender;
    if (!sender) throw new Error(`No channel configured for recipient ${jid}`);
    return sender;
  }

  setFooterProvider(provider: (jid: string) => string): void {
    this.whatsappSender?.setFooterProvider(provider);
    this.telegram?.setFooterProvider(provider);
  }

  sendText(jid: string, text: string, options?: SendTextOptions): Promise<string | undefined> {
    return this.sender(jid).sendText(jid, text, options);
  }

  sendDocument(jid: string, filePath: string, fileName?: string): Promise<void> {
    return this.sender(jid).sendDocument(jid, filePath, fileName);
  }

  react(jid: string, emoji: Reaction, messageId: string): Promise<void> {
    return this.sender(jid).react(jid, emoji, messageId);
  }

  downloadMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
    const sender = mediaId.startsWith("tg:") ? this.telegram : this.whatsappSender;
    if (!sender) return Promise.resolve(null);
    return sender.downloadMedia(mediaId);
  }

  async start(): Promise<void> {
    const results = await Promise.allSettled([this.whatsapp?.start(), this.telegram?.start()]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") {
      await this.stop().catch(() => {});
      throw failure.reason;
    }
  }

  async stop(): Promise<void> {
    const results = await Promise.allSettled([this.whatsapp?.stop(), this.telegram?.stop()]);
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (errors.length > 0) throw new AggregateError(errors, "Failed to stop messaging channels");
  }
}
