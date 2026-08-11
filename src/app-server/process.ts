import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { BridgeError } from "../domain/errors.js";
import {
  AppServerClient,
  type AppServerClientOptions,
  type AppServerDebugEvent,
} from "./client.js";

export type CodexAppServerProcessState = "stopped" | "starting" | "running" | "stopping";

export interface CodexAppServerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface CodexAppServerLogEvent {
  event: "stderr" | "exit";
  bytes?: number;
  truncated?: boolean;
  code?: number | null;
  signal?: NodeJS.Signals | null;
}

interface ManagedChildProcess extends EventEmitter {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
}

interface SpawnOptions {
  shell: false;
  stdio: ["pipe", "pipe", "pipe"];
  env: NodeJS.ProcessEnv;
}

export type AppServerSpawn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ManagedChildProcess;

export interface CodexAppServerProcessOptions {
  codexPath?: string;
  sourceEnv?: NodeJS.ProcessEnv;
  spawnProcess?: AppServerSpawn;
  startTimeoutMs?: number;
  startupStabilityMs?: number;
  stopGraceMs?: number;
  killWaitMs?: number;
  logger?: (event: CodexAppServerLogEvent) => void;
  stderrLogLimitPerInterval?: number;
  stderrIntervalMs?: number;
  stderrMetadataByteLimit?: number;
  additionalEnvNames?: readonly string[];
  clientOptions?: Omit<AppServerClientOptions, "input" | "output">;
  debugLogger?: (event: AppServerDebugEvent) => void;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: BridgeError) => void;
}

const ALLOWED_ENVIRONMENT_VARIABLES = [
  "HOME",
  "PATH",
  "CODEX_HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "CODEX_CA_CERTIFICATE",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;
const DEFAULT_START_TIMEOUT_MS = 5_000;
const DEFAULT_STARTUP_STABILITY_MS = 50;
const DEFAULT_STOP_GRACE_MS = 2_000;
const DEFAULT_KILL_WAIT_MS = 1_000;
const DEFAULT_STDERR_LOG_LIMIT = 20;
const DEFAULT_STDERR_INTERVAL_MS = 1_000;
const DEFAULT_STDERR_METADATA_BYTE_LIMIT = 64 * 1024;
const MAX_TIMER_MS = 2_147_483_647;
const MAX_LIMIT = 1_000_000;
const MAX_STDERR_METADATA_BYTES = 64 * 1024 * 1024;

function safeIntegerOption(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new BridgeError("INVALID_ARGUMENT", `Invalid Codex App Server option ${name}.`);
  }
  return value;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: BridgeError) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  void promise.catch(() => undefined);
  return { promise, reject, resolve };
}

function configurationError(message: string, cause?: unknown): BridgeError {
  return new BridgeError(
    "CONFIGURATION",
    message,
    "Verify the Codex CLI installation and run npm run protocol:check.",
    cause === undefined ? undefined : { cause },
  );
}

function runtimeError(message: string): BridgeError {
  return new BridgeError(
    "RUNTIME",
    message,
    "Restart the Codex App Server process and retry the operation.",
  );
}

function additionalEnvironmentNames(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new BridgeError("INVALID_ARGUMENT", "Invalid additional Codex environment names.");
  }
  const names = new Set<string>();
  for (const name of value) {
    if (
      typeof name !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      ["__proto__", "constructor", "prototype"].includes(name) ||
      /(?:DISCORD|BRIDGE)/i.test(name)
    ) {
      throw new BridgeError("INVALID_ARGUMENT", "Invalid additional Codex environment name.");
    }
    names.add(name);
  }
  return [...names];
}

function allowedEnvironment(
  source: NodeJS.ProcessEnv,
  additionalNames: readonly string[],
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [...ALLOWED_ENVIRONMENT_VARIABLES, ...additionalNames]) {
    const value = source[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}

function processTimeoutError(): BridgeError {
  return new BridgeError(
    "TIMEOUT",
    "Codex App Server did not close after termination signals.",
    "Terminate the retained Codex process, then retry after its stdio closes.",
  );
}

async function waitWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return await new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(undefined);
      }
    }, timeoutMs);
    void promise.then((value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }
    });
  });
}

