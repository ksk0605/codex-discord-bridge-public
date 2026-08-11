import { pathToFileURL } from "node:url";
import { password } from "@inquirer/prompts";
import { Command, CommanderError, Option } from "commander";
import { BridgeError, exitCodeFor } from "./domain/errors.js";
import type { WorkspaceProfile } from "./domain/schemas.js";
import { createDefaultManagerService, type ManagerService } from "./manager/service.js";

export interface CliStreams {
  writeOut(text: string): void;
  writeError(text: string): void;
}

export interface CliDependencies {
  readonly service?: ManagerService;
  readonly createService?: () => Promise<ManagerService>;
  readonly readToken?: () => Promise<string>;
  readonly streams?: CliStreams;
}

interface CommandEnvelope {
  readonly ok: boolean;
  readonly command: string;
  readonly data?: unknown;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly remediation?: string;
  };
}

const defaultStreams: CliStreams = {
  writeOut: (text) => process.stdout.write(text),
  writeError: (text) => process.stderr.write(text),
};

function envelopeError(command: string, error: unknown): CommandEnvelope {
  if (error instanceof BridgeError) {
    return {
      ok: false,
      command,
      error: {
        code: error.code,
        message: error.message,
        ...(error.remediation === undefined ? {} : { remediation: error.remediation }),
      },
    };
  }
  return {
    ok: false,
    command,
    error: { code: "RUNTIME", message: "The command failed unexpectedly." },
  };
}

