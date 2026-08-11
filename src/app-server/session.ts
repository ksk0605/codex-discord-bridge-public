import { isAbsolute } from "node:path";
import { z } from "zod";
import { BridgeError } from "../domain/errors.js";
import {
  DiscordSnowflakeSchema,
  IdentifierSchema,
  ThreadIdSchema,
  type WorkspaceProfile,
} from "../domain/schemas.js";
import {
  type AuthorizedOutboundFile,
  authorizedOutboundFilesShareIdentity,
  type NormalizedWorkspace,
  type OutboundFileValidationContext,
  prepareOutboundFileValidation,
  validateOutboundFile,
  type WorkspaceNormalizer,
} from "../manager/workspaces.js";
import {
  createTurnProgressEvent,
  type ProgressActivityStatus,
  type TurnProgressEvent,
} from "../runtime/turn-progress.js";
import { type AppServerClient, appServerRequestDelivery } from "./client.js";
import {
  type ClientRequestMethod,
  type ClientRequestParams,
  type ClientRequestResult,
  knownAgentMessagePhase,
  type ServerNotificationMethod,
  type ServerNotificationParams,
} from "./protocol.js";
import type { ThreadCreationJournal } from "./thread-creation-journal.js";

const DEFAULT_LIST_PAGE_SIZE = 100;
const DEFAULT_MAX_LIST_PAGES = 100;
const DEFAULT_MAX_LIST_ITEMS = 10_000;
const MAX_MODEL_LIST_PAGE_SIZE = 100;
const MAX_MODEL_LIST_PAGES = 100;
const MAX_MODEL_LIST_ITEMS = 10_000;
const DEFAULT_MAX_TURN_INPUT_CHARACTERS = 100_000;
const MAX_CONFIGURED_LIMIT = 1_000_000;
// Bound both retained UTF-16 strings and their serialized UTF-8 form; cwd/cursors need larger caps.
const MAX_ID_CODE_UNITS = 512;
const MAX_ID_UTF8_BYTES = 512;
const MAX_CWD_CODE_UNITS = 16 * 1024;
const MAX_CWD_UTF8_BYTES = 16 * 1024;
const MAX_NAME_CODE_UNITS = 1024;
const MAX_NAME_UTF8_BYTES = 1024;
const MAX_MODEL_CODE_UNITS = 256;
const MAX_MODEL_UTF8_BYTES = 512;
const MAX_MODEL_DISPLAY_NAME_CODE_UNITS = 512;
const MAX_MODEL_DISPLAY_NAME_UTF8_BYTES = 1024;
const MAX_REASONING_EFFORT_CODE_UNITS = 64;
const MAX_REASONING_EFFORT_UTF8_BYTES = 128;
const MAX_REASONING_EFFORTS_PER_MODEL = 64;
const MAX_CURSOR_CODE_UNITS = 8 * 1024;
const MAX_CURSOR_UTF8_BYTES = 8 * 1024;
const MAX_DISCORD_ID_CODE_UNITS = 32;
const MAX_DISCORD_ID_UTF8_BYTES = 32;
const MAX_DISCORD_MESSAGE_CODE_UNITS = 2_000;
export const DEFAULT_DISCORD_FILE_MARKER_LIMITS = Object.freeze({
  attachments: 10,
  lineBytes: 16 * 1024,
  markerLines: 20,
  pathBytes: 16 * 1024,
  textBytes: 256 * 1024,
  uniquePaths: 20,
});
const SESSION_REMEDIATION = "Restart the Codex App Server process and retry the operation.";
const INPUT_REMEDIATION = "Correct the supplied thread, turn, message, or Discord source ID.";

function boundedString(maxCodeUnits: number, maxUtf8Bytes: number) {
  return z
    .string()
    .max(maxCodeUnits)
    .refine((value) => Buffer.byteLength(value, "utf8") <= maxUtf8Bytes);
}

const TurnIdSchema = boundedString(MAX_ID_CODE_UNITS, MAX_ID_UTF8_BYTES)
  .min(1)
  .refine((value) => !hasControlCharacters(value), "Invalid turn ID");
const AbsolutePathSchema = boundedString(MAX_CWD_CODE_UNITS, MAX_CWD_UTF8_BYTES)
  .min(1)
  .refine((value) => isAbsolute(value) && !hasControlCharacters(value));
const ThreadNameSchema = boundedString(MAX_NAME_CODE_UNITS, MAX_NAME_UTF8_BYTES);
const PaginationCursorSchema = boundedString(MAX_CURSOR_CODE_UNITS, MAX_CURSOR_UTF8_BYTES).min(1);
const ModelPaginationCursorSchema = PaginationCursorSchema.refine(
  (value) => !hasControlCharacters(value),
);
const CatalogIdSchema = boundedString(MAX_MODEL_CODE_UNITS, MAX_MODEL_UTF8_BYTES)
  .min(1)
  .refine((value) => !hasControlCharacters(value) && value !== "default");
const CatalogRequestModelSchema = boundedString(MAX_MODEL_CODE_UNITS, MAX_MODEL_UTF8_BYTES)
  .min(1)
  .refine((value) => !hasControlCharacters(value));
const CatalogDisplayNameSchema = boundedString(
  MAX_MODEL_DISPLAY_NAME_CODE_UNITS,
  MAX_MODEL_DISPLAY_NAME_UTF8_BYTES,
)
  .min(1)
  .refine((value) => !hasControlCharacters(value));
