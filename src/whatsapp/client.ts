import { createHmac, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import http from "node:http";
import { config, isAllowedNumber } from "../config.js";
import type { Logger } from "../utils/logger.js";
import type { IncomingMessage } from "../channel/types.js";

export type { IncomingMessage } from "../channel/types.js";

interface WhatsAppClientEvents {
  message: [msg: IncomingMessage];
  ready: [];
}

export declare interface WhatsAppClient {
  on<E extends keyof WhatsAppClientEvents>(event: E, listener: (...args: WhatsAppClientEvents[E]) => void): this;
  emit<E extends keyof WhatsAppClientEvents>(event: E, ...args: WhatsAppClientEvents[E]): boolean;
}

// Shape of the relevant slice of a Cloud API webhook POST body. The real
// payload has more fields (statuses, contacts, errors, ...) that we don't
// need — see https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
interface CloudApiWebhookBody {
  entry?: {
    changes?: {
      field?: string;
      value?: {
        messages?: {
          id: string;
          from: string;
          type: string;
          text?: { body?: string };
          image?: { id: string; mime_type?: string; caption?: string };
          /** Unix epoch seconds, as a string — Meta's convention throughout the Graph API. */
          timestamp?: string;
        }[];
      };
    }[];
  }[];
}

function readRawBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error("Webhook payload exceeds 1 MB"));
        req.resume();
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Bounded, self-pruning cache of message ids already handled — Meta retries webhook deliveries it didn't get a fast 200 for. */
class SeenMessageIds {
  private seenAt = new Map<string, number>();

  constructor(private readonly ttlMs: number) {}

  /** Returns true and records the id the first time it's seen; false (a duplicate) every time after, until it ages out. */
  checkAndRecord(id: string): boolean {
    this.prune();
    if (this.seenAt.has(id)) return false;
    this.seenAt.set(id, Date.now());
    return true;
  }

  private prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, seenAt] of this.seenAt) {
      if (seenAt < cutoff) this.seenAt.delete(id);
      else break; // Map iterates in insertion order — everything after this is newer.
    }
  }
}

export class WhatsAppClient extends EventEmitter {
  private server: http.Server | null = null;
  private readonly seenMessageIds = new SeenMessageIds(24 * 60 * 60_000);

  constructor(
    private readonly logger: Logger,
    private readonly claimEvent?: (id: string) => boolean,
  ) {
    super();
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        this.logger.error("webhook request handler error:", err);
        if (!res.headersSent) res.writeHead(err instanceof Error && err.message.includes("1 MB") ? 413 : 500).end();
      });
    });

    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      server.once("error", reject);
      server.listen(config.webhookPort, config.webhookHost, () => {
        server.off("error", reject);
        resolve();
      });
    });

    this.logger.info(
      `webhook server listening on http://${config.webhookHost}:${config.webhookPort}/webhook — ` +
        `expose it publicly (e.g. \`ngrok http ${config.webhookPort}\`) and configure that URL in the Meta dashboard`,
    );
    this.emit("ready");
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"status":"ok"}');
      return;
    }
    if (url.pathname !== "/webhook") {
      res.writeHead(404).end();
      return;
    }

    if (req.method === "GET") {
      this.handleVerification(url, res);
      return;
    }

    if (req.method === "POST") {
      const raw = await readRawBody(req);

      if (config.whatsappAppSecret && !this.verifySignature(raw, req.headers["x-hub-signature-256"])) {
        this.logger.warn("rejected webhook POST with missing/invalid X-Hub-Signature-256");
        res.writeHead(403).end();
        return;
      }

      let body: CloudApiWebhookBody | null = null;
      try {
        body = raw.length > 0 ? JSON.parse(raw.toString("utf8")) : null;
      } catch (err) {
        this.logger.warn("failed to parse webhook POST body as JSON:", err);
      }

      res.writeHead(200).end(); // acknowledge immediately, per Meta's webhook contract
      this.handleWebhookEvent(body);
      return;
    }

    res.writeHead(405).end();
  }

  /** Constant-time comparison against the HMAC-SHA256 of the *raw* body — parsed-then-restringified JSON can byte-diff from what Meta actually signed. */
  private verifySignature(raw: Buffer, header: string | string[] | undefined): boolean {
    if (!config.whatsappAppSecret || typeof header !== "string" || !/^sha256=[0-9a-f]{64}$/i.test(header)) {
      return false;
    }
    const expected = header.slice("sha256=".length);

    const computed = createHmac("sha256", config.whatsappAppSecret).update(raw).digest("hex");
    const expectedBuf = Buffer.from(expected, "hex");
    const computedBuf = Buffer.from(computed, "hex");
    if (expectedBuf.length !== computedBuf.length) return false;
    return timingSafeEqual(expectedBuf, computedBuf);
  }

  private handleVerification(url: URL, res: http.ServerResponse): void {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && token === config.whatsappVerifyToken && challenge) {
      this.logger.info("webhook verification succeeded");
      res.writeHead(200, { "Content-Type": "text/plain" }).end(challenge);
    } else {
      this.logger.warn("webhook verification failed (check WHATSAPP_VERIFY_TOKEN matches the Meta dashboard)");
      res.writeHead(403).end();
    }
  }

  private handleWebhookEvent(body: CloudApiWebhookBody | null): void {
    const entries = Array.isArray(body?.entry) ? body.entry : [];
    const messages = entries
      .flatMap((entry) => (Array.isArray(entry?.changes) ? entry.changes : []))
      .flatMap((change) => (Array.isArray(change?.value?.messages) ? change.value.messages : []));

    for (const msg of messages) {
      if (
        !msg ||
        typeof msg.id !== "string" ||
        !msg.id ||
        typeof msg.from !== "string" ||
        typeof msg.type !== "string"
      ) {
        continue;
      }
      // Checks that apply regardless of message type, before looking at its content.
      if (!isAllowedNumber(msg.from)) {
        this.logger.warn(`dropped message from non-whitelisted number: ${msg.from}`);
        continue;
      }
      if (!this.seenMessageIds.checkAndRecord(msg.id) || (this.claimEvent && !this.claimEvent(`wa:${msg.id}`))) {
        this.logger.warn(`dropped duplicate delivery of message ${msg.id} (Meta webhook retry)`);
        continue;
      }
      if (msg.timestamp) {
        const ageMs = Date.now() - Number(msg.timestamp) * 1000;
        if (!Number.isFinite(ageMs) || ageMs < -60_000 || ageMs > config.webhookMaxAgeMs) {
          this.logger.warn(`dropped message ${msg.id} with an invalid or stale timestamp`);
          continue;
        }
      }

      if (msg.type === "image" && typeof msg.image?.id === "string") {
        this.emit("message", {
          jid: msg.from,
          text: typeof msg.image.caption === "string" ? msg.image.caption.trim() : "",
          key: msg.id,
          image: {
            mediaId: msg.image.id,
            caption: typeof msg.image.caption === "string" ? msg.image.caption.trim() || null : null,
          },
        });
        continue;
      }

      if (msg.type !== "text" || typeof msg.text?.body !== "string" || !msg.text.body.trim()) continue;
      this.emit("message", { jid: msg.from, text: msg.text.body.trim(), key: msg.id });
    }
  }

  /** The actual bound port — useful when WEBHOOK_PORT=0 (OS-assigned), e.g. in tests. */
  getPort(): number | null {
    const addr = this.server?.address();
    return addr && typeof addr === "object" ? addr.port : null;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    this.server = null;
  }
}
