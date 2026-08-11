import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BridgeError } from "../domain/errors.js";
import { IdentifierSchema } from "../domain/schemas.js";

export interface TmuxCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type TmuxCommandRunner = (
  command: string,
  arguments_: readonly string[],
) => Promise<TmuxCommandResult>;

export interface TmuxControllerOptions {
  readonly executable?: string;
  readonly nodePath?: string;
  readonly supervisorPath: string;
  readonly run?: TmuxCommandRunner;
  readonly stopTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface TmuxStopOptions {
  readonly force?: boolean;
}

const SAFE_SESSION = /^[A-Za-z0-9_.-]+$/u;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const MAX_PROCESS_OUTPUT = 64 * 1024;

function boundedPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 60_000) {
    throw new BridgeError("INVALID_ARGUMENT", `Invalid tmux ${label}.`);
  }
  return value;
}

function sessionName(value: string): string {
  if (typeof value !== "string" || value.length > 128 || !SAFE_SESSION.test(value)) {
    throw new BridgeError("INVALID_ARGUMENT", "Invalid tmux session name.");
  }
  return value;
}

function executablePath(value: string, label: string): string {
  if (value.length === 0 || value.includes("\0")) {
    throw new BridgeError("INVALID_ARGUMENT", `Invalid ${label}.`);
  }
  return value;
}

const defaultRun: TmuxCommandRunner = (command, arguments_) =>
  new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...arguments_], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(
        new BridgeError("CONFIGURATION", "Unable to start tmux.", "Install tmux and retry.", {
          cause: error,
        }),
      );
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const capture = (target: Buffer[], current: number, chunk: Buffer | string): number => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, MAX_PROCESS_OUTPUT - current);
      if (remaining > 0) target.push(bytes.subarray(0, remaining));
      return current + bytes.length;
    };
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdoutBytes = capture(stdout, stdoutBytes, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrBytes = capture(stderr, stderrBytes, chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(
        new BridgeError("CONFIGURATION", "Unable to execute tmux.", "Install tmux and retry.", {
          cause: error,
        }),
      );
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });

export class TmuxController {
  private readonly executable: string;
  private readonly nodePath: string;
  private readonly supervisorPath: string;
  private readonly run: TmuxCommandRunner;
  private readonly stopTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(options: TmuxControllerOptions) {
    this.executable = executablePath(options.executable ?? "tmux", "tmux executable");
    this.nodePath = executablePath(options.nodePath ?? process.execPath, "Node executable");
    this.supervisorPath = executablePath(options.supervisorPath, "supervisor path");
    this.run = options.run ?? defaultRun;
    this.stopTimeoutMs = boundedPositiveInteger(
      options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
      "stop timeout",
    );
    this.pollIntervalMs = boundedPositiveInteger(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "poll interval",
    );
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async hasSession(session: string): Promise<boolean> {
    const name = sessionName(session);
    const result = await this.run(this.executable, ["has-session", "-t", name]);
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    throw new BridgeError("RUNTIME", `tmux has-session failed with code ${result.code}.`);
  }

  async start(instanceId: string, session: string): Promise<void> {
    const parsedId = IdentifierSchema.safeParse(instanceId);
    if (!parsedId.success) throw new BridgeError("INVALID_ARGUMENT", "Invalid instance ID.");
    const name = sessionName(session);
    if (await this.hasSession(name)) {
      throw new BridgeError("CONFLICT", `tmux session already exists: ${name}`);
    }
    const result = await this.run(this.executable, [
      "new-session",
      "-d",
      "-s",
      name,
      this.nodePath,
      this.supervisorPath,
      "--instance",
      parsedId.data,
    ]);
    if (result.code !== 0) {
      throw new BridgeError("RUNTIME", `Unable to start tmux session ${name}.`);
    }
  }

  async stop(session: string, options: TmuxStopOptions = {}): Promise<void> {
    const name = sessionName(session);
    if (!(await this.hasSession(name))) return;
    if (options.force === true) {
      const killed = await this.run(this.executable, ["kill-session", "-t", name]);
      if (killed.code !== 0 || (await this.hasSession(name))) {
        throw new BridgeError("RUNTIME", `Unable to force-stop tmux session ${name}.`);
      }
      return;
    }

    const signaled = await this.run(this.executable, ["send-keys", "-t", name, "C-c"]);
    if (signaled.code !== 0) {
      throw new BridgeError("RUNTIME", `Unable to signal tmux session ${name}.`);
    }
    const attempts = Math.max(1, Math.ceil(this.stopTimeoutMs / this.pollIntervalMs));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (!(await this.hasSession(name))) return;
      await this.sleep(this.pollIntervalMs);
    }
    throw new BridgeError(
      "TIMEOUT",
      `tmux session did not stop: ${name}`,
      "Retry with the explicit --force option after inspecting the runner.",
    );
  }
}

export const DEFAULT_SUPERVISOR_PATH = fileURLToPath(new URL("../supervisor.js", import.meta.url));