const CatalogReasoningEffortSchema = boundedString(
  MAX_REASONING_EFFORT_CODE_UNITS,
  MAX_REASONING_EFFORT_UTF8_BYTES,
)
  .min(1)
  .refine((value) => !hasControlCharacters(value) && value !== "default");
const CatalogReasoningEffortsSchema = z
  .array(
    z.object({
      reasoningEffort: CatalogReasoningEffortSchema,
      description: z.string(),
    }),
  )
  .min(1)
  .max(MAX_REASONING_EFFORTS_PER_MODEL)
  .superRefine((efforts, context) => {
    const seen = new Set<string>();
    for (const [index, effort] of efforts.entries()) {
      if (seen.has(effort.reasoningEffort)) {
        context.addIssue({
          code: "custom",
          message: "Duplicate reasoning effort",
          path: [index, "reasoningEffort"],
        });
      }
      seen.add(effort.reasoningEffort);
    }
  });
const CatalogModelWireSchema = z.object({
  id: CatalogIdSchema,
  model: CatalogRequestModelSchema,
  displayName: CatalogDisplayNameSchema,
  description: z.string(),
  hidden: z.boolean(),
  isDefault: z.boolean(),
  defaultReasoningEffort: CatalogReasoningEffortSchema,
  supportedReasoningEfforts: CatalogReasoningEffortsSchema,
});
const ModelListPageSchema = z.object({
  data: z.array(CatalogModelWireSchema),
  nextCursor: ModelPaginationCursorSchema.nullable().optional(),
});
const CodexTurnSettingsSchema = z
  .object({
    model: CatalogRequestModelSchema,
    effort: CatalogReasoningEffortSchema,
  })
  .strict();
const DiscordSourceIdSchema = DiscordSnowflakeSchema.pipe(
  boundedString(MAX_DISCORD_ID_CODE_UNITS, MAX_DISCORD_ID_UTF8_BYTES),
);
const ThreadIdentityResponseSchema = z
  .object({ thread: z.object({ id: ThreadIdSchema }).passthrough() })
  .passthrough();
const ThreadSummarySchema = z
  .object({
    id: ThreadIdSchema,
    cwd: AbsolutePathSchema,
    name: ThreadNameSchema.nullable().optional(),
    updatedAt: z.number().int().optional(),
  })
  .passthrough();
const ThreadListResponseSchema = z
  .object({
    data: z.array(ThreadSummarySchema),
    nextCursor: PaginationCursorSchema.nullable().optional(),
  })
  .passthrough();
const ThreadReadResponseSchema = z.object({ thread: ThreadSummarySchema }).passthrough();
const TurnStartResponseSchema = z
  .object({ turn: z.object({ id: TurnIdSchema }).passthrough() })
  .passthrough();
const EmptyResponseSchema = z.object({}).passthrough();
const DiscordTurnSourceSchema = z
  .object({
    messageId: DiscordSourceIdSchema,
    channelId: DiscordSourceIdSchema,
    authorId: DiscordSourceIdSchema,
    guildId: DiscordSourceIdSchema.optional(),
    parentChannelId: DiscordSourceIdSchema.optional(),
    interactionId: DiscordSourceIdSchema.optional(),
  })
  .strict();

export const DiscordSendFileArgumentsSchema = z
  .object({
    path: z.string().min(1),
    message: z.string().max(MAX_DISCORD_MESSAGE_CODE_UNITS).optional(),
  })
  .strict();

const DiscordFileMarkerSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("app-server"),
      role: z.enum(["assistant", "reasoning", "tool"]),
      final: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("discord"),
      role: z.literal("user"),
      final: z.boolean(),
    })
    .strict(),
]);

const dynamicToolProperties = Object.freeze({
  path: Object.freeze({ type: "string" as const }),
  message: Object.freeze({ type: "string" as const, maxLength: MAX_DISCORD_MESSAGE_CODE_UNITS }),
});
export const DISCORD_SEND_FILE_INPUT_SCHEMA = Object.freeze({
  type: "object" as const,
  additionalProperties: false,
  required: Object.freeze(["path"] as const),
  properties: dynamicToolProperties,
});

export const DISCORD_SEND_FILE_DYNAMIC_TOOL = Object.freeze({
  type: "function" as const,
  name: "discord_send_file",
  description:
    "Attach an existing local file to the Discord message that started the current turn.",
  inputSchema: DISCORD_SEND_FILE_INPUT_SCHEMA,
});

export const DISCORD_FILE_FALLBACK_INSTRUCTIONS = [
  "--- BEGIN CODEX DISCORD BRIDGE FILE ATTACHMENT PROTOCOL ---",
  "Use discord_send_file to attach an existing local file when available.",
  "When the tool is unavailable, include only a standalone final response line exactly in this form:",
  "[[discord_file:/absolute/path]]",
  "The file must already exist under the approved workspace or instance inbox.",
  "Never use this marker for registry, logs, instance runtime data, or any other bridge state.",
  "Do not emit the marker in reasoning, tool output, intermediate messages, prose, or code fences.",
  "--- END CODEX DISCORD BRIDGE FILE ATTACHMENT PROTOCOL ---",
].join("\n");

export const THREAD_MATERIALIZATION_ITEMS = Object.freeze([
  Object.freeze({
    type: "message" as const,
    role: "assistant" as const,
    content: Object.freeze([
      Object.freeze({
        type: "output_text" as const,
        text: "Codex Discord Bridge session initialized.",
      }),
    ]),
  }),
]);

