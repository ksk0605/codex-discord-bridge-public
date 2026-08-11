import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { BridgeError } from "../domain/errors.js";
import { IdentifierSchema } from "../domain/schemas.js";

const STATE_DIRECTORY_MODE = 0o700;
const PathInputSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0"), "Path must not contain NUL bytes");
const StateDirectoryPathsSchema = z
  .object({
    root: PathInputSchema,
    instancesDirectory: PathInputSchema,
    inboxDirectory: PathInputSchema,
    logsDirectory: PathInputSchema,
  })
  .passthrough();

export interface StatePaths {
  readonly root: string;
  readonly registryPath: string;
  readonly instancesDirectory: string;
  readonly inboxDirectory: string;
  readonly logsDirectory: string;
  instanceDirectory(instanceId: string): string;
  instanceInboxDirectory(instanceId: string): string;
  instanceLogPath(instanceId: string): string;
  progressJournalPath(instanceId: string): string;
}

function parseInput<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BridgeError(
      "INVALID_ARGUMENT",
      `Invalid ${label}`,
      "Correct the supplied value and retry.",
      { cause: result.error },
    );
  }
  return result.data;
}

function validatedInstanceId(instanceId: string): string {
  return parseInput(IdentifierSchema, instanceId, "instance ID");
}

export function resolveStatePaths(rootOverride?: string): StatePaths {
  const rootInput =
    rootOverride === undefined
      ? join(homedir(), ".codex-discord-bridge")
      : parseInput(PathInputSchema, rootOverride, "state root");
  const root = resolve(rootInput);
  const instancesDirectory = join(root, "instances");
  const inboxDirectory = join(root, "inbox");
  const logsDirectory = join(root, "logs");

  return {
    root,
    registryPath: join(root, "registry.json"),
    instancesDirectory,
    inboxDirectory,
    logsDirectory,
    instanceDirectory: (instanceId) => join(instancesDirectory, validatedInstanceId(instanceId)),
    instanceInboxDirectory: (instanceId) => join(inboxDirectory, validatedInstanceId(instanceId)),
    instanceLogPath: (instanceId) => join(logsDirectory, `${validatedInstanceId(instanceId)}.log`),
    progressJournalPath: (instanceId) =>
      join(instancesDirectory, validatedInstanceId(instanceId), "progress-observations.json"),
  };
}

export async function ensureStateDirectories(paths: StatePaths): Promise<void> {
  const validated = parseInput(StateDirectoryPathsSchema, paths, "state paths");
  const directories = [
    validated.root,
    validated.instancesDirectory,
    validated.inboxDirectory,
    validated.logsDirectory,
  ];

  for (const directory of directories) {
    await mkdir(directory, { mode: STATE_DIRECTORY_MODE, recursive: true });
    await chmod(directory, STATE_DIRECTORY_MODE);
  }
}
