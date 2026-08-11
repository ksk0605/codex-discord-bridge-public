import { isAbsolute, normalize } from "node:path";
import { z } from "zod";
import { BridgeError } from "../domain/errors.js";
import { DiscordSnowflakeSchema } from "../domain/schemas.js";

export const DISCORD_MESSAGE_LIMIT = 2_000;
export const DEFAULT_ATTACHMENT_FILENAME_LIMIT = 120;
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
export const MAX_DISCORD_ATTACHMENTS = 10;
export const MAX_DISCORD_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TURN_BODY_CODE_UNITS = 200_000;
const MAX_FILENAME_CODE_UNITS = 255;
const MAX_CONTENT_TYPE_CODE_UNITS = 255;
const MAX_LOCAL_PATH_CODE_UNITS = 4_096;
const MAX_REDACTION_INPUT_CODE_UNITS = 1024 * 1024;
const MAX_REDACTION_OUTPUT_CODE_UNITS = 16 * 1024;

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

const LocalAttachmentFilenameSchema = z
  .string()
  .min(1)
  .max(MAX_FILENAME_CODE_UNITS)
  .refine(
    (value) =>
      !hasControlCharacters(value) &&
      !value.includes("/") &&
      !value.includes("\\") &&
      value !== "." &&
      value !== "..",
  );
const LocalAttachmentContentTypeSchema = z
  .string()
  .min(1)
  .max(MAX_CONTENT_TYPE_CODE_UNITS)
  .refine((value) => !hasControlCharacters(value));
const LocalAttachmentPathSchema = z
  .string()
  .min(1)
  .max(MAX_LOCAL_PATH_CODE_UNITS)
  .refine(
    (value) => isAbsolute(value) && !hasControlCharacters(value) && normalize(value) === value,
  );

export const LocalDiscordAttachmentSchema = z
  .object({
    id: DiscordSnowflakeSchema,
    filename: LocalAttachmentFilenameSchema,
    size: z.number().int().min(0).max(MAX_DISCORD_FILE_BYTES),
    contentType: LocalAttachmentContentTypeSchema.optional(),
    localPath: LocalAttachmentPathSchema,
  })
  .strict();
const LocalDiscordAttachmentsSchema = z
  .array(LocalDiscordAttachmentSchema)
  .max(MAX_DISCORD_ATTACHMENTS);

const DiscordTurnInputSchema = z
  .object({
    channelId: DiscordSnowflakeSchema,
    messageId: DiscordSnowflakeSchema,
    authorId: DiscordSnowflakeSchema,
    guildId: DiscordSnowflakeSchema.optional(),
    parentChannelId: DiscordSnowflakeSchema.optional(),
    attachments: LocalDiscordAttachmentsSchema.optional(),
    body: z.string().max(MAX_TURN_BODY_CODE_UNITS),
  })
  .strict();

export type DiscordTurnInput = z.infer<typeof DiscordTurnInputSchema>;
export type LocalDiscordAttachment = z.infer<typeof LocalDiscordAttachmentSchema>;

export interface DiscordChunkOptions {
  readonly limit?: number;
  readonly mode?: "length" | "newline";
}

export interface AttachmentFilenameOptions {
  readonly maxLength?: number;
}

export interface RedactionOptions {
  readonly maxOutputLength?: number;
}

function invalidArgument(message: string): BridgeError {
  return new BridgeError("INVALID_ARGUMENT", message, "Correct the value and retry.");
}

function truncateUtf16(value: string, maximum: number): string {
  if (value.length <= maximum) {
    return value;
  }
  let end = maximum;
  if (
    end > 0 &&
    /[\uD800-\uDBFF]/u.test(value.charAt(end - 1)) &&
    /[\uDC00-\uDFFF]/u.test(value.charAt(end))
  ) {
    end -= 1;
  }
  return value.slice(0, end);
}

export function formatDiscordTurnInput(input: DiscordTurnInput): string {
  const parsed = DiscordTurnInputSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidArgument("Invalid Discord turn source metadata or message body.");
  }
  const { attachments, body, ...metadata } = parsed.data;
  const sections = [
    "--- BEGIN UNTRUSTED DISCORD METADATA ---",
    JSON.stringify(metadata),
    "--- END UNTRUSTED DISCORD METADATA ---",
  ];
  if (attachments !== undefined && attachments.length > 0) {
    sections.push(
      "--- BEGIN UNTRUSTED DISCORD ATTACHMENTS ---",
      JSON.stringify(attachments),
      "--- END UNTRUSTED DISCORD ATTACHMENTS ---",
    );
  }
  sections.push("--- BEGIN UNTRUSTED DISCORD MESSAGE ---", body);
  return sections.join("\n");
}

export function parseLocalDiscordAttachments(input: unknown): readonly LocalDiscordAttachment[] {
  const parsed = LocalDiscordAttachmentsSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidArgument("Invalid local Discord attachment metadata.");
  }
  return Object.freeze(parsed.data.map((attachment) => Object.freeze(attachment)));
}