export class CodexAppServerProcess {
  private readonly codexPath: string;
  private readonly sourceEnv: NodeJS.ProcessEnv;
  private readonly spawnProcess: AppServerSpawn;
  private readonly startTimeoutMs: number;
  private readonly startupStabilityMs: number;
  private readonly stopGraceMs: number;
  private readonly killWaitMs: number;
  private readonly logger: ((event: CodexAppServerLogEvent) => void) | undefined;
  private readonly stderrLogLimitPerInterval: number;
  private readonly stderrIntervalMs: number;
  private readonly stderrMetadataByteLimit: number;
  private readonly additionalEnvNames: readonly string[];
  private readonly clientOptions: Omit<AppServerClientOptions, "input" | "output">;

  private child: ManagedChildProcess | undefined;
  private currentClient: AppServerClient | undefined;
  private exitDeferred = createDeferred<CodexAppServerExit>();
  private exitResult: CodexAppServerExit | undefined;
  private startFailure: BridgeError | undefined;
  private provisionalExit: CodexAppServerExit | undefined;
  private startReject: ((error: BridgeError) => void) | undefined;
  private startTimer: NodeJS.Timeout | undefined;
  private startupStabilityTimer: NodeJS.Timeout | undefined;
  private stopPromise: Promise<CodexAppServerExit | undefined> | undefined;
  private stderrWindowStartedAt = 0;
  private stderrLogsInWindow = 0;

  state: CodexAppServerProcessState = "stopped";

  constructor(options: CodexAppServerProcessOptions = {}) {
    this.codexPath = options.codexPath ?? "codex";
    this.sourceEnv = options.sourceEnv ?? process.env;
    this.spawnProcess = options.spawnProcess ?? (spawn as unknown as AppServerSpawn);
    this.startTimeoutMs = safeIntegerOption(
      "startTimeoutMs",
      options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
      1,
      MAX_TIMER_MS,
    );
    this.startupStabilityMs = safeIntegerOption(
      "startupStabilityMs",
      options.startupStabilityMs ?? DEFAULT_STARTUP_STABILITY_MS,
      1,
      MAX_TIMER_MS,
    );
    this.stopGraceMs = safeIntegerOption(
      "stopGraceMs",
      options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
      0,
      MAX_TIMER_MS,
    );
    this.killWaitMs = safeIntegerOption(
      "killWaitMs",
      options.killWaitMs ?? DEFAULT_KILL_WAIT_MS,
      0,
      MAX_TIMER_MS,
    );
    this.logger = options.logger;
    this.stderrLogLimitPerInterval = safeIntegerOption(
      "stderrLogLimitPerInterval",
      options.stderrLogLimitPerInterval ?? DEFAULT_STDERR_LOG_LIMIT,
      0,
      MAX_LIMIT,
    );
    this.stderrIntervalMs = safeIntegerOption(
      "stderrIntervalMs",
      options.stderrIntervalMs ?? DEFAULT_STDERR_INTERVAL_MS,
      1,
      MAX_TIMER_MS,
    );
    this.stderrMetadataByteLimit = safeIntegerOption(
      "stderrMetadataByteLimit",
      options.stderrMetadataByteLimit ?? DEFAULT_STDERR_METADATA_BYTE_LIMIT,
      1,
      MAX_STDERR_METADATA_BYTES,
    );
    this.additionalEnvNames = additionalEnvironmentNames(options.additionalEnvNames);
    this.clientOptions = {
      ...options.clientOptions,
      ...(options.debugLogger === undefined ? {} : { debugLogger: options.debugLogger }),
    };
    if (
      this.codexPath.length === 0 ||
      this.codexPath.includes("\0") ||
      this.startupStabilityMs >= this.startTimeoutMs
    ) {
      throw new BridgeError("INVALID_ARGUMENT", "Invalid Codex App Server process options.");
    }
  }