export const PERSISTED_INTERACTIVE_THREAD_SOURCE_KINDS = Object.freeze([
  "cli",
  "vscode",
  "exec",
  "appServer",
  "unknown",
] as const);

export type SessionAppServerClient = Pick<AppServerClient, "request">;
export type DiscordTurnSource = z.infer<typeof DiscordTurnSourceSchema>;
export type DiscordFileMarkerSource = z.infer<typeof DiscordFileMarkerSourceSchema>;
export type DiscordSendFileArguments = z.infer<typeof DiscordSendFileArgumentsSchema>;

export interface CodexSessionServiceOptions {
  readonly client: SessionAppServerClient;
  readonly workspaceNormalizer: WorkspaceNormalizer;
  readonly threadCreationJournal: ThreadCreationJournal;
  readonly now?: () => Date;
  readonly listPageSize?: number;
  readonly maxListPages?: number;
  readonly maxListItems?: number;
  readonly maxTurnInputCharacters?: number;
}

export interface ThreadSummary {
  readonly id: string;
  readonly cwd: string;
  readonly name?: string;
  readonly updatedAt?: number;
}

export interface CodexModelCatalogEntry {
  readonly id: string;
  readonly model: string;
  readonly displayName: string;
  readonly hidden: boolean;
  readonly isDefault: boolean;
  readonly defaultReasoningEffort: string;
  readonly supportedReasoningEfforts: readonly string[];
}

export interface CodexTurnSettings {
  readonly model: string;
  readonly effort: string;
}

export interface DiscordFileMarkerContext extends OutboundFileValidationContext {
  readonly source: DiscordFileMarkerSource;
  readonly maxAttachments?: number;
  readonly maxFinalAssistantTextBytes?: number;
  readonly maxMarkerLineBytes?: number;
  readonly maxMarkerLines?: number;
  readonly maxMarkerPathBytes?: number;
  readonly maxUniqueRawMarkerPaths?: number;
}

/** Caller must close file after the Discord upload completes or fails. */
export interface AuthorizedDiscordSendFileArguments {
  readonly file: AuthorizedOutboundFile;
  readonly message?: string;
}

export type CodexSessionEvent =
  | { readonly method: "turn/started"; readonly threadId: string; readonly turnId: string }
  | { readonly method: "turn/completed"; readonly threadId: string; readonly turnId: string }
  | {
      readonly method: "item/started" | "item/completed";
      readonly threadId: string;
      readonly turnId: string;
      readonly itemId: string;
      readonly kind: string;
      readonly phase?: "commentary" | "final_answer";
      readonly text?: string;
      readonly files?: readonly AuthorizedOutboundFile[];
      readonly progress?: TurnProgressEvent;
    }
  | {
      readonly method: "item/agentMessage/delta";
      readonly threadId: string;
      readonly turnId: string;
      readonly itemId: string;
      readonly delta: string;
    }
  | {
      readonly method: "turn/plan/updated" | "item/reasoning/summaryTextDelta";
      readonly threadId: string;
      readonly turnId: string;
      readonly itemId?: string;
      readonly progress: TurnProgressEvent;
    }
  | {
      readonly method: "warning";
      readonly threadId?: string | null;
      readonly progress: TurnProgressEvent;
    };

export function projectCodexSessionEvent<Method extends ServerNotificationMethod>(
  method: Method,
  params: ServerNotificationParams<Method>,
): CodexSessionEvent | undefined {
  const envelope = params as Record<string, unknown>;
  if (method === "turn/started" || method === "turn/completed") {
    const turn = envelope.turn as { id: string };
    return {
      method,
      threadId: envelope.threadId as string,
      turnId: turn.id,
    };
  }
  if (method === "item/started" || method === "item/completed") {
    const item = envelope.item as Record<string, unknown> & { id: string; type: string };
    const phase = knownAgentMessagePhase(item);
    const progress = projectItemActivity(method, item);
    return {
      method,
      threadId: envelope.threadId as string,
      turnId: envelope.turnId as string,
      itemId: item.id,
      kind: item.type,
      ...(phase === undefined ? {} : { phase }),
      ...(method === "item/completed" && typeof item.text === "string" ? { text: item.text } : {}),
      ...(progress === undefined ? {} : { progress }),
    };
  }
  if (method === "item/agentMessage/delta") {
    return {
      method,
      threadId: envelope.threadId as string,
      turnId: envelope.turnId as string,
      itemId: envelope.itemId as string,
      delta: envelope.delta as string,
    };
  }
  if (method === "turn/plan/updated") {
    const steps = (envelope.plan as Array<{ status: string; step: string }>).map((item) => ({
      status: item.status as "pending" | "inProgress" | "completed",
      step: sanitizedProgressText(item.step, "[plan step]"),
    }));
    return {
      method,
      threadId: envelope.threadId as string,
      turnId: envelope.turnId as string,
      progress: createTurnProgressEvent({ type: "plan", steps }),
    };
  }
  if (method === "item/reasoning/summaryTextDelta") {
    const text = sanitizedOptionalProgressText(envelope.delta);
    if (text === undefined) return undefined;
    return {
      method,
      threadId: envelope.threadId as string,
      turnId: envelope.turnId as string,
      itemId: envelope.itemId as string,
      progress: createTurnProgressEvent({ type: "reasoning", text }),
    };
  }
  if (method === "warning") {
    const message = sanitizedOptionalProgressText(envelope.message);
    if (message === undefined) return undefined;
    const threadId = envelope.threadId;
    return {
      method,
      ...(typeof threadId === "string" || threadId === null ? { threadId } : {}),
      progress: createTurnProgressEvent({ type: "warning", message }),
    };
  }
  return undefined;
}

