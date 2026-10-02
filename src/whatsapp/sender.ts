import fs from "node:fs";
import { isUtf8 } from "node:buffer";
import path from "node:path";
import { config } from "../config.js";
import { chunkMessage } from "../utils/chunk.js";
import type { Logger } from "../utils/logger.js";
import { mimeTypeFor } from "../utils/mime.js";
import { stripLegacyFooter } from "../channel/outbound.js";
import { readLimitedResponse } from "../utils/readLimitedResponse.js";
import { readDocument } from "../utils/document.js";
import type { Reaction, SendTextOptions } from "../channel/types.js";

const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024; // 64MB — generous local cap, not a WhatsApp hard limit.

const SUPPORTED_MEDIA_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function documentMimeType(filePath: string, buffer: Buffer): string {
  const mime = mimeTypeFor(filePath);
  if (SUPPORTED_MEDIA_TYPES.has(mime)) return mime;
  if (isUtf8(buffer) && !buffer.some((byte) => (byte < 32 && ![9, 10, 12, 13].includes(byte)) || byte === 127)) {
    return "text/plain";
  }
  throw new Error("WhatsApp does not support this file type. Use Telegram to send it.");
}

const MAX_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 500;

const TRANSIENT_API_CODES = new Set([4, 80007, 130429, 131000, 131016, 131056]);
const TRANSIENT_RETRY_DELAYS_MS = [3_000, 8_000, 20_000, 40_000];

class TransientApiError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type FooterProvider = (jid: string) => string;

interface GraphApiError {
  error?: { message?: string; type?: string; code?: number };
}

/** Thin wrapper around the WhatsApp Cloud API (Graph API `/messages` and `/media` endpoints) — sending, reacting, and downloading media the user sent us. */
export class WhatsAppSender {
  private footerProvider: FooterProvider | null = null;
  private readonly sendChains = new Map<string, Promise<string | undefined>>();

  constructor(private readonly logger: Logger) {}

  /** Installs the bridge-owned footer context without coupling this API client to session storage. */
  setFooterProvider(provider: FooterProvider): void {
    this.footerProvider = provider;
  }

  private messagesUrl(): string {
    return `https://graph.facebook.com/${config.graphApiVersion}/${config.whatsappPhoneNumberId}/messages`;
  }

  private mediaUrl(): string {
    return `https://graph.facebook.com/${config.graphApiVersion}/${config.whatsappPhoneNumberId}/media`;
  }

  private conversationalAutomationUrl(): string {
    return `https://graph.facebook.com/${config.graphApiVersion}/${config.whatsappPhoneNumberId}/conversational_automation`;
  }

  async registerCommands(commands: { name: string; description: string }[]): Promise<void> {
    try {
      await this.post(
        this.conversationalAutomationUrl(),
        JSON.stringify({
          commands: commands.map((c) => ({ command_name: c.name, command_description: c.description })),
        }),
        { "Content-Type": "application/json" },
      );
    } catch (err) {
      this.logger.warn("failed to register WhatsApp command menu:", err);
    }
  }

