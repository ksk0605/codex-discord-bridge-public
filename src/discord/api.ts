import { z } from "zod";
import { BridgeError } from "../domain/errors.js";
import { DiscordSnowflakeSchema } from "../domain/schemas.js";
import { CODEX_COMMAND } from "./commands.js";

export const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
export const CODEX_DISCORD_BRIDGE_PROJECT_URL = "https://github.com/ksk0605/codex-discord-bridge";
export const CODEX_DISCORD_BRIDGE_VERSION = "0.1.0";
export const DISCORD_API_USER_AGENT = `DiscordBot (${CODEX_DISCORD_BRIDGE_PROJECT_URL}, ${CODEX_DISCORD_BRIDGE_VERSION})`;
export const MAX_DISCORD_TOKEN_BYTES = 16 * 1024;
export const DEFAULT_DISCORD_REQUEST_TIMEOUT_MS = 10_000;
export const MAX_DISCORD_RESPONSE_BYTES = 1024 * 1024;

const MAX_CONFIGURED_TIMEOUT_MS = 60_000;
const MAX_CONFIGURED_RESPONSE_BYTES = 8 * 1024 * 1024;

const DiscordBotUserSchema = z
  .object({
    id: DiscordSnowflakeSchema,
    bot: z.literal(true),
  })
  .passthrough();

