import type { PtyManager } from "../pty/manager.js";
import type { SessionRepository } from "../db/sessions.js";
import type { DiscoveredSession } from "../discovery/sessions.js";
import type { Picker } from "../session/picker.js";
import type { MessageSender } from "../channel/types.js";
import type { Logger } from "../utils/logger.js";

export interface CommandContext {
  sessionRepo: SessionRepository;
  ptyManager: PtyManager;
  sender: MessageSender;
  sessionPicker: Picker<DiscoveredSession>;
  filePicker: Picker<string>;
  /** Directory picked from /repo — see cmdRepo/knownRepoDirectories in handlers.ts. */
  repoPicker: Picker<string>;
  logger: Logger;
}
