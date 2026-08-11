import { z } from "zod";
import { BridgeError } from "../domain/errors.js";
import { DiscordSnowflakeSchema } from "../domain/schemas.js";

const MAX_PROGRESS_TEXT_LENGTH = 65_536;
const MAX_PROGRESS_PATH_LENGTH = 8_192;
const MAX_PROGRESS_PLAN_STEPS = 128;
const MAX_PROGRESS_FILE_PATHS = 256;

function hasUnsafeControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      (code >= 0x7f && code <= 0x9f)
    ) {
      return true;
    }
  }
  return false;
}

const ProgressTextSchema = z
  .string()
  .min(1)
  .max(MAX_PROGRESS_TEXT_LENGTH)
  .refine((value) => !hasUnsafeControlCharacter(value));
const ProgressPathSchema = z
  .string()
  .min(1)
  .max(MAX_PROGRESS_PATH_LENGTH)
  .refine((value) => !hasUnsafeControlCharacter(value));

export const ProgressPlanStepStatusSchema = z.enum(["pending", "inProgress", "completed"]);
export type ProgressPlanStepStatus = z.infer<typeof ProgressPlanStepStatusSchema>;

const ProgressPlanStepSchema = z
  .object({
    status: ProgressPlanStepStatusSchema,
    step: ProgressTextSchema,
  })
  .strict();
export type ProgressPlanStep = Readonly<z.infer<typeof ProgressPlanStepSchema>>;

const CommandActivitySchema = z
  .object({
    executable: ProgressTextSchema,
    kind: z.literal("command"),
  })
  .strict();
const FileActivitySchema = z
  .object({
    kind: z.literal("file"),
    paths: z.array(ProgressPathSchema).max(MAX_PROGRESS_FILE_PATHS),
  })
  .strict();
const ToolActivitySchema = z
  .object({
    kind: z.literal("tool"),
    name: ProgressTextSchema,
    provider: ProgressTextSchema.optional(),
  })
  .strict();
const WebActivitySchema = z
  .object({
    kind: z.literal("web"),
    query: ProgressTextSchema.optional(),
  })
  .strict();
const CollaborationActivitySchema = z
  .object({
    kind: z.literal("collaboration"),
    operation: ProgressTextSchema,
  })
  .strict();

export const ProgressActivitySchema = z.discriminatedUnion("kind", [
  CommandActivitySchema,
  FileActivitySchema,
  ToolActivitySchema,
  WebActivitySchema,
  CollaborationActivitySchema,
]);
export type ProgressActivity = Readonly<z.infer<typeof ProgressActivitySchema>>;

export const ProgressActivityStatusSchema = z.enum(["inProgress", "completed", "failed"]);
export type ProgressActivityStatus = z.infer<typeof ProgressActivityStatusSchema>;

const StateProgressEventSchema = z
  .object({
    state: z.enum(["preparing", "queued", "running"]),
    type: z.literal("state"),
  })
  .strict();
const ReasoningProgressEventSchema = z
  .object({ text: ProgressTextSchema, type: z.literal("reasoning") })
  .strict();
const CommentaryProgressEventSchema = z
  .object({ text: ProgressTextSchema, type: z.literal("commentary") })
  .strict();
const PlanProgressEventSchema = z
  .object({
    steps: z.array(ProgressPlanStepSchema).max(MAX_PROGRESS_PLAN_STEPS),
    type: z.literal("plan"),
  })
  .strict();
const ActivityProgressEventSchema = z
  .object({
    activity: ProgressActivitySchema,
    status: ProgressActivityStatusSchema,
    type: z.literal("activity"),
  })
  .strict();
const WarningProgressEventSchema = z
  .object({ message: ProgressTextSchema, type: z.literal("warning") })
  .strict();
const HeartbeatProgressEventSchema = z
  .object({
    observedAt: z.iso.datetime({ offset: true }),
    type: z.literal("heartbeat"),
  })
  .strict();
export const TurnProgressTerminalSchema = z
  .object({
    message: ProgressTextSchema.optional(),
    status: z.enum(["completed", "interrupted", "failed"]),
    type: z.literal("terminal"),
  })
  .strict();

export const TurnProgressEventSchema = z.discriminatedUnion("type", [
  StateProgressEventSchema,
  ReasoningProgressEventSchema,
  CommentaryProgressEventSchema,
  PlanProgressEventSchema,
  ActivityProgressEventSchema,
  WarningProgressEventSchema,
  HeartbeatProgressEventSchema,
  TurnProgressTerminalSchema,
]);
export type TurnProgressEvent = Readonly<z.infer<typeof TurnProgressEventSchema>>;
export type TurnProgressTerminal = Readonly<z.infer<typeof TurnProgressTerminalSchema>>;

const TurnProgressSourceSchema = z
  .object({
    channelId: DiscordSnowflakeSchema,
    guildId: DiscordSnowflakeSchema.optional(),
    messageId: DiscordSnowflakeSchema,
  })
  .strict();
export type TurnProgressSource = Readonly<z.infer<typeof TurnProgressSourceSchema>>;

const DiscordDeliveryReceiptSchema = z
  .object({
    channelId: DiscordSnowflakeSchema,
    messageId: DiscordSnowflakeSchema,
  })
  .strict();
export type DiscordDeliveryReceipt = Readonly<z.infer<typeof DiscordDeliveryReceiptSchema>>;

function invalidProgressValue(message: string): BridgeError {
  return new BridgeError(
    "INVALID_ARGUMENT",
    message,
    "Provide bounded progress metadata and retry.",
  );
}

function freezeProgressValue<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    freezeProgressValue(child);
  }
  return Object.freeze(value);
}

export function createTurnProgressEvent(input: unknown): TurnProgressEvent {
  const parsed = TurnProgressEventSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidProgressValue("Invalid turn progress event.");
  }
  return freezeProgressValue(parsed.data);
}

export function createTurnProgressSource(input: unknown): TurnProgressSource {
  const parsed = TurnProgressSourceSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidProgressValue("Invalid turn progress source.");
  }
  return freezeProgressValue(parsed.data);
}

export function createDiscordDeliveryReceipt(input: unknown): DiscordDeliveryReceipt {
  const parsed = DiscordDeliveryReceiptSchema.safeParse(input);
  if (!parsed.success) {
    throw invalidProgressValue("Invalid Discord delivery receipt.");
  }
  return freezeProgressValue(parsed.data);
}

export interface TurnProgressPort {
  queued(source: TurnProgressSource): Promise<void>;
  running(source: TurnProgressSource): Promise<void>;
  bindTurn(source: TurnProgressSource, turnId: string): Promise<void>;
  event(source: TurnProgressSource, event: TurnProgressEvent): Promise<void>;
  terminal(source: TurnProgressSource, event: TurnProgressTerminal): Promise<void>;
}