function safeChunkEnd(text: string, start: number, requestedEnd: number): number {
  let end = requestedEnd;
  if (
    end < text.length &&
    /[\uD800-\uDBFF]/u.test(text.charAt(end - 1)) &&
    /[\uDC00-\uDFFF]/u.test(text.charAt(end))
  ) {
    end -= 1;
  }
  if (end <= start) {
    throw invalidArgument("Discord chunk limit cannot contain the next Unicode character.");
  }
  return end;
}

function preferredBoundary(text: string, start: number, end: number): number {
  const paragraph = text.lastIndexOf("\n\n", end - 2);
  if (paragraph >= start) {
    return paragraph + 2;
  }
  const newline = text.lastIndexOf("\n", end - 1);
  return newline >= start ? newline + 1 : end;
}

export function chunkDiscordText(
  text: string,
  options: DiscordChunkOptions = {},
): readonly string[] {
  const limit = options.limit ?? DISCORD_MESSAGE_LIMIT;
  const mode = options.mode ?? "newline";
  if (
    typeof text !== "string" ||
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    limit > DISCORD_MESSAGE_LIMIT ||
    (mode !== "length" && mode !== "newline")
  ) {
    throw invalidArgument("Invalid Discord message chunk configuration.");
  }
  if (text.length === 0) {
    return Object.freeze([]);
  }

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const maximumEnd = safeChunkEnd(text, start, Math.min(start + limit, text.length));
    const end =
      mode === "newline" && maximumEnd < text.length
        ? preferredBoundary(text, start, maximumEnd)
        : maximumEnd;
    if (end <= start || end - start > limit) {
      throw invalidArgument("Discord message chunking did not make bounded progress.");
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return Object.freeze(chunks);
}

function configuredFilenameLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_ATTACHMENT_FILENAME_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 16 || limit > MAX_FILENAME_CODE_UNITS) {
    throw invalidArgument("Invalid attachment filename length limit.");
  }
  return limit;
}

export function sanitizeAttachmentFilename(
  input: string,
  options: AttachmentFilenameOptions = {},
): string {
  const maximum = configuredFilenameLimit(options.maxLength);
  if (typeof input !== "string" || input.length > 16 * 1024) {
    throw invalidArgument("Invalid attachment filename.");
  }
  const segment = input.normalize("NFKC").replaceAll("\\", "/").split("/").at(-1) ?? "";
  let safe = segment
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/[:*?"<>|]/gu, "_")
    .replace(/\s+/gu, " ")
    .replace(/^[.\s]+|[.\s]+$/gu, "");
  if (safe.length === 0 || safe === "." || safe === "..") {
    safe = "attachment";
  }
  if (safe.length <= maximum) {
    return safe;
  }

  const dot = safe.lastIndexOf(".");
  const extension = dot > 0 && safe.length - dot <= 17 ? safe.slice(dot) : "";
  const base = extension.length > 0 ? safe.slice(0, dot) : safe;
  const available = maximum - extension.length;
  const shortened = truncateUtf16(base, available).replace(/[.\s]+$/gu, "");
  const result = `${shortened.length > 0 ? shortened : "attachment"}${extension}`;
  return truncateUtf16(result, maximum);
}

export function validateAttachmentSize(size: number, maximumBytes: number): number {
  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes <= 0 ||
    maximumBytes > MAX_ATTACHMENT_BYTES ||
    size > maximumBytes
  ) {
    throw invalidArgument("Invalid or oversized Discord attachment.");
  }
  return size;
}

function messageText(value: unknown): string {
  try {
    return typeof value === "string" ? value : String(value);
  } catch {
    return "[UNAVAILABLE MESSAGE]";
  }
}

export function redactDiscordSecrets(value: unknown, options: RedactionOptions = {}): string {
  const maximum = options.maxOutputLength ?? 4_000;
  if (!Number.isSafeInteger(maximum) || maximum < 16 || maximum > MAX_REDACTION_OUTPUT_CODE_UNITS) {
    throw invalidArgument("Invalid redacted output length limit.");
  }
  const input = messageText(value);
  if (input === "[UNAVAILABLE MESSAGE]") {
    return input;
  }
  if (input.length > MAX_REDACTION_INPUT_CODE_UNITS) {
    return "[REDACTED OVERSIZED MESSAGE]";
  }

  let redacted = input
    .replace(
      /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/gu,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(/https?:\/\/(?:discord(?:app)?\.com)\/api\/webhooks\/[^\s)>\]]+/giu, "[REDACTED URL]")
    .replace(/https?:\/\/[^\s/:@]+:[^\s/@]+@[^\s)>\]]+/giu, "[REDACTED URL]")
    .replace(/mfa\.[A-Za-z0-9_-]{20,}/gu, "[REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{20,}\b/gu, "[REDACTED]")
    .replace(/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}\b/gu, "[REDACTED]")
    .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}\b/gu, "[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/gu, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]")
    .replace(/(authorization\s*[:=]\s*)(?:(?:bot|bearer)\s+)?[^\s,;]+/giu, "$1[REDACTED]")
    .replace(
      /((?:bot_?token|discord_?token|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      "$1[REDACTED]",
    );
  if (redacted.length > maximum) {
    const suffix = "...[TRUNCATED]";
    redacted = `${truncateUtf16(redacted, maximum - suffix.length)}${suffix}`;
  }
  return redacted;
}
