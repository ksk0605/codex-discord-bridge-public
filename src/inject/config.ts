import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { BridgeError } from "../domain/errors.js";
import { DiscordSnowflakeSchema } from "../domain/schemas.js";
import type { InjectConfig } from "./service.js";

// Inject is opt-in per agent: the socket only opens when <instance>/inject.json says so.

const InjectConfigFileSchema = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    logChannelId: DiscordSnowflakeSchema.optional(),
    announceChannelIds: z.array(DiscordSnowflakeSchema).max(20).optional(),
  })
  .strict();

export type InjectConfigFile = Omit<z.infer<typeof InjectConfigFileSchema>, "version">;

export function injectConfigPath(instanceDirectory: string): string {
  return join(instanceDirectory, "inject.json");
}

// Returns the file as written (enabled or not), or undefined when there is none.
export async function readInjectConfigFile(path: string): Promise<InjectConfigFile | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new BridgeError("CONFIGURATION", "Inject config is unreadable.", undefined, {
      cause: error,
    });
  }
  try {
    const { version: _version, ...config } = InjectConfigFileSchema.parse(JSON.parse(text));
    return config;
  } catch (error) {
    throw new BridgeError(
      "CONFIGURATION",
      `Inject config is invalid: ${path}`,
      "Rewrite it with `codex-discord inject-config`.",
      { cause: error },
    );
  }
}

export async function loadInjectConfig(path: string): Promise<InjectConfig | undefined> {
  const parsed = await readInjectConfigFile(path);
  if (parsed === undefined || !parsed.enabled) return undefined;
  return {
    ...(parsed.logChannelId === undefined ? {} : { logChannelId: parsed.logChannelId }),
    ...(parsed.announceChannelIds === undefined || parsed.announceChannelIds.length === 0
      ? {}
      : { announceChannelIds: [...new Set(parsed.announceChannelIds)] }),
  };
}

export async function writeInjectConfig(path: string, config: InjectConfigFile): Promise<void> {
  const checked = InjectConfigFileSchema.safeParse({ version: 1, ...config });
  if (!checked.success) {
    throw new BridgeError(
      "INVALID_ARGUMENT",
      "Inject config needs Discord channel IDs (17-20 digits), at most 20 announce channels.",
    );
  }
  const document = checked.data;
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}
