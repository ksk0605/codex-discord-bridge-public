import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureStateDirectories, resolveStatePaths, type StatePaths } from "./config/paths.js";
import { BridgeError } from "./domain/errors.js";
import {
  type AgentBinding,
  type BotCredentialMetadata,
  IdentifierSchema,
  type WorkspaceProfile,
} from "./domain/schemas.js";

export const RUNNER_RESTART_EXIT_CODE = 75;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const MAX_HEARTBEAT_INTERVAL_MS = 60_000;

export interface RunnerRegistryRecord {
  readonly binding: AgentBinding;
  readonly bot: BotCredentialMetadata;
  readonly workspace: WorkspaceProfile;
}

export interface RunnerRegistryPort {
  load(instanceId: string): Promise<RunnerRegistryRecord>;
  markState(state: "starting" | "running" | "stopped" | "failed"): Promise<unknown>;
}

export interface RunnerKeychainPort {
  get(account: string): Promise<string>;
}

export interface RunnerComponent {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface RunnerComponentContext extends RunnerRegistryRecord {
  readonly token: string;
  readonly paths: StatePaths;
  requestShutdown(restart?: boolean): void;
}

export type RunnerComponentFactory = (
  context: RunnerComponentContext,
) => Promise<RunnerComponent> | RunnerComponent;

export interface AgentRunnerOptions {
  readonly instanceId: string;
  readonly paths: StatePaths;
  readonly registry: RunnerRegistryPort;
  readonly keychain: RunnerKeychainPort;
  readonly createComponent: RunnerComponentFactory;
  readonly heartbeatIntervalMs?: number;
  readonly now?: () => Date;
}

interface HeartbeatDocument {
  readonly version: 1;
  readonly instanceId: string;
  readonly pid: number;
  readonly state: "running";
  readonly updatedAt: string;
}

function heartbeatInterval(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_HEARTBEAT_INTERVAL_MS) {
    throw new BridgeError("INVALID_ARGUMENT", "Invalid runner heartbeat interval.");
  }
  return value;
}

function timestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new BridgeError("RUNTIME", "Runner clock returned an invalid timestamp.");
  }
  return value.toISOString();
}

export class AgentRunner {
  readonly instanceId: string;
  readonly lockPath: string;
  readonly heartbeatPath: string;

  private readonly options: AgentRunnerOptions;
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private component: RunnerComponent | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private lockOwned = false;
  private started = false;
  private shutdownPromise: Promise<number> | undefined;
  private requestedRestart = false;
  private exitResolver: ((restart: boolean) => void) | undefined;
  private readonly exitRequested = new Promise<boolean>((resolve) => {
    this.exitResolver = resolve;
  });

  constructor(options: AgentRunnerOptions) {
    const parsedId = IdentifierSchema.safeParse(options.instanceId);
    if (!parsedId.success) throw new BridgeError("INVALID_ARGUMENT", "Invalid runner instance ID.");
    this.options = options;
    this.instanceId = parsedId.data;
    this.intervalMs = heartbeatInterval(
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    );
    this.now = options.now ?? (() => new Date());
    this.lockPath = join(options.paths.instanceDirectory(this.instanceId), "runner.lock");
    this.heartbeatPath = join(options.paths.instanceDirectory(this.instanceId), "heartbeat.json");
  }

  async start(): Promise<void> {
    if (this.started || this.lockOwned) {
      throw new BridgeError("CONFLICT", "Runner is already started.");
    }
    await ensureStateDirectories(this.options.paths);
    await mkdir(this.options.paths.instanceDirectory(this.instanceId), {
      mode: 0o700,
      recursive: true,
    });
    await mkdir(this.options.paths.instanceInboxDirectory(this.instanceId), {
      mode: 0o700,
      recursive: true,
    });
    await this.acquireLock();

    try {
      const record = await this.options.registry.load(this.instanceId);
      if (record.binding.id !== this.instanceId) {
        throw new BridgeError("CONFIGURATION", "Runner loaded a different binding.");
      }
      await this.options.registry.markState("starting");
      const token = await this.options.keychain.get(record.bot.keychainAccount);
      const component = await this.options.createComponent({
        ...record,
        token,
        paths: this.options.paths,
        requestShutdown: (restart = false) => this.requestShutdown(restart),
      });
      this.component = component;
      await component.start();
      this.started = true;
      await this.writeHeartbeat();
      this.heartbeatTimer = setInterval(() => {
        void this.writeHeartbeat().catch(() => undefined);
      }, this.intervalMs);
      this.heartbeatTimer.unref();
      await this.options.registry.markState("running");
    } catch (error) {
      await this.component?.stop().catch(() => undefined);
      this.component = undefined;
      await this.options.registry.markState("failed").catch(() => undefined);
      await this.cleanupRuntimeFiles();
      throw error;
    }
  }

