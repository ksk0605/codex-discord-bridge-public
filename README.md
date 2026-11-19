# Codex Discord Bridge

A persistent bridge between Discord bots and local Codex sessions on macOS and Linux.

Each agent keeps one Discord bot, one Codex thread, and one detached tmux session bound together.
One bot may listen in multiple allowed Discord channels, and all of those channels share that
agent's Codex conversation.

## Requirements

- Node.js 22 or newer
- The Codex CLI authenticated on the machine
- tmux
- A Discord bot application with the Message Content intent enabled

On macOS, install Xcode Command Line Tools so the Keychain helper can be compiled. On Linux, bot
tokens are stored in protected local files by default; AWS, IAM, and KMS setup are not required.

The bot needs normal channel access plus permission to create and send in public threads. File
delivery also requires permission to attach files. The bridge never creates Discord applications or
bot tokens.

## Create the Discord Bot

These steps happen in the Discord web or desktop app and must be done by a person. An agent setting
up the bridge should stop here and hand these steps to the user.

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and choose
   **New Application**. Give it the name the agent should have.
2. Open **Bot** in the left menu.
   - Under **Privileged Gateway Intents**, turn on **Message Content Intent** and save. Without it
     the bot sees messages but not their text.
   - Choose **Reset Token** and copy the token. Keep it only until `provision` asks for it; do not
     paste it into Discord, a chat with an agent, a file, or a command line.
3. Open **OAuth2 → URL Generator**.
   - Scopes: `bot` and `applications.commands`.
   - Bot permissions: View Channels, Send Messages, Send Messages in Threads, Create Public
     Threads, Read Message History, Attach Files, Add Reactions.
   - Open the generated URL, pick your server, and authorize.
4. Copy the IDs `provision` needs. In Discord, open **User Settings → Advanced** and turn on
   **Developer Mode**. Then right-click your own name → **Copy User ID** (this is `--owner`), and
   right-click the channel the agent should answer in → **Copy Channel ID** (this is `--channel`).
   If the channel is private, add the bot to it.

## Build

```bash
npm ci
npm run native:build
npm run build
```

On macOS, native helpers are built for the publisher machine's current architecture. Linux does not
require a bridge-native helper.

## Provision an Agent