export class ThreadCreationConflictError extends BridgeError {
  override readonly name = "ThreadCreationConflictError";

  constructor(
    readonly operationId: string,
    readonly threadId?: string,
    message = "Codex thread creation was delivered but could not be confirmed safely.",
  ) {
    super("CONFLICT", message, "Reconcile the pending thread creation; do not retry thread/start.");
  }
}

function invalidArgument(message: string): BridgeError {
  return new BridgeError("INVALID_ARGUMENT", message, INPUT_REMEDIATION);
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function sanitizedOptionalProgressText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let sanitized = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const unsafe =
      (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      (code >= 0x7f && code <= 0x9f);
    sanitized += unsafe ? " " : value[index];
  }
  return sanitized.trim().length === 0 ? undefined : sanitized;
}

function sanitizedProgressText(value: unknown, fallback: string): string {
  return sanitizedOptionalProgressText(value) ?? fallback;
}

function activityStatus(
  method: "item/started" | "item/completed",
  item: Record<string, unknown>,
): ProgressActivityStatus {
  if (method === "item/started") return "inProgress";
  if (item.status === "failed" || item.status === "declined") return "failed";
  return "completed";
}

function projectItemActivity(
  method: "item/started" | "item/completed",
  item: Record<string, unknown> & { type: string },
): TurnProgressEvent | undefined {
  const status = activityStatus(method, item);
  switch (item.type) {
    case "commandExecution":
      return createTurnProgressEvent({
        type: "activity",
        activity: {
          kind: "command",
          executable: safeExecutableLabel(item.command),
        },
        status,
      });
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes
        .map((change) =>
          typeof change === "object" && change !== null
            ? sanitizedOptionalProgressText((change as { path?: unknown }).path)
            : undefined,
        )
        .filter((path): path is string => path !== undefined);
      return createTurnProgressEvent({
        type: "activity",
        activity: { kind: "file", paths },
        status,
      });
    }
    case "mcpToolCall":
      return createTurnProgressEvent({
        type: "activity",
        activity: {
          kind: "tool",
          name: sanitizedProgressText(item.tool, "[tool]"),
          provider: sanitizedProgressText(item.server, "[server]"),
        },
        status,
      });
    case "dynamicToolCall": {
      const provider = sanitizedOptionalProgressText(item.namespace);
      return createTurnProgressEvent({
        type: "activity",
        activity: {
          kind: "tool",
          name: sanitizedProgressText(item.tool, "[tool]"),
          ...(provider === undefined ? {} : { provider }),
        },
        status,
      });
    }
    case "collabAgentToolCall":
      return createTurnProgressEvent({
        type: "activity",
        activity: {
          kind: "collaboration",
          operation: sanitizedProgressText(item.tool, "[collaboration]"),
        },
        status,
      });
    case "subAgentActivity":
      return createTurnProgressEvent({
        type: "activity",
        activity: {
          kind: "collaboration",
          operation: sanitizedProgressText(item.kind, "[subagent activity]"),
        },
        status,
      });
    case "webSearch":
      return createTurnProgressEvent({
        type: "activity",
        activity: {
          kind: "web",
          query: sanitizedProgressText(item.query, "[web search]"),
        },
        status,
      });
    default:
      return undefined;
  }
}

function safeExecutableLabel(value: unknown): string {
  if (typeof value !== "string") return "[command]";
  const command = value.trimStart();
  const token = command.slice(
    0,
    command.search(/\s/u) < 0 ? command.length : command.search(/\s/u),
  );
  if (token.length === 0 || token.includes("=")) return "[command]";
  const normalized = token.replaceAll("\\", "/");
  const executable = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (!/^[A-Za-z0-9._+@-]+$/u.test(executable)) return "[command]";
  return sanitizedProgressText(executable, "[command]");
}

function runtimeError(message: string, cause?: unknown): BridgeError {
  return new BridgeError(
    "RUNTIME",
    message,
    SESSION_REMEDIATION,
    cause === undefined ? undefined : { cause: new Error("Codex App Server operation failed.") },
  );
}

function parseExternal<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw invalidArgument(message);
  }
  return parsed.data;
}

function parseResult<T>(schema: z.ZodType<T>, value: unknown, operation: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw runtimeError(`Codex App Server returned an invalid ${operation} result.`);
  }
  return parsed.data;
}

function configuredLimit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_CONFIGURED_LIMIT) {
    throw invalidArgument(`${name} must be a positive safe integer.`);
  }
  return value;
}

function normalizedThreadConfiguration(workspace: NormalizedWorkspace): Record<string, unknown> {
  return {
    cwd: workspace.cwd,
    runtimeWorkspaceRoots: [...workspace.runtimeWorkspaceRoots],
    approvalPolicy: workspace.approvalPolicy,
    ...(workspace.permissions === undefined ? {} : { permissions: workspace.permissions }),
    ...(workspace.sandbox === undefined ? {} : { sandbox: workspace.sandbox }),
    ...(workspace.model === undefined ? {} : { model: workspace.model }),
    ...(workspace.serviceTier === undefined ? {} : { serviceTier: workspace.serviceTier }),
    ...(workspace.developerInstructions === undefined
      ? {}
      : { developerInstructions: workspace.developerInstructions }),
  };
}

