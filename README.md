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

## Build

```bash
npm ci
npm run native:build
npm run build
```

On macOS, native helpers are built for the publisher machine's current architecture. Linux does not
require a bridge-native helper.

## Provision an Agent

Create a Discord bot, invite it to the target server, then run:

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

## Inject Turns from Local Processes

Bots ignore messages from other bots, so a cron job, a local task hub, or another agent hands work
to a running agent through its inject socket instead. Inject is off until you enable it per agent:

```bash
node dist/cli.js inject-config agent-one --log-channel LOG_CHANNEL_ID
node dist/cli.js restart agent-one
node dist/cli.js inject agent-one "Write the morning briefing" --from cron:morning
```

Each injected turn is first posted to the agent's channel with a marker saying it did not come from
the user, then handled like a normal message: progress, the final answer as a reply, and a failure
notice if it cannot run. One line goes to the log channel when one is configured. Pass `--channel`
when the agent has more than one channel. `--mode interrupt` stops the active turn, but the injected
turn still waits behind turns that were already queued.

To show the result somewhere else, such as a morning briefing in the channel you read first, allow
that channel and pass `--announce`:

```bash
node dist/cli.js inject-config agent-one --log-channel LOG_CHANNEL_ID --announce-channel MAIN_CHANNEL_ID
node dist/cli.js restart agent-one
node dist/cli.js inject agent-one "Write the morning briefing" --from cron:morning --announce MAIN_CHANNEL_ID
```

The turn still runs in the agent's own channel. When it completes, its final answer is also posted
to the announce channel as plain messages (no reply, no mentions, no files). An interrupted or failed turn is not
announced, and a failed announce is reported in the agent's channel. Requests for a channel that is
not allowed are refused before anything is posted. The bot needs permission to send messages in the
announce channel.

`inject-config` keeps stored settings you do not pass, so adding announce channels later keeps the
log channel; `--announce-channel` replaces the whole announce list. A running agent only learns new
settings or request fields on restart: rebuild, run `inject-config`, and restart the agent before a
caller starts sending `--announce`, or the request is refused and the turn never runs.

The socket lives at `<state root>/run/<instance id>.sock` with mode `0600`, so only the bridge's OS
user can inject. It does not pass through the Discord access policy; Codex approval buttons still
apply. The agent refuses more than 10 injected turns in 10 minutes, which is the hard limit on reply
loops. It also refuses a repeat from the same sender within 60 seconds and requests past two
agent-to-agent hops (`--hop`), but senders choose those values, so treat them as hints. A timed-out
`inject` may still have been delivered; check the channel before retrying. Disable inject with
`inject-config agent-one --disable` and a restart.

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