  requestShutdown(restart = false): void {
    this.requestedRestart ||= restart;
    this.exitResolver?.(this.requestedRestart);
    this.exitResolver = undefined;
  }

  waitForShutdownRequest(): Promise<boolean> {
    return this.exitRequested;
  }

  shutdown(options: { restart?: boolean } = {}): Promise<number> {
    this.requestedRestart ||= options.restart === true;
    if (this.shutdownPromise !== undefined) return this.shutdownPromise;
    this.shutdownPromise = this.performShutdown();
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<number> {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    let failure: unknown;
    try {
      await this.component?.stop();
    } catch (error) {
      failure = error;
    } finally {
      this.component = undefined;
      this.started = false;
      await this.cleanupRuntimeFiles();
      await this.options.registry.markState("stopped").catch((error) => {
        failure ??= error;
      });
    }
    if (failure !== undefined) {
      throw new BridgeError("RUNTIME", "Runner shutdown failed.", undefined, { cause: failure });
    }
    return this.requestedRestart ? RUNNER_RESTART_EXIT_CODE : 0;
  }

  private async acquireLock(): Promise<void> {
    try {
      await this.createLock();
      return;
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? error.code : null;
      if (code !== "EEXIST") {
        throw new BridgeError("RUNTIME", "Unable to acquire runner lock.", undefined, {
          cause: error,
        });
      }
    }

    if (!(await this.removeDeadRunnerLock())) {
      throw new BridgeError("CONFLICT", `Runner lock is already held for ${this.instanceId}.`);
    }
    try {
      await this.createLock();
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? error.code : null;
      if (code === "EEXIST") {
        throw new BridgeError("CONFLICT", `Runner lock is already held for ${this.instanceId}.`);
      }
      throw new BridgeError("RUNTIME", "Unable to acquire runner lock.", undefined, {
        cause: error,
      });
    }
  }

  private async createLock(): Promise<void> {
    const handle = await open(this.lockPath, "wx", 0o600);
    try {
      await handle.writeFile(
        `${JSON.stringify({ version: 1, instanceId: this.instanceId, pid: process.pid })}\n`,
        "utf8",
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.lockOwned = true;
  }

  private async removeDeadRunnerLock(): Promise<boolean> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.lockPath, "utf8"));
    } catch {
      return false;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("version" in parsed) ||
      parsed.version !== 1 ||
      !("instanceId" in parsed) ||
      parsed.instanceId !== this.instanceId ||
      !("pid" in parsed) ||
      !Number.isSafeInteger(parsed.pid) ||
      (parsed.pid as number) <= 0
    ) {
      return false;
    }
    try {
      process.kill(parsed.pid as number, 0);
      return false;
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (code !== "ESRCH") return false;
    }
    await rm(this.lockPath, { force: true });
    return true;
  }

  private async writeHeartbeat(): Promise<void> {
    const heartbeat: HeartbeatDocument = {
      version: 1,
      instanceId: this.instanceId,
      pid: process.pid,
      state: "running",
      updatedAt: timestamp(this.now),
    };
    const temporaryPath = `${this.heartbeatPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(heartbeat)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.heartbeatPath);
  }

  private async cleanupRuntimeFiles(): Promise<void> {
    await rm(this.heartbeatPath, { force: true });
    if (this.lockOwned) {
      await rm(this.lockPath, { force: true });
      this.lockOwned = false;
    }
  }
}

export function parseRunnerArguments(arguments_: readonly string[]): string {
  if (arguments_.length !== 2 || arguments_[0] !== "--instance") {
    throw new BridgeError(
      "INVALID_ARGUMENT",
      "Runner requires exactly --instance <uuid> and accepts no secrets.",
    );
  }
  const parsed = IdentifierSchema.safeParse(arguments_[1]);
  if (!parsed.success) throw new BridgeError("INVALID_ARGUMENT", "Invalid runner instance ID.");
  return parsed.data;
}

export async function runAgentRunner(runner: AgentRunner): Promise<number> {
  await runner.start();
  let signalResolved = false;
  let resolveSignal!: () => void;
  const signal = new Promise<void>((resolve) => {
    resolveSignal = resolve;
  });
  const onSignal = () => {
    if (signalResolved) return;
    signalResolved = true;
    resolveSignal();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const requested = runner.waitForShutdownRequest();
    const winner = await Promise.race([
      requested.then((restart) => ({ restart })),
      signal.then(() => ({ restart: false })),
    ]);
    return await runner.shutdown(winner);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

export function defaultRunnerStatePaths(): StatePaths {
  return resolveStatePaths(process.env.CODEX_DISCORD_STATE_ROOT);
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  import("./runtime/production-agent.js")
    .then(async ({ createProductionRunner }) => {
      const instanceId = parseRunnerArguments(process.argv.slice(2));
      process.exitCode = await runAgentRunner(
        createProductionRunner(instanceId, defaultRunnerStatePaths()),
      );
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : "Runner failed."}\n`);
      process.exitCode = 7;
    });
}