function composeFileInstructions(profileInstructions: string | undefined): string {
  return profileInstructions === undefined
    ? DISCORD_FILE_FALLBACK_INSTRUCTIONS
    : `${profileInstructions}\n\n${DISCORD_FILE_FALLBACK_INSTRUCTIONS}`;
}

function toThreadSummary(value: z.infer<typeof ThreadSummarySchema>): ThreadSummary {
  return {
    id: value.id,
    cwd: value.cwd,
    ...(value.name === undefined || value.name === null ? {} : { name: value.name }),
    ...(value.updatedAt === undefined ? {} : { updatedAt: value.updatedAt }),
  };
}

function rawDataCount(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || !("data" in value)) {
    return undefined;
  }
  return Array.isArray(value.data) ? value.data.length : undefined;
}

export function parseDiscordSendFileArguments(input: unknown): DiscordSendFileArguments {
  return parseExternal(
    DiscordSendFileArgumentsSchema,
    input,
    "Invalid discord_send_file arguments.",
  );
}

export async function validateDiscordSendFileArguments(
  input: unknown,
  context: OutboundFileValidationContext,
): Promise<AuthorizedDiscordSendFileArguments> {
  const parsed = parseDiscordSendFileArguments(input);
  const file = await validateOutboundFile(parsed.path, context);
  return {
    file,
    ...(parsed.message === undefined ? {} : { message: parsed.message }),
  };
}

interface LogicalLine {
  readonly text: string;
  readonly separator: string;
}

function logicalLines(text: string): LogicalLine[] {
  const lines: LogicalLine[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\n") {
      continue;
    }
    const hasCarriageReturn = index > start && text[index - 1] === "\r";
    lines.push({
      text: text.slice(start, hasCarriageReturn ? index - 1 : index),
      separator: hasCarriageReturn ? "\r\n" : "\n",
    });
    start = index + 1;
  }
  if (start < text.length || text.length === 0 || !text.endsWith("\n")) {
    lines.push({ text: text.slice(start), separator: "" });
  }
  return lines;
}

function fenceOpening(line: string): { character: "`" | "~"; length: number } | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (match?.[1] === undefined) {
    return undefined;
  }
  return { character: match[1][0] as "`" | "~", length: match[1].length };
}

function closesFence(line: string, fence: { character: "`" | "~"; length: number }): boolean {
  const escaped = fence.character === "`" ? "`" : "~";
  return new RegExp(`^ {0,3}${escaped}{${String(fence.length)},} *$`).test(line);
}

function markerLimit(label: string, value: number | undefined, fallback: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_CONFIGURED_LIMIT) {
    throw invalidArgument(`${label} must be a positive safe integer.`);
  }
  return limit;
}

async function closeMarkerFilesAfterFailure(
  files: ReadonlySet<AuthorizedOutboundFile>,
  primary: unknown,
): Promise<never> {
  const failure =
    primary instanceof BridgeError
      ? primary
      : runtimeError("Discord file marker authorization failed.", primary);
  const outcomes = await Promise.allSettled([...files].map((file) => file.close()));
  if (outcomes.some((outcome) => outcome.status === "rejected")) {
    throw new BridgeError(failure.code, failure.message, failure.remediation, {
      cause: new AggregateError(
        [new Error("Marker authorization failed."), new Error("Attachment cleanup failed.")],
        "Marker authorization and attachment cleanup both failed.",
      ),
    });
  }
  throw failure;
}

