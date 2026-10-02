import path from "node:path";
import { EventEmitter } from "node:events";
import type { IncomingMessage, MessageSender, Reaction, SendTextOptions } from "../channel/types.js";
import { chunkMessage } from "../utils/chunk.js";
import { mimeTypeFor } from "../utils/mime.js";
import { readLimitedResponse } from "../utils/readLimitedResponse.js";
import { readDocument } from "../utils/document.js";
import { stripLegacyFooter } from "../channel/outbound.js";
import type { Logger } from "../utils/logger.js";

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    chat: { id: number; type: string };
    from?: { id: number; is_bot?: boolean };
    text?: string;
    caption?: string;
    photo?: { file_id: string }[];
  };
}

interface TelegramResult<T> {
  ok: boolean;
  result?: T;
  description?: string;
  parameters?: { retry_after?: number };
}

export interface TelegramOptions {
  token: string;
  allowedUsers: ReadonlySet<string>;
  maxAgeMs: number;
  getOffset: () => number;
  saveOffset: (offset: number) => void;
}

export declare interface TelegramChannel {
  on(event: "message", listener: (message: IncomingMessage) => void): this;
}

export class TelegramChannel extends EventEmitter implements MessageSender {
  private running = false;
  private abort: AbortController | null = null;
  private pollTask: Promise<void> | null = null;
  private footerProvider: ((jid: string) => string) | null = null;
  private readonly sendChains = new Map<string, Promise<string | undefined>>();

  constructor(
    private readonly options: TelegramOptions,
    private readonly logger: Logger,
  ) {
    super();
  }

  setFooterProvider(provider: (jid: string) => string): void {
    this.footerProvider = provider;
  }

  private apiUrl(method: string): string {
    return `https://api.telegram.org/bot${this.options.token}/${method}`;
  }

  private chatId(jid: string): string {
    if (!/^tg:\d+$/.test(jid)) throw new Error("Invalid Telegram recipient");
    return jid.slice(3);
  }

