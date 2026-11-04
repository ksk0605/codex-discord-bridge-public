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
  })
  .strict();

export type InjectConfigFile = Omit<z.infer<typeof InjectConfigFileSchema>, "version">;

export function injectConfigPath(instanceDirectory: string): string {
  return join(instanceDirectory, "inject.json");
}

export async function loadInjectConfig(path: string): Promise<InjectConfig | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new BridgeError("CONFIGURATION", "Inject config is unreadable.", undefined, {
      cause: error,
    });
  }
  let parsed: z.infer<typeof InjectConfigFileSchema>;
  try {
    parsed = InjectConfigFileSchema.parse(JSON.parse(text));
  } catch (error) {
    throw new BridgeError(
      "CONFIGURATION",
      `Inject config is invalid: ${path}`,
      "Rewrite it with `codex-discord inject-config`.",
      { cause: error },
    );
  }
  if (!parsed.enabled) return undefined;
  return parsed.logChannelId === undefined ? {} : { logChannelId: parsed.logChannelId };
}

export async function writeInjectConfig(path: string, config: InjectConfigFile): Promise<void> {
  const document = InjectConfigFileSchema.parse({ version: 1, ...config });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}