  private async post(
    url: string,
    body: string | FormData,
    extraHeaders: Record<string, string> = {},
  ): Promise<unknown> {
    let networkAttempts = 0;
    let transientAttempts = 0;
    for (;;) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${config.whatsappAccessToken}`, ...extraHeaders },
          body,
          signal: AbortSignal.timeout(30_000),
        });

        const json = (await res.json().catch(() => null)) as (GraphApiError & Record<string, unknown>) | null;
        if (!res.ok) {
          const code = json?.error?.code;
          const message = `WhatsApp Cloud API request failed: ${json?.error?.message ?? `HTTP ${res.status}`}${code ? ` (#${code})` : ""}`;
          if ((code !== undefined && TRANSIENT_API_CODES.has(code)) || res.status === 429 || res.status >= 500) {
            throw new TransientApiError(message);
          }
          throw new Error(message);
        }
        return json;
      } catch (err) {
        if (err instanceof TransientApiError) {
          const delay = TRANSIENT_RETRY_DELAYS_MS[transientAttempts++];
          if (delay === undefined) throw err;
          this.logger.warn(`${err.message} — retrying in ${delay / 1000}s`);
          await sleep(delay);
          continue;
        }
        const isNetworkFailure =
          err instanceof TypeError || (err instanceof DOMException && err.name === "TimeoutError");
        networkAttempts++;
        if (!isNetworkFailure || networkAttempts >= MAX_ATTEMPTS) throw err;
        this.logger.warn(
          `network error posting to Graph API (attempt ${networkAttempts}/${MAX_ATTEMPTS}), retrying:`,
          err,
        );
        await sleep(RETRY_BASE_DELAY_MS * networkAttempts);
      }
    }
  }

  /** Sends (possibly chunked) text and returns the last chunk's message id, for reacting to it afterwards. */
  async sendText(jid: string, text: string, options?: SendTextOptions): Promise<string | undefined> {
    const body = stripLegacyFooter(text).trimEnd();

    const prior = this.sendChains.get(jid) ?? Promise.resolve(undefined);
    const send = async () => {
      // Resolve agent metadata at delivery time so queued replies show the current duration.
      const footer = options?.agentReply ? this.footerProvider?.(jid)?.slice(0, 512) : undefined;
      const footerBudget = footer ? footer.length + 2 : 0;
      const chunks = chunkMessage(body, Math.max(256, 3500 - footerBudget));
      const messages = footer ? chunks.map((chunk) => `${chunk}\n\n${footer}`) : chunks;
      let lastId: string | undefined;
      this.logger.info(`→ ${jid}: ${body.length} chars in ${messages.length} message(s)`);
      for (const chunk of messages) {
        const result = (await this.post(
          this.messagesUrl(),
          JSON.stringify({
            messaging_product: "whatsapp",
            to: jid,
            type: "text",
            text: { body: chunk, preview_url: false },
          }),
          { "Content-Type": "application/json" },
        )) as { messages?: { id: string }[] };
        lastId = result?.messages?.[0]?.id;
        if (!lastId) throw new Error("WhatsApp send response did not contain a message ID");
      }
      return lastId;
    };
    const current = prior.then(send, send);
    this.sendChains.set(jid, current);

    try {
      return await current;
    } catch (err) {
      this.logger.error(`failed to send text to ${jid}:`, err);
      throw err;
    } finally {
      if (this.sendChains.get(jid) === current) this.sendChains.delete(jid);
    }
  }

  async react(jid: string, emoji: Reaction, messageId: string): Promise<void> {
    try {
      await this.post(
        this.messagesUrl(),
        JSON.stringify({
          messaging_product: "whatsapp",
          to: jid,
          type: "reaction",
          reaction: { message_id: messageId, emoji },
        }),
        { "Content-Type": "application/json" },
      );
    } catch (err) {
      // A reaction is cosmetic — one line, not a stack trace per message.
      this.logger.warn(`failed to react ${emoji} on ${jid}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async downloadMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
    try {
      const metaRes = await fetch(`https://graph.facebook.com/${config.graphApiVersion}/${mediaId}`, {
        headers: { Authorization: `Bearer ${config.whatsappAccessToken}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!metaRes.ok) throw new Error(`media metadata fetch failed: HTTP ${metaRes.status}`);
      const meta = (await metaRes.json()) as { url?: string; mime_type?: string; file_size?: number };
      if (!meta.url) throw new Error("media metadata response had no url");
      if ((meta.file_size ?? 0) > 20 * 1024 * 1024) throw new Error("media exceeds the 20 MB download limit");

      const fileRes = await fetch(meta.url, {
        headers: { Authorization: `Bearer ${config.whatsappAccessToken}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!fileRes.ok) throw new Error(`media download failed: HTTP ${fileRes.status}`);

      const buffer = await readLimitedResponse(fileRes, 20 * 1024 * 1024);
      return { buffer, mimeType: meta.mime_type ?? "application/octet-stream" };
    } catch (err) {
      this.logger.error(`failed to download media ${mediaId}:`, err);
      return null;
    }
  }

  async sendDocument(jid: string, filePath: string, fileName?: string): Promise<void> {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_DOCUMENT_BYTES) {
      await this.sendText(
        jid,
        `⚠️ Skipped attaching *${path.basename(filePath)}* — ${(stat.size / 1024 / 1024).toFixed(1)}MB exceeds the ${
          MAX_DOCUMENT_BYTES / 1024 / 1024
        }MB bridge limit.`,
      );
      return;
    }

    const name = fileName ?? path.basename(filePath);
    try {
      const buffer = readDocument(filePath, MAX_DOCUMENT_BYTES);
      const mimetype = documentMimeType(filePath, buffer);
      const form = new FormData();
      form.append("messaging_product", "whatsapp");
      form.append("type", mimetype);
      form.append("file", new Blob([new Uint8Array(buffer)], { type: mimetype }), name);

      const uploadResult = (await this.post(this.mediaUrl(), form)) as { id?: string };
      if (!uploadResult.id) throw new Error("media upload did not return an id");

      await this.post(
        this.messagesUrl(),
        JSON.stringify({
          messaging_product: "whatsapp",
          to: jid,
          type: "document",
          document: { id: uploadResult.id, filename: name },
        }),
        { "Content-Type": "application/json" },
      );
    } catch (err) {
      this.logger.error(`failed to send document ${filePath} to ${jid}:`, err);
      await this.sendText(jid, `⚠️ Failed to attach *${name}*: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