  private async call<T>(method: string, body: Record<string, unknown> | FormData, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(this.apiUrl(method), {
          method: "POST",
          body: body instanceof FormData ? body : JSON.stringify(body),
          headers: body instanceof FormData ? undefined : { "Content-Type": "application/json" },
          signal: signal ?? AbortSignal.timeout(40_000),
        });
        const payload = (await response.json().catch(() => ({}))) as TelegramResult<T>;
        if (response.ok && payload?.ok && payload.result !== undefined) return payload.result;
        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
          const delay =
            response.status === 429
              ? Math.max(1, Math.min(payload?.parameters?.retry_after ?? 1, 30)) * 1000
              : 500 * 2 ** attempt;
          await this.pause(delay, signal);
          continue;
        }
        throw new Error(`Telegram ${method} failed: ${payload?.description ?? `HTTP ${response.status}`}`);
      } catch (err) {
        if (signal?.aborted || !(err instanceof TypeError) || attempt === 2) throw err;
        await this.pause(500 * 2 ** attempt, signal);
      }
    }
    throw new Error(`Telegram ${method} failed after retries`);
  }

  private pause(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async start(): Promise<void> {
    if (this.running) return;
    const webhook = await this.call<{ url?: string }>("getWebhookInfo", {});
    if (webhook.url) throw new Error("Telegram long polling requires removing the bot's existing webhook first");
    this.running = true;
    this.pollTask = this.poll();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    await this.pollTask;
    this.pollTask = null;
  }

  private async poll(): Promise<void> {
    let offset = this.options.getOffset();
    while (this.running) {
      this.abort = new AbortController();
      try {
        const updates = await this.call<TelegramUpdate[]>(
          "getUpdates",
          { offset, timeout: 25, allowed_updates: ["message"] },
          AbortSignal.any([this.abort.signal, AbortSignal.timeout(40_000)]),
        );
        if (!Array.isArray(updates)) throw new Error("Telegram getUpdates returned an invalid result");
        for (const update of updates) {
          if (!update || !Number.isSafeInteger(update.update_id) || update.update_id < offset) continue;
          this.handleUpdate(update);
          offset = update.update_id + 1;
          this.options.saveOffset(offset);
        }
      } catch (err) {
        if (this.running) {
          this.logger.warn(`Telegram polling failed: ${err instanceof Error ? err.message : String(err)}`);
          await this.pause(3000, this.abort.signal).catch(() => {});
        }
      }
    }
    this.abort = null;
  }

  private handleUpdate(update: TelegramUpdate): void {
    const message = update.message;
    if (
      message?.chat?.type !== "private" ||
      !message.from ||
      message.from.is_bot ||
      !Number.isSafeInteger(message.message_id) ||
      !Number.isFinite(message.date) ||
      !Number.isSafeInteger(message.chat.id) ||
      !Number.isSafeInteger(message.from.id)
    ) {
      return;
    }
    const userId = String(message.from.id);
    if (String(message.chat.id) !== userId || !this.options.allowedUsers.has(userId)) return;
    const ageMs = Date.now() - message.date * 1000;
    if (ageMs < -60_000 || ageMs > this.options.maxAgeMs) return;
    const jid = `tg:${userId}`;
    const key = String(message.message_id);
    const photo = Array.isArray(message.photo) ? message.photo.at(-1) : undefined;
    if (photo && typeof photo.file_id === "string") {
      this.emit("message", {
        jid,
        key,
        text: typeof message.caption === "string" ? message.caption.trim() : "",
        image: {
          mediaId: `tg:${photo.file_id}`,
          caption: typeof message.caption === "string" ? message.caption.trim() || null : null,
        },
      } satisfies IncomingMessage);
    } else if (typeof message.text === "string" && message.text.trim()) {
      this.emit("message", { jid, key, text: message.text.trim() } satisfies IncomingMessage);
    }
  }

  async sendText(jid: string, text: string, options?: SendTextOptions): Promise<string | undefined> {
    const previous = this.sendChains.get(jid) ?? Promise.resolve(undefined);
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        const footer = options?.agentReply ? this.footerProvider?.(jid)?.slice(0, 512) : undefined;
        const chunks = chunkMessage(stripLegacyFooter(text).trimEnd(), Math.max(256, 4000 - (footer?.length ?? 0) - 2));
        let lastId: string | undefined;
        for (const chunk of chunks) {
          const result = await this.call<{ message_id: number }>("sendMessage", {
            chat_id: this.chatId(jid),
            text: footer ? `${chunk}\n\n${footer}` : chunk,
            link_preview_options: { is_disabled: true },
          });
          if (!Number.isSafeInteger(result?.message_id) || result.message_id <= 0) {
            throw new Error("Telegram send response did not contain a valid message ID");
          }
          lastId = String(result.message_id);
        }
        return lastId;
      });
    this.sendChains.set(jid, current);
    try {
      return await current;
    } finally {
      if (this.sendChains.get(jid) === current) this.sendChains.delete(jid);
    }
  }

  async sendDocument(jid: string, filePath: string, fileName?: string): Promise<void> {
    const buffer = readDocument(filePath, 49 * 1024 * 1024);
    const form = new FormData();
    form.append("chat_id", this.chatId(jid));
    form.append(
      "document",
      new Blob([new Uint8Array(buffer)], { type: mimeTypeFor(filePath) }),
      fileName ?? path.basename(filePath),
    );
    await this.call("sendDocument", form);
  }

  async react(jid: string, emoji: Reaction, messageId: string): Promise<void> {
    const id = Number(messageId);
    if (!Number.isSafeInteger(id)) return;
    try {
      await this.call("setMessageReaction", {
        chat_id: this.chatId(jid),
        message_id: id,
        reaction: [{ type: "emoji", emoji }],
      });
    } catch {
      // Reactions are optional and Telegram may reject an emoji for a chat.
    }
  }

  async downloadMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
    if (!mediaId.startsWith("tg:")) return null;
    try {
      const file = await this.call<{ file_path?: string; file_size?: number }>("getFile", {
        file_id: mediaId.slice(3),
      });
      if (!file.file_path || (file.file_size ?? 0) > 20 * 1024 * 1024) return null;
      const response = await fetch(`https://api.telegram.org/file/bot${this.options.token}/${file.file_path}`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) return null;
      const buffer = await readLimitedResponse(response, 20 * 1024 * 1024);
      return { buffer, mimeType: response.headers.get("content-type") ?? "image/jpeg" };
    } catch (err) {
      this.logger.warn(`Telegram media download failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}
