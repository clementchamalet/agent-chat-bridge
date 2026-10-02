import fs from "node:fs";
import { Bridge } from "./bridge.js";
import { ChannelHub } from "./channel/hub.js";
import { COMMAND_DEFS } from "./commands/definitions.js";
import { config, validateConfig } from "./config.js";
import { openDatabase } from "./db/database.js";
import { SessionRepository } from "./db/sessions.js";
import { BridgeState } from "./db/state.js";
import { PtyManager } from "./pty/manager.js";
import { Picker } from "./session/picker.js";
import { startReapWatchdog } from "./session/reapWatchdog.js";
import { startWatchdog } from "./session/watchdog.js";
import { startYieldWatchdog } from "./session/yieldWatchdog.js";
import type { DiscoveredSession } from "./discovery/sessions.js";
import { makeLogger } from "./utils/logger.js";
import { WhatsAppClient } from "./whatsapp/client.js";
import { WhatsAppSender } from "./whatsapp/sender.js";
import { TelegramChannel } from "./telegram/channel.js";

async function main(): Promise<void> {
  validateConfig();
  const logger = makeLogger(config.logLevel, "bridge");

  // First-run convenience: make sure the default working directory exists so
  // a fresh install works without the user pre-creating it by hand.
  fs.mkdirSync(config.defaultCwd, { recursive: true });

  const db = openDatabase();
  const state = new BridgeState(db);
  const sessionRepo = new SessionRepository(db);
  const ptyManager = new PtyManager(
    logger.child({ mod: "pty" }),
    config.promptIdleMs,
    config.progressCheckMs,
    (jid) => sessionRepo.get(jid)?.verbose ?? false,
  );
  const whatsapp = config.whatsappEnabled
    ? new WhatsAppClient(logger.child({ mod: "whatsapp" }), (id) => state.claimEvent(id))
    : null;
  const whatsappSender = config.whatsappEnabled ? new WhatsAppSender(logger.child({ mod: "whatsapp-sender" })) : null;
  const telegram = config.telegramToken
    ? new TelegramChannel(
        {
          token: config.telegramToken,
          allowedUsers: config.telegramAllowedUsers,
          maxAgeMs: config.webhookMaxAgeMs,
          getOffset: () => state.getNumber("telegram_offset"),
          saveOffset: (offset) => state.setNumber("telegram_offset", offset),
        },
        logger.child({ mod: "telegram" }),
      )
    : null;
  const channels = new ChannelHub(whatsapp, whatsappSender, telegram);
  const sessionPicker = new Picker<DiscoveredSession>();
  const filePicker = new Picker<string>();
  const repoPicker = new Picker<string>();

  // Re-synced on every startup — see WhatsAppSender.registerCommands.
  void whatsappSender?.registerCommands(COMMAND_DEFS);

  let watchForFree: ReturnType<typeof startYieldWatchdog>["watchForFree"] = () => {};
  const bridge = new Bridge({
    source: channels,
    ptyManager,
    sessionRepo,
    sender: channels,
    sessionPicker,
    filePicker,
    repoPicker,
    logger,
    watchForFree: (jid, target) => watchForFree(jid, target),
  });
  bridge.wire();

  const stopWatchdog = startWatchdog({
    sessionRepo,
    ptyManager,
    sender: channels,
    logger: logger.child({ mod: "watchdog" }),
    timeoutMinutes: config.waitingTimeoutMinutes,
    maxTaskHours: config.maxTaskHours,
  });

  const yieldWatchdog = startYieldWatchdog({
    sessionRepo,
    ptyManager,
    sender: channels,
    logger: logger.child({ mod: "yield-watchdog" }),
    presentArbitration: (jid, target, elsewherePids) => bridge.presentArbitration(jid, target, elsewherePids, "mac"),
  });
  watchForFree = yieldWatchdog.watchForFree;

  const stopReapWatchdog = startReapWatchdog({
    sessionRepo,
    ptyManager,
    logger: logger.child({ mod: "reap-watchdog" }),
    idleHours: config.reapIdleHours,
  });

  whatsapp?.on("ready", () => logger.info("WhatsApp channel is ready"));

  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${signal}, shutting down`);
    const deadline = setTimeout(() => process.exit(1), 15_000);
    deadline.unref();
    stopWatchdog();
    yieldWatchdog.stop();
    stopReapWatchdog();
    await channels.stop().catch((err) => logger.error("channel shutdown failed:", err));
    await bridge.stop();
    const live = sessionRepo.listAll().filter((session) => ptyManager.isAlive(session.jid));
    await Promise.all(live.map((session) => ptyManager.detach(session.jid)));
    db.close();
    clearTimeout(deadline);
    process.exit(exitCode);
  };
  const requestShutdown = (signal: string, exitCode = 0) =>
    shutdown(signal, exitCode).catch((err) => {
      logger.error("shutdown failed:", err);
      process.exit(1);
    });
  process.on("SIGINT", () => void requestShutdown("SIGINT"));
  process.on("SIGTERM", () => void requestShutdown("SIGTERM"));

  try {
    await channels.start();
  } catch (err) {
    logger.error("channel startup failed:", err);
    await requestShutdown("startup failure", 1);
    return;
  }
  logger.info("bridge is ready");
}

main().catch((err) => {
  console.error("fatal startup error:", err);
  process.exit(1);
});
