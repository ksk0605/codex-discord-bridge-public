import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveStatePaths } from "./config/paths.js";
import { BridgeError } from "./domain/errors.js";
import { IdentifierSchema } from "./domain/schemas.js";
import { parseRunnerArguments, RUNNER_RESTART_EXIT_CODE } from "./runner.js";

export interface SupervisorChildResult {
  readonly code: number;
  readonly signal: NodeJS.Signals | null;
}

export type SupervisorRunChild = (instanceId: string) => Promise<SupervisorChildResult>;

export interface SupervisorOptions {
  readonly instanceId: string;
  readonly runChild: SupervisorRunChild;
  readonly waitForCleanup?: (instanceId: string) => Promise<void>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly maxCrashRestarts?: number;
  readonly crashBackoffMs?: number;
  readonly maxCrashBackoffMs?: number;
}

const DEFAULT_MAX_CRASH_RESTARTS = 5;
const DEFAULT_CRASH_BACKOFF_MS = 250;
const DEFAULT_MAX_CRASH_BACKOFF_MS = 5_000;

function boundedInteger(value: number, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > 60_000) {
    throw new BridgeError("INVALID_ARGUMENT", `Invalid supervisor ${label}.`);
  }
  return value;
}

export async function superviseAgent(options: SupervisorOptions): Promise<number> {
  const parsedId = IdentifierSchema.safeParse(options.instanceId);
  if (!parsedId.success)
    throw new BridgeError("INVALID_ARGUMENT", "Invalid supervisor instance ID.");
  const maxCrashes = boundedInteger(
    options.maxCrashRestarts ?? DEFAULT_MAX_CRASH_RESTARTS,
    "crash restart limit",
    0,
  );
  const backoff = boundedInteger(
    options.crashBackoffMs ?? DEFAULT_CRASH_BACKOFF_MS,
    "crash backoff",
    1,
  );
  const maximumBackoff = boundedInteger(
    options.maxCrashBackoffMs ?? DEFAULT_MAX_CRASH_BACKOFF_MS,
    "maximum crash backoff",
    1,
  );
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let crashes = 0;

  while (true) {
    const result = await options.runChild(parsedId.data);
    if (result.code === 0) return 0;
    if (result.code === RUNNER_RESTART_EXIT_CODE) {
      await options.waitForCleanup?.(parsedId.data);
      crashes = 0;
      continue;
    }
    if (crashes >= maxCrashes) return result.code;
    await sleep(Math.min(maximumBackoff, backoff * 2 ** crashes));
    crashes += 1;
  }
}

export function createRunnerChild(
  runnerPath = fileURLToPath(new URL("./runner.js", import.meta.url)),
): SupervisorRunChild {
  return (instanceId) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [runnerPath, "--instance", instanceId], {
        shell: false,
        stdio: "inherit",
        env: process.env,
      });
      const forward = (signal: NodeJS.Signals) => {
        child.kill(signal);
      };
      const onInterrupt = () => forward("SIGINT");
      const onTerminate = () => forward("SIGTERM");
      process.on("SIGINT", onInterrupt);
      process.on("SIGTERM", onTerminate);
      const cleanup = () => {
        process.off("SIGINT", onInterrupt);
        process.off("SIGTERM", onTerminate);
      };
      child.once("error", (error) => {
        cleanup();
        reject(
          new BridgeError("RUNTIME", "Unable to start the agent runner.", undefined, {
            cause: error,
          }),
        );
      });
      child.once("close", (code, signal) => {
        cleanup();
        resolve({ code: code ?? 1, signal });
      });
    });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function waitForRunnerCleanup(instanceId: string): Promise<void> {
  const paths = resolveStatePaths(process.env.CODEX_DISCORD_STATE_ROOT);
  const directory = paths.instanceDirectory(instanceId);
  const lock = join(directory, "runner.lock");
  const heartbeat = join(directory, "heartbeat.json");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!(await pathExists(lock)) && !(await pathExists(heartbeat))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new BridgeError("TIMEOUT", "Runner did not clean up before restart.");
}

export async function runSupervisor(arguments_: readonly string[]): Promise<number> {
  const instanceId = parseRunnerArguments(arguments_);
  return await superviseAgent({
    instanceId,
    runChild: createRunnerChild(),
    waitForCleanup: waitForRunnerCleanup,
  });
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runSupervisor(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : "Supervisor failed."}\n`);
      process.exitCode = 7;
    },
  );
}