const DiscordApplicationSchema = z
  .object({
    id: DiscordSnowflakeSchema,
    bot: z
      .object({
        id: DiscordSnowflakeSchema,
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export interface DiscordApiOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export interface VerifiedBotIdentity {
  readonly applicationId: string;
  readonly botUserId: string;
}

export interface RegisteredApplicationCommand {
  readonly id: string;
  readonly name: string;
}

interface ResolvedDiscordApiOptions {
  readonly fetch: typeof fetch;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

interface DiscordRequest {
  readonly method: "GET" | "PUT";
  readonly path: string;
  readonly body?: string;
}

const GLOBAL_CODEX_COMMAND = [CODEX_COMMAND] as const;

const statusSubcommand = GLOBAL_CODEX_COMMAND[0].options[0];
const modelsSubcommand = GLOBAL_CODEX_COMMAND[0].options[1];
const modelSubcommand = GLOBAL_CODEX_COMMAND[0].options[2];
const reasoningSubcommand = GLOBAL_CODEX_COMMAND[0].options[3];
const newSubcommand = GLOBAL_CODEX_COMMAND[0].options[4];
const interruptSubcommand = GLOBAL_CODEX_COMMAND[0].options[5];
const spawnSubcommand = GLOBAL_CODEX_COMMAND[0].options[6];
const stopSubcommand = GLOBAL_CODEX_COMMAND[0].options[7];
const restartSubcommand = GLOBAL_CODEX_COMMAND[0].options[8];
const nameOption = modelSubcommand.options[0];
const effortOption = reasoningSubcommand.options[0];
const confirmOption = newSubcommand.options[0];
const botOption = spawnSubcommand.options[0];
const workspaceOption = spawnSubcommand.options[1];

const RegisteredCommandSchema = z
  .object({
    id: DiscordSnowflakeSchema,
    application_id: DiscordSnowflakeSchema,
    name: z.literal(GLOBAL_CODEX_COMMAND[0].name),
    description: z.literal(GLOBAL_CODEX_COMMAND[0].description),
    type: z.literal(GLOBAL_CODEX_COMMAND[0].type),
    integration_types: z.tuple([z.literal(0)]),
    contexts: z.tuple([z.literal(0), z.literal(1)]),
    options: z.tuple([
      z
        .object({
          type: z.literal(statusSubcommand.type),
          name: z.literal(statusSubcommand.name),
          description: z.literal(statusSubcommand.description),
          options: z.never().optional(),
        })
        .passthrough(),
      z
        .object({
          type: z.literal(modelsSubcommand.type),
          name: z.literal(modelsSubcommand.name),
          description: z.literal(modelsSubcommand.description),
          options: z.never().optional(),
        })
        .passthrough(),
      z
        .object({
          type: z.literal(modelSubcommand.type),
          name: z.literal(modelSubcommand.name),
          description: z.literal(modelSubcommand.description),
          options: z.tuple([
            z
              .object({
                type: z.literal(nameOption.type),
                name: z.literal(nameOption.name),
                description: z.literal(nameOption.description),
                required: z.literal(nameOption.required),
                min_length: z.literal(nameOption.min_length),
                max_length: z.literal(nameOption.max_length),
              })
              .passthrough(),
          ]),
        })
        .passthrough(),
      z
        .object({
          type: z.literal(reasoningSubcommand.type),
          name: z.literal(reasoningSubcommand.name),
          description: z.literal(reasoningSubcommand.description),
          options: z.tuple([
            z
              .object({
                type: z.literal(effortOption.type),
                name: z.literal(effortOption.name),
                description: z.literal(effortOption.description),
                required: z.literal(effortOption.required),
                min_length: z.literal(effortOption.min_length),
                max_length: z.literal(effortOption.max_length),
              })
              .passthrough(),
          ]),
        })
        .passthrough(),
      z
        .object({
          type: z.literal(newSubcommand.type),
          name: z.literal(newSubcommand.name),
          description: z.literal(newSubcommand.description),
          options: z.tuple([
            z
              .object({
                type: z.literal(confirmOption.type),
                name: z.literal(confirmOption.name),
                description: z.literal(confirmOption.description),
                required: z.literal(confirmOption.required).optional(),
              })
              .passthrough(),
          ]),
        })
        .passthrough(),
      z
        .object({
          type: z.literal(interruptSubcommand.type),
          name: z.literal(interruptSubcommand.name),
          description: z.literal(interruptSubcommand.description),
          options: z.never().optional(),
        })
        .passthrough(),
      z
        .object({
          type: z.literal(spawnSubcommand.type),
          name: z.literal(spawnSubcommand.name),
          description: z.literal(spawnSubcommand.description),
          options: z.tuple([
            z
              .object({
                type: z.literal(botOption.type),
                name: z.literal(botOption.name),
                description: z.literal(botOption.description),
                required: z.literal(botOption.required),
              })
              .passthrough(),
            z
              .object({
                type: z.literal(workspaceOption.type),
                name: z.literal(workspaceOption.name),
                description: z.literal(workspaceOption.description),
                required: z.literal(workspaceOption.required),
              })
              .passthrough(),
          ]),
        })
        .passthrough(),
      z
        .object({
          type: z.literal(stopSubcommand.type),
          name: z.literal(stopSubcommand.name),
          description: z.literal(stopSubcommand.description),
          options: z.never().optional(),
        })
        .passthrough(),
      z
        .object({
          type: z.literal(restartSubcommand.type),
          name: z.literal(restartSubcommand.name),
          description: z.literal(restartSubcommand.description),
          options: z.never().optional(),
        })
        .passthrough(),
    ]),
  })
  .passthrough();

const RegisteredCommandsSchema = z.array(RegisteredCommandSchema).length(1);

function invalidArgument(message: string, remediation: string): BridgeError {
  return new BridgeError("INVALID_ARGUMENT", message, remediation);
}

function configurationError(message: string, remediation: string): BridgeError {
  return new BridgeError("CONFIGURATION", message, remediation);
}

function validateToken(token: unknown): string {
  if (typeof token !== "string") {
    throw invalidArgument(
      "Invalid Discord bot token",
      `Supply a token between 1 and ${MAX_DISCORD_TOKEN_BYTES} visible ASCII bytes.`,
    );
  }
  const tokenBytes = Buffer.byteLength(token, "utf8");
  if (tokenBytes === 0 || tokenBytes > MAX_DISCORD_TOKEN_BYTES) {
    throw invalidArgument(
      "Invalid Discord bot token",
      `Supply a token between 1 and ${MAX_DISCORD_TOKEN_BYTES} visible ASCII bytes.`,
    );
  }

  for (let index = 0; index < token.length; index += 1) {
    const codeUnit = token.charCodeAt(index);
    if (codeUnit < 0x21 || codeUnit > 0x7e) {
      throw invalidArgument(
        "Invalid Discord bot token",
        "Supply a nonempty bot token containing visible ASCII characters only.",
      );
    }
  }
  return token;
}

function validateApplicationId(applicationId: unknown): string {
  const result = DiscordSnowflakeSchema.safeParse(applicationId);
  if (!result.success) {
    throw invalidArgument(
      "Invalid Discord application ID",
      "Supply the decimal application ID returned by Discord.",
    );
  }
  return result.data;
}

function validateConfiguredInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw configurationError(
      `Invalid Discord API ${label}`,
      `Set ${label} to a positive bounded integer and retry.`,
    );
  }
  return value;
}

function resolveOptions(options: DiscordApiOptions = {}): ResolvedDiscordApiOptions {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw configurationError(
      "Invalid Discord API configuration",
      "Configure the Discord API with an options object.",
    );
  }
  if ("apiBaseUrl" in options) {
    throw configurationError(
      "Discord API base URL cannot be configured",
      "Remove apiBaseUrl; authenticated requests always use Discord's official API origin.",
    );
  }

  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw configurationError(
      "Discord API fetch is unavailable",
      "Run the bridge on Node.js 22 or inject a compatible fetch implementation.",
    );
  }

  return {
    fetch: fetchImplementation,
    timeoutMs: validateConfiguredInteger(
      options.timeoutMs ?? DEFAULT_DISCORD_REQUEST_TIMEOUT_MS,
      "timeout",
      MAX_CONFIGURED_TIMEOUT_MS,
    ),
    maxResponseBytes: validateConfiguredInteger(
      options.maxResponseBytes ?? MAX_DISCORD_RESPONSE_BYTES,
      "response limit",
      MAX_CONFIGURED_RESPONSE_BYTES,
    ),
  };
}

function statusError(status: number): BridgeError {
  if (status === 401 || status === 403) {
    return new BridgeError(
      "UNAUTHORIZED",
      "Discord rejected the bot authorization",
      "Verify the bot token and application permissions, then retry.",
    );
  }
  if (status === 429) {
    return new BridgeError(
      "RUNTIME",
      "Discord rate-limited the request",
      "Wait before retrying the Discord operation.",
    );
  }
  if (status >= 500) {
    return new BridgeError(
      "RUNTIME",
      "Discord is temporarily unavailable",
      "Retry after Discord service recovers.",
    );
  }
  return configurationError(
    `Discord rejected the API request with status ${status}`,
    "Verify the Discord application configuration and retry.",
  );
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
  controller: AbortController,
): Promise<Buffer> {
  if (response.body === null) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        return Buffer.concat(chunks, totalBytes);
      }
      const chunk = Buffer.from(result.value);
      totalBytes += chunk.byteLength;
      if (totalBytes > maximumBytes) {
        controller.abort();
        await reader.cancel().catch(() => undefined);
        throw new BridgeError(
          "RUNTIME",
          "Discord response exceeded the safety limit",
          "Retry the operation; if it persists, verify Discord API compatibility.",
        );
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
}

async function requestJson(
  token: string,
  options: ResolvedDiscordApiOptions,
  request: DiscordRequest,
): Promise<unknown> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  timer.unref();

  const headers: Record<string, string> = {
    Authorization: `Bot ${token}`,
    "User-Agent": DISCORD_API_USER_AGENT,
  };
  if (request.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  let response: Response;
  try {
    response = await options.fetch(`${DISCORD_API_BASE_URL}${request.path}`, {
      method: request.method,
      headers,
      redirect: "error",
      signal: controller.signal,
      ...(request.body === undefined ? {} : { body: request.body }),
    });
  } catch {
    clearTimeout(timer);
    if (timedOut) {
      throw new BridgeError(
        "TIMEOUT",
        "Discord API request timed out",
        "Retry after checking network access to Discord.",
      );
    }
    throw new BridgeError(
      "RUNTIME",
      "Discord API request failed",
      "Check network access to Discord and retry.",
    );
  }

  try {
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw statusError(response.status);
    }

    let body: Buffer;
    try {
      body = await readBoundedBody(response, options.maxResponseBytes, controller);
    } catch (error) {
      if (timedOut) {
        throw new BridgeError(
          "TIMEOUT",
          "Discord API response timed out",
          "Retry after checking network access to Discord.",
        );
      }
      if (error instanceof BridgeError) {
        throw error;
      }
      throw new BridgeError(
        "RUNTIME",
        "Unable to read the Discord API response",
        "Retry the Discord operation.",
      );
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
      throw configurationError(
        "Discord returned a non-UTF-8 response",
        "Retry the operation; if it persists, verify Discord API compatibility.",
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw configurationError(
        "Discord returned malformed JSON",
        "Retry the operation; if it persists, verify Discord API compatibility.",
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

function parseDiscordResponse<T>(schema: z.ZodType<T>, value: unknown, responseLabel: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw configurationError(
      `Discord returned an invalid ${responseLabel}`,
      "Retry the operation; if it persists, verify Discord API compatibility.",
    );
  }
  return result.data;
}

export async function verifyBotToken(
  token: string,
  apiOptions: DiscordApiOptions = {},
): Promise<VerifiedBotIdentity> {
  const validatedToken = validateToken(token);
  const options = resolveOptions(apiOptions);

  const user = parseDiscordResponse(
    DiscordBotUserSchema,
    await requestJson(validatedToken, options, {
      method: "GET",
      path: "/users/@me",
    }),
    "current bot user",
  );
  const application = parseDiscordResponse(
    DiscordApplicationSchema,
    await requestJson(validatedToken, options, {
      method: "GET",
      path: "/oauth2/applications/@me",
    }),
    "current bot application",
  );

  if (application.bot !== undefined && application.bot.id !== user.id) {
    throw configurationError(
      "Discord application bot does not match the authorized bot user",
      "Use the bot token issued for this Discord application.",
    );
  }

  return {
    applicationId: application.id,
    botUserId: user.id,
  };
}

export async function registerApplicationCommands(
  applicationId: string,
  token: string,
  apiOptions: DiscordApiOptions = {},
): Promise<RegisteredApplicationCommand[]> {
  const validatedApplicationId = validateApplicationId(applicationId);
  const validatedToken = validateToken(token);
  const options = resolveOptions(apiOptions);
  const response = parseDiscordResponse(
    RegisteredCommandsSchema,
    await requestJson(validatedToken, options, {
      method: "PUT",
      path: `/applications/${validatedApplicationId}/commands`,
      body: JSON.stringify(GLOBAL_CODEX_COMMAND),
    }),
    "application command response",
  );

  const command = response[0];
  if (command === undefined || command.application_id !== validatedApplicationId) {
    throw configurationError(
      "Discord returned an unexpected application command",
      "Verify the Discord application ID and retry command registration.",
    );
  }

  return [{ id: command.id, name: command.name }];
}