/** Returned files remain open and are owned by the caller until each upload is finished. */
export async function parseDiscordFileMarkers(
  text: string,
  context: DiscordFileMarkerContext,
): Promise<{ visibleText: string; files: AuthorizedOutboundFile[] }> {
  if (typeof text !== "string") {
    throw invalidArgument("Discord file marker input must be text.");
  }
  const source = parseExternal(
    DiscordFileMarkerSourceSchema,
    context.source,
    "Invalid Discord file marker source.",
  );
  if (source.kind !== "app-server" || source.role !== "assistant" || !source.final) {
    return { visibleText: text, files: [] };
  }

  const limits = {
    attachments: markerLimit(
      "maxAttachments",
      context.maxAttachments,
      DEFAULT_DISCORD_FILE_MARKER_LIMITS.attachments,
    ),
    lineBytes: markerLimit(
      "maxMarkerLineBytes",
      context.maxMarkerLineBytes,
      DEFAULT_DISCORD_FILE_MARKER_LIMITS.lineBytes,
    ),
    markerLines: markerLimit(
      "maxMarkerLines",
      context.maxMarkerLines,
      DEFAULT_DISCORD_FILE_MARKER_LIMITS.markerLines,
    ),
    pathBytes: markerLimit(
      "maxMarkerPathBytes",
      context.maxMarkerPathBytes,
      DEFAULT_DISCORD_FILE_MARKER_LIMITS.pathBytes,
    ),
    textBytes: markerLimit(
      "maxFinalAssistantTextBytes",
      context.maxFinalAssistantTextBytes,
      DEFAULT_DISCORD_FILE_MARKER_LIMITS.textBytes,
    ),
    uniquePaths: markerLimit(
      "maxUniqueRawMarkerPaths",
      context.maxUniqueRawMarkerPaths,
      DEFAULT_DISCORD_FILE_MARKER_LIMITS.uniquePaths,
    ),
  };
  if (Buffer.byteLength(text, "utf8") > limits.textBytes) {
    throw invalidArgument("Final assistant text exceeded the Discord file marker byte limit.");
  }

  const lines = logicalLines(text);
  const markers = new Map<number, string>();
  const rawCandidates: string[] = [];
  const seenRawCandidates = new Set<string>();
  let markerLines = 0;
  let fence: { character: "`" | "~"; length: number } | undefined;
  for (const [index, line] of lines.entries()) {
    if (fence !== undefined) {
      if (closesFence(line.text, fence)) {
        fence = undefined;
      }
      continue;
    }
    const opening = fenceOpening(line.text);
    if (opening !== undefined) {
      fence = opening;
      continue;
    }
    const marker = /^\[\[discord_file:(\/.*)\]\]$/.exec(line.text);
    if (marker?.[1] !== undefined) {
      if (Buffer.byteLength(line.text, "utf8") > limits.lineBytes) {
        throw invalidArgument("A Discord file marker line exceeded the byte limit.");
      }
      markerLines += 1;
      if (markerLines > limits.markerLines) {
        throw invalidArgument("Final assistant text contained too many Discord file markers.");
      }
      const path = marker[1];
      if (Buffer.byteLength(path, "utf8") > limits.pathBytes) {
        throw invalidArgument("A Discord file marker path exceeded the byte limit.");
      }
      markers.set(index, path);
      if (!seenRawCandidates.has(path)) {
        seenRawCandidates.add(path);
        rawCandidates.push(path);
        if (rawCandidates.length > limits.uniquePaths) {
          throw invalidArgument("Final assistant text contained too many unique file paths.");
        }
      }
    }
  }

  if (rawCandidates.length === 0) {
    return { visibleText: text, files: [] };
  }

  const prepared = await prepareOutboundFileValidation(context);
  const files: AuthorizedOutboundFile[] = [];
  const ownedFiles = new Set<AuthorizedOutboundFile>();
  try {
    for (const path of rawCandidates) {
      const candidate = await prepared.authorize(path);
      ownedFiles.add(candidate);
      const duplicate = files.some(
        (file) =>
          file.canonicalPath === candidate.canonicalPath ||
          authorizedOutboundFilesShareIdentity(file, candidate),
      );
      if (duplicate) {
        await candidate.close();
        ownedFiles.delete(candidate);
        continue;
      }
      files.push(candidate);
      if (files.length > limits.attachments) {
        throw invalidArgument("Final assistant text authorized too many attachments.");
      }
    }
  } catch (error) {
    return closeMarkerFilesAfterFailure(ownedFiles, error);
  }

  const visibleText = lines
    .filter((_line, index) => !markers.has(index))
    .map((line) => `${line.text}${line.separator}`)
    .join("");
  return { visibleText, files };
}

export class CodexSessionService {
  private readonly client: SessionAppServerClient;
  private readonly workspaceNormalizer: WorkspaceNormalizer;
  private readonly threadCreationJournal: ThreadCreationJournal;
  private readonly now: () => Date;
  private readonly listPageSize: number;
  private readonly maxListPages: number;
  private readonly maxListItems: number;
  private readonly maxTurnInputCharacters: number;
  private activeFileContext:
    | { readonly threadId: string; readonly workspace: NormalizedWorkspace }
    | undefined;

  constructor(options: CodexSessionServiceOptions) {
    this.client = options.client;
    this.workspaceNormalizer = options.workspaceNormalizer;
    this.threadCreationJournal = options.threadCreationJournal;
    this.now = options.now ?? (() => new Date());
    if (
      typeof this.threadCreationJournal?.begin !== "function" ||
      typeof this.threadCreationJournal.confirm !== "function" ||
      typeof this.threadCreationJournal.markAmbiguous !== "function" ||
      typeof this.threadCreationJournal.markNotSent !== "function" ||
      typeof this.now !== "function"
    ) {
      throw invalidArgument("Codex session thread creation journal is invalid.");
    }
    this.listPageSize = configuredLimit(
      "listPageSize",
      options.listPageSize ?? DEFAULT_LIST_PAGE_SIZE,
    );
    this.maxListPages = configuredLimit(
      "maxListPages",
      options.maxListPages ?? DEFAULT_MAX_LIST_PAGES,
    );
    this.maxListItems = configuredLimit(
      "maxListItems",
      options.maxListItems ?? DEFAULT_MAX_LIST_ITEMS,
    );
    this.maxTurnInputCharacters = configuredLimit(
      "maxTurnInputCharacters",
      options.maxTurnInputCharacters ?? DEFAULT_MAX_TURN_INPUT_CHARACTERS,
    );
  }

  private async request<Method extends ClientRequestMethod>(
    method: Method,
    params: ClientRequestParams<Method>,
  ): Promise<ClientRequestResult<Method>> {
    try {
      return await this.client.request(method, params);
    } catch (error) {
      if (error instanceof BridgeError) {
        throw error;
      }
      throw runtimeError(`Codex App Server request ${method} failed.`, error);
    }
  }

  async start(
    profile: WorkspaceProfile,
    inbox: string,
    creationKeyInput: string,
  ): Promise<{ threadId: string }> {
    const operationId = parseExternal(
      IdentifierSchema,
      creationKeyInput,
      "Invalid durable thread creation key.",
    );
    const workspace = await this.workspaceNormalizer.normalize(profile, inbox);
    let startedAt: string;
    try {
      const now = this.now();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
        throw invalidArgument("Invalid thread creation timestamp.");
      }
      startedAt = now.toISOString();
    } catch (error) {
      if (error instanceof BridgeError) {
        throw error;
      }
      throw runtimeError("Unable to initialize durable thread creation state.", error);
    }

