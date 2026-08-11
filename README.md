# Codex Discord Bridge

A macOS bridge between Discord bots and local Codex sessions.

Each agent keeps one Discord bot, one Codex thread, and one detached tmux session bound together.
One bot may listen in multiple allowed Discord channels, and all of those channels share that
agent's Codex conversation.

## Requirements

- macOS
- Node.js 22 or newer
- The Codex CLI authenticated on the machine
- tmux
- A Discord bot application with the Message Content intent enabled

The bot needs normal channel access plus permission to create and send in public threads. File
delivery also requires permission to attach files.

## Build

```zsh
npm ci
npm run native:build
npm run build
```

Native helpers are built for the publisher machine's current architecture. Build the project on the
macOS machine that will run the bridge.

## Provision an Agent

Create a Discord bot, invite it to the target server, then run:

```zsh
node dist/cli.js provision bot-one \
  --owner YOUR_DISCORD_USER_ID \
  --cwd /absolute/path/to/project \
  --channel CHANNEL_ID
```

The command securely prompts for the bot token, stores it in macOS Keychain, creates a Codex
thread, and starts a detached tmux runner. The project directory can be anywhere on the machine.

Use `--mention` to require bot mentions in an allowed channel. Repeat `--channel` to allow more
channels for the same bot. Use a separate Discord bot token for every additional agent.

## License

[MIT](LICENSE)