function humanResult(envelope: CommandEnvelope): string {
  if (!envelope.ok) {
    const error = envelope.error;
    return `${error?.code ?? "RUNTIME"}: ${error?.message ?? "Command failed."}${
      error?.remediation === undefined ? "" : `\n${error.remediation}`
    }\n`;
  }
  return `${JSON.stringify(envelope.data, null, 2)}\n`;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export async function runCli(
  arguments_: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const streams = dependencies.streams ?? defaultStreams;
  const service =
    dependencies.service ?? (await (dependencies.createService ?? createDefaultManagerService)());
  const readToken =
    dependencies.readToken ?? (() => password({ message: "Discord bot token", mask: "*" }));
  const program = new Command();
  let exitCode = 0;
  let emitted = false;

  const emit = (envelope: CommandEnvelope): void => {
    emitted = true;
    const json = program.opts<{ json?: boolean }>().json === true;
    (envelope.ok ? streams.writeOut : streams.writeError)(
      json ? `${JSON.stringify(envelope)}\n` : humanResult(envelope),
    );
  };
  const action =
    <Arguments extends unknown[]>(
      name: string,
      operation: (...values: Arguments) => Promise<unknown>,
    ) =>
    async (...values: Arguments): Promise<void> => {
      try {
        emit({ ok: true, command: name, data: await operation(...values) });
      } catch (error) {
        exitCode = exitCodeFor(error);
        emit(envelopeError(name, error));
      }
    };

  program
    .name("codex-discord")
    .description("Manage persistent Discord-to-Codex agent sessions")
    .option("--json", "emit one machine-readable JSON envelope")
    .exitOverride()
    .configureOutput({
      writeOut: streams.writeOut,
      writeErr: streams.writeError,
    });

  const bot = program.command("bot");
  bot
    .command("register")
    .argument("<name>")
    .requiredOption("--owner <discord-user-id>")
    .action(
      action("bot register", async (name: string, options: { owner: string }) =>
        service.registerBot({ name, ownerUserId: options.owner, token: await readToken() }),
      ),
    );
  bot
    .command("commands-register")
    .argument("<name>")
    .action(
      action("bot commands-register", async (name: string) => service.registerBotCommands(name)),
    );
  bot.command("list").action(action("bot list", async () => service.listBots()));

  const workspace = program.command("workspace");
  workspace
    .command("add")
    .argument("<name>")
    .requiredOption("--cwd <path>")
    .addOption(
      new Option("--sandbox <mode>")
        .choices(["read-only", "workspace-write", "danger-full-access"])
        .default("workspace-write"),
    )
    .addOption(
      new Option("--approval <policy>")
        .choices(["untrusted", "on-request", "never"])
        .default("on-request"),
    )
    .option("--root <path>", "additional runtime workspace root", collect, [])
    .option("--model <model>")
    .action(
      action(
        "workspace add",
        async (
          name: string,
          options: {
            cwd: string;
            sandbox: string;
            approval: string;
            root: string[];
            model?: string;
          },
        ) => {
          const profile: WorkspaceProfile = {
            name,
            cwd: options.cwd,
            sandbox: options.sandbox,
            approvalPolicy: options.approval,
            runtimeWorkspaceRoots: options.root,
            ...(options.model === undefined ? {} : { model: options.model }),
          };
          return await service.addWorkspace(profile);
        },
      ),
    );
  workspace.command("list").action(action("workspace list", async () => service.listWorkspaces()));

  program
    .command("provision")
    .argument("<bot>")
    .requiredOption("--owner <discord-user-id>")
    .requiredOption("--channel <discord-channel-id>", "allowed Discord channel", collect, [])
    .option("--workspace <name>")
    .option("--cwd <absolute-path>")
    .option("--name <agent-name>")
    .option("--mention")
    .action(
      action(
        "provision",
        async (
          botName: string,
          options: {
            channel: string[];
            cwd?: string;
            mention?: boolean;
            name?: string;
            owner: string;
            workspace?: string;
          },
        ) => {
          if (options.channel.length === 0) {
            throw new BridgeError("INVALID_ARGUMENT", "Provision requires at least one --channel.");
          }
          const existingSelected = options.workspace !== undefined;
          const cwdSelected = options.cwd !== undefined;
          if (existingSelected === cwdSelected) {
            throw new BridgeError(
              "INVALID_ARGUMENT",
              "Provision requires exactly one of --workspace or --cwd.",
            );
          }
          const selectedWorkspace =
            options.workspace !== undefined
              ? { kind: "existing" as const, name: options.workspace }
              : options.cwd !== undefined
                ? { cwd: options.cwd, kind: "cwd" as const }
                : undefined;
          if (selectedWorkspace === undefined) {
            throw new BridgeError("INVALID_ARGUMENT", "Provision workspace selection is missing.");
          }
          return await service.provisionAgent({
            botName,
            ownerUserId: options.owner,
            token: await readToken(),
            workspace: selectedWorkspace,
            channelIds: options.channel,
            requireMention: options.mention === true,
            ...(options.name === undefined ? {} : { name: options.name }),
          });
        },
      ),
    );

  program
    .command("create")
    .argument("<bot>")
    .requiredOption("--workspace <name>")
    .option("--name <agent-name>")
    .action(
      action("create", async (botName: string, options: { workspace: string; name?: string }) =>
        service.createAgent({
          botName,
          workspaceName: options.workspace,
          ...(options.name === undefined ? {} : { name: options.name }),
        }),
      ),
    );
  program
    .command("link")
    .argument("<bot>")
    .requiredOption("--thread <thread-id>")
    .requiredOption("--workspace <name>")
    .option("--name <agent-name>")
    .option("--start")
    .action(
      action(
        "link",
        async (
          botName: string,
          options: { thread: string; workspace: string; name?: string; start?: boolean },
        ) =>
          service.linkAgent({
            botName,
            threadId: options.thread,
            workspaceName: options.workspace,
            start: options.start === true,
            ...(options.name === undefined ? {} : { name: options.name }),
          }),
      ),
    );

  program
    .command("start")
    .argument("<target>")
    .action(action("start", (target: string) => service.start(target)));
  program
    .command("stop")
    .argument("<target>")
    .option("--force")
    .action(
      action("stop", (target: string, options: { force?: boolean }) =>
        service.stop(target, options.force === true),
      ),
    );
  program
    .command("restart")
    .argument("<target>")
    .action(action("restart", (target: string) => service.restart(target)));
  program
    .command("status")
    .argument("[target]")
    .action(action("status", (target?: string) => service.status(target)));

  const progress = program.command("progress");
  progress
    .command("reconcile")
    .argument("<target>")
    .requiredOption("--thread <discord-thread-id>")
    .action(
      action("progress reconcile", (target: string, options: { thread: string }) =>
        service.requestProgressReconciliation(target, options.thread),
      ),
    );

  const access = program.command("access");
  access
    .command("pair")
    .argument("<bot>")
    .argument("<code>")
    .action(
      action("access pair", (botName: string, code: string) =>
        service.approvePairing(botName, code),
      ),
    );
  access
    .command("allow")
    .argument("<bot>")
    .argument("<discord-user-id>")
    .action(
      action("access allow", (botName: string, userId: string) =>
        service.allowUser(botName, userId),
      ),
    );
  access
    .command("channel-add")
    .argument("<bot>")
    .argument("<channel-id>")
    .option("--mention")
    .action(
      action(
        "access channel-add",
        (botName: string, channelId: string, options: { mention?: boolean }) =>
          service.allowChannel(botName, channelId, options.mention === true),
      ),
    );
  access
    .command("show")
    .argument("<bot>")
    .action(action("access show", (botName: string) => service.getAccess(botName)));

  try {
    await program.parseAsync([...arguments_], { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError && !emitted) {
      exitCode = error.exitCode;
    } else if (!emitted) {
      exitCode = exitCodeFor(error);
      emit(envelopeError("cli", error));
    }
  }
  return exitCode;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write("Unable to initialize codex-discord.\n");
      process.exitCode = 7;
    },
  );
}