    try {
      await this.threadCreationJournal.begin({
        operationId,
        cwd: workspace.cwd,
        startedAt,
      });
    } catch (error) {
      if (error instanceof BridgeError) {
        throw error;
      }
      throw runtimeError("Unable to persist pending thread creation state.", error);
    }

    let result: ClientRequestResult<"thread/start">;
    try {
      result = await this.request("thread/start", {
        ...normalizedThreadConfiguration(workspace),
        developerInstructions: composeFileInstructions(workspace.developerInstructions),
        ephemeral: false,
        dynamicTools: [DISCORD_SEND_FILE_DYNAMIC_TOOL],
      });
    } catch (error) {
      const delivery = appServerRequestDelivery(error);
      if (delivery === "not-sent") {
        try {
          await this.threadCreationJournal.markNotSent(operationId);
        } catch {
          throw new ThreadCreationConflictError(
            operationId,
            undefined,
            "Thread creation failed before confirmation and journal cleanup also failed.",
          );
        }
        throw error;
      }
      try {
        await this.threadCreationJournal.markAmbiguous(operationId);
      } catch {
        // The durable pending record still prevents a blind retry.
      }
      throw new ThreadCreationConflictError(operationId);
    }

    let parsed: z.infer<typeof ThreadIdentityResponseSchema>;
    try {
      parsed = parseResult(ThreadIdentityResponseSchema, result, "thread/start");
    } catch {
      try {
        await this.threadCreationJournal.markAmbiguous(operationId);
      } catch {
        // The pending record remains available for reconciliation.
      }
      throw new ThreadCreationConflictError(
        operationId,
        undefined,
        "Codex returned an untrusted thread creation result.",
      );
    }