After [creating the Discord bot](#create-the-discord-bot), run:

```bash
node dist/cli.js provision bot-one \
  --owner YOUR_DISCORD_USER_ID \
  --cwd /absolute/path/to/project \
  --channel CHANNEL_ID
```

The command securely prompts for the bot token, stores it in macOS Keychain or the Linux protected
local credential directory, creates a Codex thread, and starts a detached tmux runner. The project
directory can be anywhere on the machine.

Use `--mention` to require bot mentions in an allowed channel. Repeat `--channel` to allow more
channels for the same bot. Use a separate Discord bot token for every additional agent.

## Everyday Commands

`<agent>` is the agent name or id shown by `status`.

```bash
node dist/cli.js status            # every agent: desiredState, observedState, tmux session
node dist/cli.js status <agent>    # one agent
node dist/cli.js restart <agent>   # stop and start again (use after rebuilding the bridge)
node dist/cli.js stop <agent>      # stop; it stays stopped across reboots
node dist/cli.js start <agent>     # start a stopped agent
node dist/cli.js restore           # start every agent whose desiredState is running
```

Each agent runs in a detached tmux session named in `status` (for example
`codex-discord-1a2b3c4d`). `tmux attach -t <session>` shows it live; detach with `Ctrl-b d` rather
than closing the window. Per-agent state and logs live in
`~/.codex-discord-bridge/instances/<agent id>/`, including `runtime-lifecycle.jsonl`.

## Start Agents After a Mac Reboot

tmux sessions do not survive a reboot. On macOS, a LaunchAgent can run `restore` at login. Replace
the paths with your own (`which node` and the absolute path to this repository):

```xml
<!-- ~/Library/LaunchAgents/com.example.codex-discord-restore.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.example.codex-discord-restore</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/ABSOLUTE/PATH/TO/codex-discord-bridge-public/dist/cli.js</string>
    <string>restore</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/tmp/codex-discord-restore.log</string>
  <key>StandardErrorPath</key><string>/tmp/codex-discord-restore.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.example.codex-discord-restore.plist
```

`PATH` must include the directories that hold `node`, `tmux`, and `codex`. Only agents whose
`desiredState` is `running` come back; agents you stopped stay stopped. Linux uses systemd instead
(see below).

## Troubleshooting

- **The bot is online but never answers.** Check that Message Content Intent is on, that the message
  is in a channel passed with `--channel`, that it came from the `--owner` user, and, with
  `--mention`, that it mentions the bot. Then check `status`.
- **The bot is offline.** Run `status`. If `observedState` is not `running`, run `start <agent>`.
  If it says `running` but the bot is offline, attach to its tmux session to read the error, then
  `restart <agent>`.
- **The agent stopped answering in the middle of work.** Attach to its tmux session and read the
  last error, and look at the end of `runtime-lifecycle.jsonl` for a failure that repeats every few
  seconds. `progress reconcile <agent>` retries closing out the stuck turn. If that does not help,
  `restart <agent>`.
- **`restart` times out ("tmux session did not stop").** The agent is now marked stopped. Run
  `stop --force <agent>` and then `start <agent>`. Check `status` afterwards: `desiredState` must be
  `running`, or the agent stays down after the next reboot.
- **`codex` is not found or not logged in.** Run `codex login` as the same OS user that runs the
  bridge, then `restart <agent>`.

## Linux and EC2

The Linux runtime uses `/proc/self/fd` for retained outbound file paths, stores Discord bot tokens
in local protected files by default, and keeps each agent in a detached tmux session. It has no
inbound HTTP listener. The CI matrix exercises macOS and Ubuntu; Amazon Linux 2023 is a suitable
EC2 host.

### Default Local Setup

Install Node.js 22 or newer, `tmux`, and the Codex CLI for the Linux user that will own the bridge.
Install `jq` only for the optional systemd setup below. On Amazon Linux 2023:

```bash
sudo dnf install -y tmux jq
```

Clone the bridge, install dependencies, build it, authenticate the Codex CLI as that same user, and
run the normal `provision` command with the Discord bot token and project directory. No AWS account
settings, IAM role, KMS key, or manual `chmod` command is needed.

The default state root is `~/.codex-discord-bridge`. The bridge creates its `credentials` directory
with mode `0700` and each bot credential record with mode `0600`. Set
`CODEX_DISCORD_STATE_ROOT` before provisioning to use another location. Run bridge commands as the
same Linux user so the tmux runner and credentials share an owner. Do not put bot tokens in shell
profiles, systemd units, or command arguments.

### Boot Recovery with systemd

`restore` starts only persisted agents whose `desiredState` is `running`; stopped agents are not
resurrected. After building, render and install the unit files. This default form uses the local
credential store and deliberately excludes AWS and SSM settings:

```bash
STATE_ROOT="${CODEX_DISCORD_STATE_ROOT:-$HOME/.codex-discord-bridge}"
node dist/cli.js --json systemd render \
  --user "$USER" \
  --home "$HOME" \
  --state-root "$STATE_ROOT" \
  --working-directory "$PWD" \
  --node "$(command -v node)" \
  --cli "$PWD/dist/cli.js" \
  --path "$PATH" > /tmp/codex-discord-systemd.json

jq -r '.data.service' /tmp/codex-discord-systemd.json | \
  sudo tee /etc/systemd/system/codex-discord-restore.service >/dev/null
jq -r '.data.timer' /tmp/codex-discord-systemd.json | \
  sudo tee /etc/systemd/system/codex-discord-restore.timer >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now codex-discord-restore.timer
systemctl status codex-discord-restore.timer
```

The timer runs shortly after boot and then every minute. Its `KillMode=process` setting preserves
the detached tmux sessions. Inspect failures with `journalctl -u codex-discord-restore.service` and
retry manually with `node dist/cli.js restore`.

### Optional SSM Credential Store

SSM is opt-in for deployments that require a managed AWS credential store. Before registering or
restoring a bot, explicitly select it and configure AWS access for the selected SSM hierarchy:

```bash
export CODEX_DISCORD_CREDENTIAL_STORE=ssm
export AWS_REGION=ap-northeast-2
export CODEX_DISCORD_SSM_PREFIX=/production/codex-discord/bots
```

Generate an SSM-backed systemd unit with `--credential-store ssm`. Existing SSM installations must
set `CODEX_DISCORD_CREDENTIAL_STORE=ssm` for every bridge command and regenerate their unit; AWS
environment variables alone never select SSM.

## License

[MIT](LICENSE)
