export type Reaction = "⏳" | "💬" | "✅" | "🛑" | "❌" | "🤔" | "📥";

export interface IncomingMessage {
  jid: string;
  text: string;
  key: string;
  image?: { mediaId: string; caption: string | null };
}

export interface MessageSource {
  on(event: "message", listener: (message: IncomingMessage) => void): this;
}

export interface SendTextOptions {
  agentReply?: boolean;
}

export interface MessageSender {
  sendText(jid: string, text: string, options?: SendTextOptions): Promise<string | undefined>;
  sendDocument(jid: string, filePath: string, fileName?: string): Promise<void>;
  react(jid: string, emoji: Reaction, messageId: string): Promise<void>;
  downloadMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string } | null>;
  setFooterProvider?(provider: (jid: string) => string): void;
}
