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

On macOS, install Xcode Command Line Tools so the Keychain helper can be compiled. On Linux, use an
EC2 instance role with access to AWS Systems Manager Parameter Store; bot tokens are stored as SSM
`SecureString` parameters instead of a local file.

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

The command securely prompts for the bot token, stores it in macOS Keychain or Linux SSM Parameter
Store, creates a Codex thread, and starts a detached tmux runner. The project directory can be
anywhere on the machine.

Use `--mention` to require bot mentions in an allowed channel. Repeat `--channel` to allow more
channels for the same bot. Use a separate Discord bot token for every additional agent.

## Linux on EC2

The Linux runtime resolves retained outbound file paths through `/proc/self/fd`, stores Discord bot
tokens in SSM Parameter Store, and keeps each agent in its detached tmux session. It has no inbound
HTTP listener. The CI matrix exercises macOS and Ubuntu; Amazon Linux 2023 is a suitable EC2 host.

### Host and IAM Setup

Install `tmux`, `jq`, Node.js 22 or newer, and the Codex CLI for the Linux user that will own the
bridge. On Amazon Linux 2023:

```bash
sudo dnf install -y tmux jq
```

Attach an EC2 IAM role rather than exporting AWS access keys. Limit its SSM permissions to the
selected hierarchy. The default is `/codex-discord-bridge/bots/<bot-name>`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ssm:DeleteParameter",
        "ssm:GetParameter",
        "ssm:GetParametersByPath",
        "ssm:PutParameter"
      ],
      "Resource": "arn:aws:ssm:REGION:ACCOUNT_ID:parameter/codex-discord-bridge/bots/*"
    }
  ]
}
```

For a customer-managed KMS key, also grant `kms:Encrypt`, `kms:Decrypt`, and
`kms:GenerateDataKey` on that key in both the IAM role policy and KMS key policy.

Create state owned by the service user and set the non-secret SSM identifiers before provisioning a
bot. Omit the optional prefix and key ID to use the defaults:

```bash
export CODEX_DISCORD_STATE_ROOT=/var/lib/codex-discord-bridge
export AWS_REGION=ap-northeast-2
export CODEX_DISCORD_SSM_PREFIX=/production/codex-discord/bots
export CODEX_DISCORD_SSM_KMS_KEY_ID=alias/codex-discord-bridge
sudo install -d -o ec2-user -g ec2-user -m 700 "$CODEX_DISCORD_STATE_ROOT"
```

Run the build and `provision` command as `ec2-user` (or the selected service user) so the EC2 role,
Codex login, and filesystem ownership all belong to the runner. Do not put Discord tokens or AWS
access keys in shell profiles or systemd unit files.

### Boot Recovery with systemd

`restore` starts only persisted agents whose `desiredState` is `running`. It leaves an existing tmux
session alone, tries every desired agent even if one fails, and returns a non-zero status when any
restore fails so the timer retries it. Explicitly stopped agents are not resurrected.

After building, render and install the unit files. The generated service carries only the non-secret
AWS region, SSM prefix, and KMS key identifier when set:

```bash
node dist/cli.js --json systemd render \
  --user ec2-user \
  --home /home/ec2-user \
  --state-root "$CODEX_DISCORD_STATE_ROOT" \
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

The timer runs shortly after boot and then every minute. Its service uses `KillMode=process`, so its
short reconciliation command does not stop the detached tmux sessions it restores. Inspect failures
with `journalctl -u codex-discord-restore.service` and retry manually with
`node dist/cli.js restore`.

## License

[MIT](LICENSE)