  get client(): AppServerClient | undefined {
    return this.currentClient;
  }

  get process(): ManagedChildProcess | undefined {
    return this.child;
  }

  async start(): Promise<AppServerClient> {
    if (this.state !== "stopped" || this.child !== undefined) {
      throw new BridgeError("CONFLICT", "Codex App Server is already active or starting.");
    }

    if (this.exitResult !== undefined || this.startFailure !== undefined) {
      this.exitDeferred = createDeferred<CodexAppServerExit>();
      this.exitResult = undefined;
      this.startFailure = undefined;
    }
    this.provisionalExit = undefined;
    this.state = "starting";

    let child: ManagedChildProcess;
    try {
      child = this.spawnProcess(this.codexPath, ["app-server", "--listen", "stdio://"], {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: allowedEnvironment(this.sourceEnv, this.additionalEnvNames),
      });
    } catch (error) {
      this.state = "stopped";
      const failure = configurationError("Unable to spawn the Codex App Server.", error);
      this.startFailure = failure;
      this.exitDeferred.reject(failure);
      throw failure;
    }

    this.child = child;
    const onStderr = (chunk: Buffer | string) => this.handleStderr(chunk);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.child !== child) {
        return;
      }
      this.provisionalExit = { code, signal };
      this.currentClient?.transportExited(runtimeError("Codex App Server process exited."));
      if (this.state === "starting") {
        this.state = "stopping";
        this.startReject?.(configurationError("Codex App Server exited before startup completed."));
      }
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.state === "starting") {
        this.startReject?.(configurationError("Codex App Server exited before startup completed."));
      }
      this.finalizeClose(child, { code, signal });
    };
    const onError = (error: Error) => {
      if (this.state === "starting") {
        this.startReject?.(configurationError("Unable to start the Codex App Server.", error));
        void this.cleanupFailedStart(child);
      }
    };
    child.stderr?.on("data", onStderr);
    child.once("exit", onExit);
    child.once("close", onClose);
    child.once("error", onError);

    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      const failure = configurationError("Codex App Server did not expose piped stdio.");
      await this.cleanupFailedStart(child);
      throw failure;
    }

    try {
      this.currentClient = new AppServerClient({
        ...this.clientOptions,
        input: child.stdout,
        output: child.stdin,
      });
    } catch (error) {
      const failure = configurationError("Unable to configure the Codex App Server client.", error);
      await this.cleanupFailedStart(child);
      throw failure;
    }

    return await new Promise<AppServerClient>((resolve, reject) => {
      let settled = false;
      const rejectStart = (error: BridgeError) => {
        if (settled) {
          return;
        }
        settled = true;
        this.clearStartWait();
        reject(error);
      };
      this.startReject = rejectStart;

      child.once("spawn", () => {
        if (settled || this.child !== child || this.state !== "starting") {
          return;
        }
        this.startupStabilityTimer = setTimeout(() => {
          if (settled || this.child !== child || this.state !== "starting") {
            return;
          }
          settled = true;
          this.clearStartWait();
          this.state = "running";
          resolve(this.currentClient as AppServerClient);
        }, this.startupStabilityMs);
      });
      this.startTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        rejectStart(configurationError("Codex App Server startup timed out."));
        void this.cleanupFailedStart(child);
      }, this.startTimeoutMs);
    });
  }

  stop(): Promise<CodexAppServerExit | undefined> {
    if (this.stopPromise !== undefined) {
      return this.stopPromise;
    }
    if (this.child === undefined) {
      return Promise.resolve(this.exitResult);
    }
    const child = this.child;
    const stopping = this.performStop(child);
    const wrapped = stopping.finally(() => {
      if (this.stopPromise === wrapped) {
        this.stopPromise = undefined;
      }
    });
    this.stopPromise = wrapped;
    return wrapped;
  }

  async restart(): Promise<AppServerClient> {
    await this.stop();
    return await this.start();
  }

  waitForExit(): Promise<CodexAppServerExit> {
    if (this.startFailure !== undefined) {
      return Promise.reject(this.startFailure);
    }
    return this.exitResult === undefined
      ? this.exitDeferred.promise
      : Promise.resolve(this.exitResult);
  }

  private async performStop(child: ManagedChildProcess): Promise<CodexAppServerExit> {
    this.state = "stopping";
    this.startReject?.(configurationError("Codex App Server startup was stopped."));
    this.currentClient?.close(runtimeError("Codex App Server process is stopping."));
    return await this.terminateChild(child);
  }

  private async cleanupFailedStart(child: ManagedChildProcess): Promise<void> {
    this.state = "stopping";
    this.currentClient?.close(runtimeError("Codex App Server startup failed."));
    try {
      await this.terminateChild(child);
    } catch {
      // The original startup/configuration error remains primary; close may arrive later.
    }
  }

  private async terminateChild(child: ManagedChildProcess): Promise<CodexAppServerExit> {
    if (this.child === child) {
      this.signalChild(child, "SIGTERM");
    }
    const gracefulExit = await waitWithin(this.exitDeferred.promise, this.stopGraceMs);
    if (gracefulExit !== undefined) {
      return gracefulExit;
    }
    if (this.child === child) {
      this.signalChild(child, "SIGKILL");
    }
    const killedExit = await waitWithin(this.exitDeferred.promise, this.killWaitMs);
    if (killedExit !== undefined) {
      return killedExit;
    }
    throw processTimeoutError();
  }

  private handleStderr(chunk: Buffer | string): void {
    const now = Date.now();
    if (now - this.stderrWindowStartedAt >= this.stderrIntervalMs) {
      this.stderrWindowStartedAt = now;
      this.stderrLogsInWindow = 0;
    }
    if (this.stderrLogsInWindow >= this.stderrLogLimitPerInterval) {
      return;
    }
    this.stderrLogsInWindow += 1;
    const bytes = Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk);
    this.safeLog({
      event: "stderr",
      bytes: Math.min(bytes, this.stderrMetadataByteLimit),
      truncated: bytes > this.stderrMetadataByteLimit,
    });
  }

  private signalChild(child: ManagedChildProcess, signal: NodeJS.Signals): boolean {
    try {
      return child.kill(signal);
    } catch {
      return false;
    }
  }

  private finalizeClose(child: ManagedChildProcess, exit: CodexAppServerExit): void {
    if (this.child !== child) {
      return;
    }
    const finalExit =
      exit.code === null && exit.signal === null && this.provisionalExit !== undefined
        ? this.provisionalExit
        : exit;
    this.clearStartWait();
    child.removeAllListeners("spawn");
    child.removeAllListeners("exit");
    child.removeAllListeners("close");
    child.removeAllListeners("error");
    child.stderr?.removeAllListeners("data");
    this.currentClient?.transportExited(runtimeError("Codex App Server process exited."));
    this.currentClient = undefined;
    this.child = undefined;
    this.provisionalExit = undefined;
    this.state = "stopped";
    this.recordExit(finalExit);
    this.safeLog({ event: "exit", code: finalExit.code, signal: finalExit.signal });
  }

  private recordExit(exit: CodexAppServerExit): void {
    if (this.exitResult !== undefined) {
      return;
    }
    this.exitResult = Object.freeze({ ...exit });
    this.startFailure = undefined;
    this.exitDeferred.resolve(this.exitResult);
  }

  private clearStartWait(): void {
    if (this.startTimer !== undefined) {
      clearTimeout(this.startTimer);
      this.startTimer = undefined;
    }
    if (this.startupStabilityTimer !== undefined) {
      clearTimeout(this.startupStabilityTimer);
      this.startupStabilityTimer = undefined;
    }
    this.startReject = undefined;
  }

  private safeLog(event: CodexAppServerLogEvent): void {
    try {
      this.logger?.(event);
    } catch {
      // Logging must not affect process lifecycle.
    }
  }
}