    const threadId = parsed.thread.id;
    try {
      await this.request("thread/inject_items", {
        threadId,
        items: [...THREAD_MATERIALIZATION_ITEMS],
      });
    } catch {
      try {
        await this.threadCreationJournal.markAmbiguous(operationId);
      } catch {
        // The pending record still prevents a blind thread/start retry.
      }
      throw new ThreadCreationConflictError(
        operationId,
        threadId,
        "Codex created a thread but could not materialize its persisted rollout.",
      );
    }
    try {
      await this.threadCreationJournal.confirm(operationId, threadId);
    } catch {
      throw new ThreadCreationConflictError(
        operationId,
        threadId,
        "Codex created a thread but journal confirmation failed.",
      );
    }
    return { threadId };
  }

  async resume(threadIdInput: string, profile: WorkspaceProfile, inbox: string): Promise<void> {
    const threadId = parseExternal(ThreadIdSchema, threadIdInput, "Invalid Codex thread ID.");
    const workspace = await this.workspaceNormalizer.normalize(profile, inbox);
    const configuration = normalizedThreadConfiguration(workspace);
    const result = await this.request("thread/resume", {
      ...configuration,
      threadId,
      developerInstructions: composeFileInstructions(workspace.developerInstructions),
    });
    const parsed = parseResult(ThreadIdentityResponseSchema, result, "thread/resume");
    if (parsed.thread.id !== threadId) {
      throw runtimeError("Codex App Server resumed a different thread than requested.");
    }
    this.activeFileContext = Object.freeze({ threadId, workspace });
  }

  async authorizeSendFile(
    threadIdInput: string,
    input: unknown,
  ): Promise<AuthorizedDiscordSendFileArguments> {
    const { workspace } = this.requireActiveFileContext(threadIdInput);
    return validateDiscordSendFileArguments(input, { workspace });
  }

  async parseFileMarkers(
    threadIdInput: string,
    text: string,
  ): Promise<{ visibleText: string; files: AuthorizedOutboundFile[] }> {
    const { workspace } = this.requireActiveFileContext(threadIdInput);
    return parseDiscordFileMarkers(text, {
      workspace,
      source: { kind: "app-server", role: "assistant", final: true },
    });
  }

  private requireActiveFileContext(threadIdInput: string): {
    readonly threadId: string;
    readonly workspace: NormalizedWorkspace;
  } {
    const threadId = parseExternal(ThreadIdSchema, threadIdInput, "Invalid Codex thread ID.");
    const active = this.activeFileContext;
    if (active === undefined || active.threadId !== threadId) {
      throw new BridgeError(
        "CONFLICT",
        "Discord file delivery is not bound to the active Codex thread.",
        "Resume the bound Codex thread before sending a file.",
      );
    }
    return active;
  }

  async list(): Promise<ThreadSummary[]> {
    const threads: ThreadSummary[] = [];
    const seenIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < this.maxListPages; page += 1) {
      const result = await this.request("thread/list", {
        ...(cursor === undefined ? {} : { cursor }),
        limit: this.listPageSize,
        sourceKinds: [...PERSISTED_INTERACTIVE_THREAD_SOURCE_KINDS],
      });
      const pageItemCount = rawDataCount(result);
      if (pageItemCount !== undefined && pageItemCount > this.maxListItems - threads.length) {
        throw runtimeError("Codex App Server thread list exceeded the configured item limit.");
      }
      const parsed = parseResult(ThreadListResponseSchema, result, "thread/list");
      if (threads.length + parsed.data.length > this.maxListItems) {
        throw runtimeError("Codex App Server thread list exceeded the configured item limit.");
      }
      for (const thread of parsed.data) {
        if (seenIds.has(thread.id)) {
          throw runtimeError("Codex App Server thread list contained a duplicate thread ID.");
        }
        seenIds.add(thread.id);
        threads.push(toThreadSummary(thread));
      }

      const nextCursor = parsed.nextCursor ?? null;
      if (nextCursor === null) {
        return threads;
      }
      if (seenCursors.has(nextCursor)) {
        throw runtimeError("Codex App Server thread list repeated a pagination cursor.");
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw runtimeError("Codex App Server thread list exceeded the configured page limit.");
  }

  async read(threadIdInput: string): Promise<ThreadSummary> {
    const threadId = parseExternal(ThreadIdSchema, threadIdInput, "Invalid Codex thread ID.");
    const result = await this.request("thread/read", { threadId, includeTurns: false });
    const parsed = parseResult(ThreadReadResponseSchema, result, "thread/read");
    if (parsed.thread.id !== threadId) {
      throw runtimeError("Codex App Server returned a different thread than requested.");
    }
    return toThreadSummary(parsed.thread);
  }

  async listModels(): Promise<readonly CodexModelCatalogEntry[]> {
    const models: CodexModelCatalogEntry[] = [];
    const seenIds = new Set<string>();
    const seenCursors = new Set<string>();
    const pageSize = Math.min(this.listPageSize, MAX_MODEL_LIST_PAGE_SIZE);
    const maxPages = Math.min(this.maxListPages, MAX_MODEL_LIST_PAGES);
    const maxItems = Math.min(this.maxListItems, MAX_MODEL_LIST_ITEMS);
    let cursor: string | undefined;

    for (let page = 0; page < maxPages; page += 1) {
      const result = await this.request("model/list", {
        ...(cursor === undefined ? {} : { cursor }),
        includeHidden: true,
        limit: pageSize,
      });
      const pageItemCount = rawDataCount(result);
      if (pageItemCount !== undefined && pageItemCount > maxItems - models.length) {
        throw runtimeError("Codex App Server model list exceeded the configured item limit.");
      }
      const parsed = parseResult(ModelListPageSchema, result, "model/list");
      if (models.length + parsed.data.length > maxItems) {
        throw runtimeError("Codex App Server model list exceeded the configured item limit.");
      }

      for (const model of parsed.data) {
        if (seenIds.has(model.id)) {
          throw runtimeError("Codex App Server model list contained a duplicate model ID.");
        }
        seenIds.add(model.id);
        const efforts = model.supportedReasoningEfforts.map((item) => item.reasoningEffort);
        if (!efforts.includes(model.defaultReasoningEffort)) {
          throw runtimeError("Codex App Server model default effort is unsupported.");
        }
        models.push(
          Object.freeze({
            id: model.id,
            model: model.model,
            displayName: model.displayName,
            hidden: model.hidden,
            isDefault: model.isDefault,
            defaultReasoningEffort: model.defaultReasoningEffort,
            supportedReasoningEfforts: Object.freeze(efforts),
          }),
        );
      }

      const nextCursor = parsed.nextCursor ?? null;
      if (nextCursor === null) {
        if (models.length === 0) {
          throw runtimeError("Codex App Server returned an empty model catalog.");
        }
        if (models.filter((model) => model.isDefault).length !== 1) {
          throw runtimeError("Codex App Server model catalog must contain exactly one default.");
        }
        return Object.freeze(models);
      }
      if (parsed.data.length === 0) {
        throw runtimeError("Codex App Server model list returned an empty continuation page.");
      }
      if (seenCursors.has(nextCursor)) {
        throw runtimeError("Codex App Server model list repeated a pagination cursor.");
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw runtimeError("Codex App Server model list exceeded the configured page limit.");
  }

  async startTurn(
    threadIdInput: string,
    input: string,
    sourceInput: DiscordTurnSource,
    settingsInput: CodexTurnSettings,
  ): Promise<{ turnId: string }> {
    const threadId = parseExternal(ThreadIdSchema, threadIdInput, "Invalid Codex thread ID.");
    if (
      typeof input !== "string" ||
      input.trim().length === 0 ||
      input.length > this.maxTurnInputCharacters
    ) {
      throw invalidArgument("Codex turn input must be nonempty and within the configured limit.");
    }
    const source = parseExternal(
      DiscordTurnSourceSchema,
      sourceInput,
      "Invalid Discord turn source.",
    );
    const settings = parseExternal(
      CodexTurnSettingsSchema,
      settingsInput,
      "Invalid Codex turn model settings.",
    );
    const metadata = {
      discord_message_id: source.messageId,
      discord_channel_id: source.channelId,
      discord_author_id: source.authorId,
      ...(source.guildId === undefined ? {} : { discord_guild_id: source.guildId }),
      ...(source.parentChannelId === undefined
        ? {}
        : { discord_parent_channel_id: source.parentChannelId }),
      ...(source.interactionId === undefined
        ? {}
        : { discord_interaction_id: source.interactionId }),
    };
    const result = await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text: input, text_elements: [] }],
      model: settings.model,
      effort: settings.effort,
      clientUserMessageId: source.messageId,
      responsesapiClientMetadata: metadata,
    });
    const parsed = parseResult(TurnStartResponseSchema, result, "turn/start");
    return { turnId: parsed.turn.id };
  }

  async interrupt(threadIdInput: string, turnIdInput: string): Promise<void> {
    const threadId = parseExternal(ThreadIdSchema, threadIdInput, "Invalid Codex thread ID.");
    const turnId = parseExternal(TurnIdSchema, turnIdInput, "Invalid Codex turn ID.");
    const result = await this.request("turn/interrupt", { threadId, turnId });
    parseResult(EmptyResponseSchema, result, "turn/interrupt");
  }
}
