# Agent Chat Bridge

Control Claude Code, OpenCode, and Codex CLI from a private WhatsApp or Telegram chat. The bridge runs on macOS, keeps interactive agent processes in `tmux`, and stores chat routing state in SQLite. Both channels support text, incoming images, and outgoing files.

## Setup

Requirements: macOS, Node.js 20.19+, 22.12+, or 24+, `tmux`, and at least one installed and authenticated agent CLI (`claude`, `opencode`, or Codex CLI 0.160.0+). The CLI must be available on the bridge account's `PATH`. Codex runs with a dedicated server for each bridge session.

```sh
brew install tmux
npm ci
cp .env.example .env
```

Configure at least one channel in `.env`, create the directory selected by `DEFAULT_CWD`, then run:

```sh
npm run doctor
npm start
```

Environment variables override `.env`. Tests do not load `.env`.

### WhatsApp

Use the official WhatsApp Cloud API. Set `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, and a supported `GRAPH_API_VERSION` in `vN.N` format. Set `ALLOWED_NUMBERS` to comma-separated international sender numbers, including country codes, without `+`.

Expose the local listener through an HTTPS tunnel or reverse proxy. In Meta's app settings, set the callback to `https://YOUR_HOST/webhook`, use `WHATSAPP_VERIFY_TOKEN` for verification, and subscribe to messages. Incoming requests require valid signatures. The listener defaults to `127.0.0.1:3000`; `/healthz` returns `{"status":"ok"}`.

### Telegram

Create a bot with [BotFather](https://t.me/BotFather) and set `TELEGRAM_BOT_TOKEN`. Message the bot, read your numeric `message.from.id` from [getUpdates](https://core.telegram.org/bots/api#getupdates), and add it to `TELEGRAM_ALLOWED_USER_IDS` (comma-separated).

Only allowlisted private chats are accepted. Telegram uses long polling and outbound HTTPS; remove any existing bot webhook with `deleteWebhook` before starting. It does not need a public listener.

See [.env.example](.env.example) for working directories, models, timeouts, limits, and logging settings.

## Commands

| Command | Action |
| --- | --- |
| `/new [engine] [model\|--model name] [effort] [path]` | Start a conversation |
| `/sessions [filter] [--all]` | Browse and resume conversations |
| `/repo [filter]` | Switch the working directory |
| `/file [name]` | Send a file from the working directory |
| `/stop` | Interrupt the current turn |
| `/kill` | Stop the process and clear queued input |
| `/discard` | Clear queued input or cancel the pending initial prompt |
| `/status`, `/screen`, `/mac` | Show status, terminal screen, or local attach command |
| `/diff` | Show staged and unstaged changes and untracked filenames |
| `/commit <message>` | Stage all changes, commit, and push to the configured remote |
| `/verbose [on\|off]` | Toggle progress updates |
| `/usage`, `/help` | Show supported usage information or commands |

Other slash commands go to the active agent. Quote paths containing spaces, for example `/new codex --model my-model "~/Projects/My App"`. Engines are `claude`, `opencode`, and `codex`. Effort levels (`low`, `medium`, `high`, `xhigh`, `max`) apply to Claude Code only. Switching engines clears inherited model and effort settings.

An existing project name selects its directory; an unknown bare name creates a folder under `WORKSPACES_ROOT`. Ambiguous names require a more specific name or an explicit path. Numeric replies select entries in the latest picker. `/sessions` hides old or very short non-live conversations by default; `--all` removes those filters. Discovery returns up to 30 recent results across engines.

Input received during execution queues in order, up to 20 messages per chat. Switching conversations detaches the previous connection; its agent may continue running. A conversation already open elsewhere offers takeover, a notification when free, or a fork. `/usage` supports Claude Code and OpenCode's DeepSeek balance; Codex usage is unavailable.

## Security and data

Run under a dedicated OS account with access limited to the intended projects. Keep credentials in `.env` or the process environment. `review` leaves tool approvals interactive. Use `auto` only in a trusted, isolated environment; it bypasses agent approvals. Codex retains its `workspace-write` sandbox in either mode.

`/file`, `/diff`, and `/commit` reject sensitive paths, including credentials and SQLite files. File delivery also rejects symbolic links and non-regular files. These checks do not restrict the coding agent's own filesystem access. `/commit` requires an idle session and **pushes changes**.

WhatsApp sends UTF-8 source and text files as `text/plain`, preserving their contents and filenames. PDF, Office documents, JPEG, PNG, and WebP retain their media types. Other binary formats require Telegram. File limits are 64 MB for WhatsApp and 49 MB for Telegram.

The private SQLite file stores session mappings, delivery IDs for 24 hours, and the Telegram polling offset. Incoming images are stored temporarily and removed after 24 hours during image processing or pruning. Agent authentication and transcripts belong to the installed CLIs. Messages and files pass through the messaging service and configured agent provider. Logs omit message bodies and redact configured channel tokens; redact terminal captures before sharing them.

## Operations and limitations

Run one bridge process per database. For a compiled build, run `npm run build` followed by `node dist/index.js` from the configured working directory. Shutdown detaches agent processes; restart reconnects to sessions recorded as active. Idle cleanup manages only bridge-owned, single-pane `tmux` sessions and excludes active or waiting conversations and external processes.

`npm run prune -- 30` removes idle session records older than 30 days whose `tmux` process is gone, plus expired incoming images. Agent transcripts remain available. Back up SQLite consistently before upgrades:

```sh
umask 077
sqlite3 data/bridge.sqlite3 '.backup backup.sqlite3'
```

To restore, stop the bridge, replace the database, remove stale `-wal` and `-shm` companions, and restart.

Terminal recognition depends on the installed CLI version. Claude Code and Codex use transcripts with a terminal fallback; OpenCode uses terminal screens. Codex discovery covers local sessions only. Delivery is best effort: after a crash, acknowledged input may need to be resent.

If setup or delivery fails, run `npm run doctor`. Check channel credentials and allowlists, the WhatsApp HTTPS callback and subscription, or Telegram's existing webhook. Use `/status` and `/screen` to inspect agent problems, and `/mac` to answer directly in the terminal if recognition fails.

## Development

```sh
npm run check   # typecheck, lint, tests, build
npm run format
```

Tests use controlled CLI fixtures. CI runs on macOS with Node.js 20, 22, and 24. The installation helper restores executable permissions on `node-pty`'s packaged spawn helpers.

MIT licensed; see [LICENSE](LICENSE).
