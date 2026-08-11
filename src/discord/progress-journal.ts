import { isAbsolute } from "node:path";
import { z } from "zod";
import { BridgeError } from "../domain/errors.js";
import { DiscordSnowflakeSchema, IdentifierSchema, IsoTimestampSchema } from "../domain/schemas.js";
import type { DiscordDeliveryReceipt, TurnProgressSource } from "../runtime/turn-progress.js";
import {
  type AtomicJsonEventObserver,
  AtomicJsonStore,
  type AtomicLockAdapter,
  type AtomicWriteFaultInjector,
} from "../storage/atomic-json.js";

export const DEFAULT_MAX_ACTIVE_PROGRESS_OBSERVATIONS = 1_000;
export const DEFAULT_MAX_TOTAL_PROGRESS_OBSERVATIONS = 100_000;
const MAX_CONFIGURED_RECORDS = 1_000_000;
const MAX_TOMBSTONE_PAGE_SIZE = 1_000;

const ObservationStateSchema = z.enum([
  "creating",
  "preparing",
  "queued",
  "running",
  "completed",
  "interrupted",
  "failed",
]);
export type ObservationState = z.infer<typeof ObservationStateSchema>;
type TerminalObservationState = Extract<ObservationState, "completed" | "interrupted" | "failed">;

const ProgressSourceSchema = z
  .object({
    channelId: DiscordSnowflakeSchema,
    guildId: DiscordSnowflakeSchema.optional(),
    messageId: DiscordSnowflakeSchema,
  })
  .strict();
const DeliveryReceiptSchema = z
  .object({
    channelId: DiscordSnowflakeSchema,
    messageId: DiscordSnowflakeSchema,
  })
  .strict();
const ThreadDestinationSchema = z
  .object({
    kind: z.literal("thread"),
    ownerId: DiscordSnowflakeSchema,
    parentChannelId: DiscordSnowflakeSchema,
    threadId: DiscordSnowflakeSchema,
  })
  .strict();
const InPlaceDestinationSchema = z
  .object({
    channelId: DiscordSnowflakeSchema,
    kind: z.literal("inPlace"),
    messageId: DiscordSnowflakeSchema,
  })
  .strict();
const ProgressDestinationSchema = z.discriminatedUnion("kind", [
  ThreadDestinationSchema,
  InPlaceDestinationSchema,
]);
export type ProgressDestination = Readonly<z.infer<typeof ProgressDestinationSchema>>;

const DeliveryCurrentSchema = z.discriminatedUnion("status", [
  z.object({ sequence: z.number().int().positive(), status: z.literal("sending") }).strict(),
  z.object({ sequence: z.number().int().positive(), status: z.literal("uncertain") }).strict(),
  z.object({ sequence: z.number().int().positive(), status: z.literal("failed") }).strict(),
]);
const DeliveryProgressSchema = z
  .object({
    acceptedThrough: z.number().int().nonnegative(),
    current: DeliveryCurrentSchema.optional(),
    firstAcceptedReceipt: DeliveryReceiptSchema.optional(),
    nextSequence: z.number().int().positive(),
  })
  .strict()
  .superRefine((delivery, context) => {
    if (delivery.acceptedThrough >= delivery.nextSequence) {
      context.addIssue({ code: "custom", message: "Accepted delivery sequence is invalid" });
    }
    if ((delivery.acceptedThrough === 0) !== (delivery.firstAcceptedReceipt === undefined)) {
      context.addIssue({ code: "custom", message: "First delivery receipt is inconsistent" });
    }
    if (
      delivery.current !== undefined &&
      (delivery.current.sequence <= delivery.acceptedThrough ||
        delivery.current.sequence >= delivery.nextSequence)
    ) {
      context.addIssue({ code: "custom", message: "Current delivery sequence is invalid" });
    }
  });
export type DeliveryProgress = Readonly<z.infer<typeof DeliveryProgressSchema>>;

export const ProgressObservationRecordSchema = z
  .object({
    createdAt: IsoTimestampSchema,
    delivery: DeliveryProgressSchema,
    destination: ProgressDestinationSchema.optional(),
    expectedThreadId: DiscordSnowflakeSchema.optional(),
    reconciliationRequestedAt: IsoTimestampSchema.optional(),
    source: ProgressSourceSchema,
    state: ObservationStateSchema,
    turnId: IdentifierSchema.optional(),
    updatedAt: IsoTimestampSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if (Date.parse(record.updatedAt) < Date.parse(record.createdAt)) {
      context.addIssue({ code: "custom", message: "Observation timestamps are out of order" });
    }
    if (
      record.expectedThreadId !== undefined &&
      record.expectedThreadId !== record.source.messageId
    ) {
      context.addIssue({ code: "custom", message: "Expected thread ID must match source message" });
    }
    if (record.destination?.kind === "thread") {
      if (
        record.expectedThreadId !== record.destination.threadId ||
        record.destination.parentChannelId !== record.source.channelId
      ) {
        context.addIssue({ code: "custom", message: "Thread destination provenance is invalid" });
      }
    }
    if (
      record.destination?.kind === "inPlace" &&
      record.destination.channelId !== record.source.channelId
    ) {
      context.addIssue({ code: "custom", message: "In-place destination channel is invalid" });
    }
    if (
      record.state !== "creating" &&
      record.state !== "failed" &&
      record.destination === undefined
    ) {
      context.addIssue({ code: "custom", message: "Active observation destination is missing" });
    }
    if (
      record.turnId !== undefined &&
      record.state !== "running" &&
      record.state !== "completed" &&
      record.state !== "interrupted" &&
      record.state !== "failed"
    ) {
      context.addIssue({ code: "custom", message: "Turn ID is not valid for this state" });
    }
    if (record.reconciliationRequestedAt !== undefined && !isTerminalState(record.state)) {
      context.addIssue({ code: "custom", message: "Active observation cannot be reconciled" });
    }
  });
export type ProgressObservationRecord = Readonly<z.infer<typeof ProgressObservationRecordSchema>>;

interface ProgressObservationDocument {
  readonly records: Record<string, ProgressObservationRecord>;
  readonly version: 1;
}

const BeginCreationSchema = z
  .object({
    createdAt: IsoTimestampSchema,
    source: ProgressSourceSchema,
    threadCreationExpected: z.boolean(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.threadCreationExpected && input.source.guildId === undefined) {
      context.addIssue({ code: "custom", message: "Guild source is required for a thread" });
    }
  });

const TombstonePageOptionsSchema = z
  .object({
    cursor: DiscordSnowflakeSchema.optional(),
    limit: z.number().int().positive().max(MAX_TOMBSTONE_PAGE_SIZE),
  })
  .strict();

export interface TombstonePage {
  readonly nextCursor?: string;
  readonly records: readonly ProgressObservationRecord[];
}

export interface DeliveryReservation {
  readonly first: boolean;
  readonly sequence: number;
}

export interface AtomicProgressObservationJournalOptions {
  readonly eventObserver?: AtomicJsonEventObserver;
  readonly faultInjector?: AtomicWriteFaultInjector;
  readonly filePath: string;
  readonly lockAdapter?: AtomicLockAdapter;
  readonly maxActiveRecords?: number;
  readonly maxTotalRecords?: number;
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

function isTerminalState(state: ObservationState): state is TerminalObservationState {
  return state === "completed" || state === "interrupted" || state === "failed";
}

function parseInput<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new BridgeError("INVALID_ARGUMENT", `Invalid progress journal ${label}.`);
  }
  return parsed.data;
}

function conflict(message: string): BridgeError {
  return new BridgeError(
    "CONFLICT",
    message,
    "Inspect and reconcile the durable progress journal before retrying.",
  );
}

function notFound(): BridgeError {
  return new BridgeError(
    "NOT_FOUND",
    "Progress observation was not found.",
    "Use the exact source message or progress thread ID and retry.",
  );
}

function configuredRecordLimit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_CONFIGURED_RECORDS) {
    throw new BridgeError("INVALID_ARGUMENT", `Invalid progress journal ${name}.`);
  }
  return value;
}

function activeRecordCount(records: Record<string, ProgressObservationRecord>): number {
  return Object.values(records).filter((record) => !isTerminalState(record.state)).length;
}

function retainedThreadId(record: ProgressObservationRecord): string | undefined {
  return record.destination?.kind === "thread"
    ? record.destination.threadId
    : record.expectedThreadId;
}

function documentSchema(
  maxActiveRecords: number,
  maxTotalRecords: number,
): z.ZodType<ProgressObservationDocument> {
  return z
    .object({
      records: z.record(DiscordSnowflakeSchema, ProgressObservationRecordSchema),
      version: z.literal(1),
    })
    .strict()
    .superRefine((document, context) => {
      if (Object.keys(document.records).length > maxTotalRecords) {
        context.addIssue({ code: "custom", message: "Progress total record limit exceeded" });
      }
      if (activeRecordCount(document.records) > maxActiveRecords) {
        context.addIssue({ code: "custom", message: "Progress active record limit exceeded" });
      }
      const threadOwners = new Map<string, string>();
      for (const [sourceMessageId, record] of Object.entries(document.records)) {
        if (sourceMessageId !== record.source.messageId) {
          context.addIssue({
            code: "custom",
            message: "Progress source record key mismatch",
            path: ["records", sourceMessageId, "source", "messageId"],
          });
        }
        const threadId = retainedThreadId(record);
        if (threadId === undefined) {
          continue;
        }
        const existing = threadOwners.get(threadId);
        if (existing !== undefined && existing !== sourceMessageId) {
          context.addIssue({
            code: "custom",
            message: "Progress thread provenance is duplicated",
            path: ["records", sourceMessageId, "expectedThreadId"],
          });
        } else {
          threadOwners.set(threadId, sourceMessageId);
        }
      }
    });
}

function compareSnowflakes(left: string, right: string): number {
  return left.length === right.length ? left.localeCompare(right) : left.length - right.length;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function frozenRecord(record: ProgressObservationRecord): ProgressObservationRecord {
  return deepFreeze(structuredClone(record));
}

function withUpdatedAt(
  record: ProgressObservationRecord,
  updatedAt: string,
): ProgressObservationRecord {
  if (Date.parse(updatedAt) < Date.parse(record.updatedAt)) {
    throw conflict("Progress observation timestamp cannot move backward.");
  }
  return { ...record, updatedAt };
}

const legalTransitions: Readonly<Record<ObservationState, readonly ObservationState[]>> = {
  creating: ["preparing", "failed"],
  preparing: ["queued", "interrupted", "failed"],
  queued: ["running", "interrupted", "failed"],
  running: ["completed", "interrupted", "failed"],
  completed: [],
  interrupted: [],
  failed: [],
};

export class AtomicProgressObservationJournal {
  readonly #store: AtomicJsonStore<ProgressObservationDocument>;
  readonly #maxActiveRecords: number;
  readonly #maxTotalRecords: number;

  constructor(options: AtomicProgressObservationJournalOptions) {
    if (!isAbsolute(options.filePath) || hasControlCharacters(options.filePath)) {
      throw new BridgeError("INVALID_ARGUMENT", "Invalid progress journal path.");
    }
    this.#maxActiveRecords = configuredRecordLimit(
      "maxActiveRecords",
      options.maxActiveRecords ?? DEFAULT_MAX_ACTIVE_PROGRESS_OBSERVATIONS,
    );
    this.#maxTotalRecords = configuredRecordLimit(
      "maxTotalRecords",
      options.maxTotalRecords ?? DEFAULT_MAX_TOTAL_PROGRESS_OBSERVATIONS,
    );
    if (this.#maxActiveRecords > this.#maxTotalRecords) {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        "Progress maxActiveRecords cannot exceed maxTotalRecords.",
      );
    }
    this.#store = new AtomicJsonStore<ProgressObservationDocument>({
      ...(options.eventObserver === undefined ? {} : { eventObserver: options.eventObserver }),
      ...(options.faultInjector === undefined ? {} : { faultInjector: options.faultInjector }),
      filePath: options.filePath,
      initialDocument: () => ({ records: {}, version: 1 }),
      ...(options.lockAdapter === undefined ? {} : { lockAdapter: options.lockAdapter }),
      schema: documentSchema(this.#maxActiveRecords, this.#maxTotalRecords),
    });
  }

  async initialize(updatedAtInput: string): Promise<number> {
    const updatedAt = parseInput(IsoTimestampSchema, updatedAtInput, "startup timestamp");
    return this.#store.transact((current) => {
      let changed = 0;
      const records = { ...current.records };
      for (const [sourceMessageId, record] of Object.entries(records)) {
        if (record.delivery.current?.status !== "sending") {
          continue;
        }
        changed += 1;
        records[sourceMessageId] = {
          ...withUpdatedAt(record, updatedAt),
          delivery: {
            ...record.delivery,
            current: { sequence: record.delivery.current.sequence, status: "uncertain" },
          },
        };
      }
      return {
        document: changed === 0 ? current : { records, version: 1 },
        result: changed,
      };
    });
  }

  async beginCreation(inputValue: unknown): Promise<ProgressObservationRecord> {
    const input = parseInput(BeginCreationSchema, inputValue, "creation intent");
    return this.#store.transact((current) => {
      const existing = current.records[input.source.messageId];
      if (existing !== undefined) {
        const expectedThreadId = input.threadCreationExpected ? input.source.messageId : undefined;
        if (
          JSON.stringify(existing.source) !== JSON.stringify(input.source) ||
          existing.expectedThreadId !== expectedThreadId
        ) {
          throw conflict("Progress source message is already retained with different metadata.");
        }
        return { document: current, result: frozenRecord(existing) };
      }
      if (Object.keys(current.records).length >= this.#maxTotalRecords) {
        throw new BridgeError(
          "CONFLICT",
          "Progress journal total durable record limit was reached.",
          "Delete an obsolete Discord progress thread, request tombstone reconciliation, and restart the runner.",
        );
      }
      if (activeRecordCount(current.records) >= this.#maxActiveRecords) {
        throw conflict("Progress journal active record limit was reached.");
      }
      const record: ProgressObservationRecord = {
        createdAt: input.createdAt,
        delivery: { acceptedThrough: 0, nextSequence: 1 },
        ...(input.threadCreationExpected ? { expectedThreadId: input.source.messageId } : {}),
        source: input.source,
        state: "creating",
        updatedAt: input.createdAt,
      };
      return {
        document: {
          records: { ...current.records, [input.source.messageId]: record },
          version: 1,
        },
        result: frozenRecord(record),
      };
    });
  }

  async confirmDestination(
    sourceMessageIdInput: string,
    destinationInput: unknown,
    updatedAtInput: string,
  ): Promise<void> {
    const sourceMessageId = parseInput(
      DiscordSnowflakeSchema,
      sourceMessageIdInput,
      "source message ID",
    );
    const destination = parseInput(ProgressDestinationSchema, destinationInput, "destination");
    const updatedAt = parseInput(IsoTimestampSchema, updatedAtInput, "destination timestamp");
    await this.#store.transact((current) => {
      const record = current.records[sourceMessageId];
      if (record === undefined) {
        throw notFound();
      }
      if (record.destination !== undefined) {
        if (JSON.stringify(record.destination) === JSON.stringify(destination)) {
          return { document: current, result: undefined };
        }
        throw conflict("Progress destination is already confirmed.");
      }
      if (record.state !== "creating") {
        throw conflict("Only a creating observation can confirm a destination.");
      }
      if (
        destination.kind === "thread" &&
        (record.expectedThreadId !== destination.threadId ||
          destination.parentChannelId !== record.source.channelId)
      ) {
        throw conflict("Progress thread does not match its durable creation intent.");
      }
      const destinationThreadId = destination.kind === "thread" ? destination.threadId : undefined;
      if (
        destinationThreadId !== undefined &&
        Object.values(current.records).some(
          (candidate) =>
            candidate.source.messageId !== sourceMessageId &&
            retainedThreadId(candidate) === destinationThreadId,
        )
      ) {
        throw conflict("Progress thread is already retained by another source.");
      }
      const next = { ...withUpdatedAt(record, updatedAt), destination };
      return {
        document: {
          records: { ...current.records, [sourceMessageId]: next },
          version: 1,
        },
        result: undefined,
      };
    });
  }

  async markPreparing(sourceMessageId: string, updatedAt: string): Promise<void> {
    await this.#transition(sourceMessageId, "preparing", updatedAt);
  }

  async markQueued(sourceMessageId: string, updatedAt: string): Promise<void> {
    await this.#transition(sourceMessageId, "queued", updatedAt);
  }

  async markRunning(
    sourceMessageIdInput: string,
    turnIdInput: string,
    updatedAtInput: string,
  ): Promise<void> {
    const sourceMessageId = parseInput(
      DiscordSnowflakeSchema,
      sourceMessageIdInput,
      "source message ID",
    );
    const turnId = parseInput(IdentifierSchema, turnIdInput, "turn ID");
    const updatedAt = parseInput(IsoTimestampSchema, updatedAtInput, "running timestamp");
    await this.#store.transact((current) => {
      const record = current.records[sourceMessageId];
      if (record === undefined) {
        throw notFound();
      }
      if (record.state === "running" && record.turnId === turnId) {
        return { document: current, result: undefined };
      }
      if (!legalTransitions[record.state].includes("running")) {
        throw conflict(`Progress observation cannot transition from ${record.state} to running.`);
      }
      const next: ProgressObservationRecord = {
        ...withUpdatedAt(record, updatedAt),
        state: "running",
        turnId,
      };
      return {
        document: {
          records: { ...current.records, [sourceMessageId]: next },
          version: 1,
        },
        result: undefined,
      };
    });
  }

  async beginDelivery(
    sourceMessageIdInput: string,
    updatedAtInput: string,
  ): Promise<DeliveryReservation> {
    const sourceMessageId = parseInput(
      DiscordSnowflakeSchema,
      sourceMessageIdInput,
      "source message ID",
    );
    const updatedAt = parseInput(IsoTimestampSchema, updatedAtInput, "delivery timestamp");
    return this.#store.transact((current) => {
      const record = current.records[sourceMessageId];
      if (record === undefined) {
        throw notFound();
      }
      if (record.state !== "running") {
        throw conflict("Final delivery requires a running observation.");
      }
      if (record.delivery.current !== undefined) {
        throw conflict("A final delivery is already in flight or unresolved.");
      }
      const sequence = record.delivery.nextSequence;
      const next: ProgressObservationRecord = {
        ...withUpdatedAt(record, updatedAt),
        delivery: {
          ...record.delivery,
          current: { sequence, status: "sending" },
          nextSequence: sequence + 1,
        },
      };
      return {
        document: {
          records: { ...current.records, [sourceMessageId]: next },
          version: 1,
        },
        result: Object.freeze({
          first: record.delivery.firstAcceptedReceipt === undefined,
          sequence,
        }),
      };
    });
  }

  async acceptDelivery(
    sourceMessageIdInput: string,
    sequenceInput: number,
    receiptInput: DiscordDeliveryReceipt,
    updatedAtInput: string,
  ): Promise<void> {
    const sourceMessageId = parseInput(
      DiscordSnowflakeSchema,
      sourceMessageIdInput,
      "source message ID",
    );
    const sequence = parseInput(z.number().int().positive(), sequenceInput, "delivery sequence");
    const receipt = parseInput(DeliveryReceiptSchema, receiptInput, "delivery receipt");
    const updatedAt = parseInput(IsoTimestampSchema, updatedAtInput, "delivery timestamp");
    await this.#store.transact((current) => {
      const record = current.records[sourceMessageId];
      if (record === undefined) {
        throw notFound();
      }
      if (
        record.delivery.current?.status !== "sending" ||
        record.delivery.current.sequence !== sequence ||
        sequence !== record.delivery.acceptedThrough + 1
      ) {
        throw conflict("Final delivery acceptance does not match the current sequence.");
      }
      const next: ProgressObservationRecord = {
        ...withUpdatedAt(record, updatedAt),
        delivery: {
          acceptedThrough: sequence,
          ...(record.delivery.firstAcceptedReceipt === undefined
            ? { firstAcceptedReceipt: receipt }
            : { firstAcceptedReceipt: record.delivery.firstAcceptedReceipt }),
          nextSequence: record.delivery.nextSequence,
        },
      };
      return {
        document: {
          records: { ...current.records, [sourceMessageId]: next },
          version: 1,
        },
        result: undefined,
      };
    });
  }

  async markDeliveryUncertain(
    sourceMessageId: string,
    sequence: number,
    updatedAt: string,
  ): Promise<void> {
    await this.#markDeliveryTerminal(sourceMessageId, sequence, "uncertain", updatedAt);
  }

  async markDeliveryFailed(
    sourceMessageId: string,
    sequence: number,
    updatedAt: string,
  ): Promise<void> {
    await this.#markDeliveryTerminal(sourceMessageId, sequence, "failed", updatedAt);
  }

  async close(
    sourceMessageIdInput: string,
    stateInput: TerminalObservationState,
    updatedAtInput: string,
  ): Promise<void> {
    const sourceMessageId = parseInput(
      DiscordSnowflakeSchema,
      sourceMessageIdInput,
      "source message ID",
    );
    const state = parseInput(
      z.enum(["completed", "interrupted", "failed"]),
      stateInput,
      "terminal state",
    );
    const updatedAt = parseInput(IsoTimestampSchema, updatedAtInput, "terminal timestamp");
    await this.#store.transact((current) => {
      const record = current.records[sourceMessageId];
      if (record === undefined) {
        throw notFound();
      }
      if (record.state === state) {
        return { document: current, result: undefined };
      }
      if (!legalTransitions[record.state].includes(state)) {
        throw conflict(`Progress observation cannot transition from ${record.state} to ${state}.`);
      }
      const next: ProgressObservationRecord = {
        ...withUpdatedAt(record, updatedAt),
        state,
      };
      if (retainedThreadId(next) === undefined) {
        const { [sourceMessageId]: _removed, ...records } = current.records;
        return { document: { records, version: 1 }, result: undefined };
      }
      return {
        document: {
          records: { ...current.records, [sourceMessageId]: next },
          version: 1,
        },
        result: undefined,
      };
    });
  }

  async get(sourceMessageIdInput: string): Promise<ProgressObservationRecord | undefined> {
    const sourceMessageId = parseInput(
      DiscordSnowflakeSchema,
      sourceMessageIdInput,
      "source message ID",
    );
    const record = (await this.#store.read()).records[sourceMessageId];
    return record === undefined ? undefined : frozenRecord(record);
  }

  async isProgressThread(threadIdInput: string): Promise<boolean> {
    const threadId = parseInput(DiscordSnowflakeSchema, threadIdInput, "thread ID");
    return Object.values((await this.#store.read()).records).some(
      (record) => retainedThreadId(record) === threadId,
    );
  }

  async listActive(): Promise<readonly ProgressObservationRecord[]> {
    const records = Object.values((await this.#store.read()).records)
      .filter((record) => !isTerminalState(record.state))
      .sort((left, right) => compareSnowflakes(left.source.messageId, right.source.messageId))
      .map(frozenRecord);
    return Object.freeze(records);
  }

  async listTerminalTombstones(optionsInput: unknown): Promise<TombstonePage> {
    const options = parseInput(TombstonePageOptionsSchema, optionsInput, "tombstone page options");
    const records = Object.values((await this.#store.read()).records)
      .filter((record) => isTerminalState(record.state) && retainedThreadId(record) !== undefined)
      .sort((left, right) => compareSnowflakes(left.source.messageId, right.source.messageId));
    const start =
      options.cursor === undefined
        ? 0
        : records.findIndex((record) => record.source.messageId === options.cursor) + 1;
    if (options.cursor !== undefined && start === 0) {
      throw new BridgeError("INVALID_ARGUMENT", "Invalid progress tombstone cursor.");
    }
    const page = records.slice(start, start + options.limit);
    const hasMore = start + page.length < records.length;
    const nextRecord = hasMore ? page.at(-1) : undefined;
    return Object.freeze({
      ...(nextRecord === undefined ? {} : { nextCursor: nextRecord.source.messageId }),
      records: Object.freeze(page.map(frozenRecord)),
    });
  }

  async requestTombstoneReconciliation(
    threadIdInput: string,
    requestedAtInput: string,
  ): Promise<void> {
    const threadId = parseInput(DiscordSnowflakeSchema, threadIdInput, "thread ID");
    const requestedAt = parseInput(
      IsoTimestampSchema,
      requestedAtInput,
      "reconciliation timestamp",
    );
    await this.#store.transact((current) => {
      const entry = Object.entries(current.records).find(
        ([, record]) => isTerminalState(record.state) && retainedThreadId(record) === threadId,
      );
      if (entry === undefined) {
        throw notFound();
      }
      const [sourceMessageId, record] = entry;
      if (record.reconciliationRequestedAt === requestedAt) {
        return { document: current, result: undefined };
      }
      const next = {
        ...withUpdatedAt(record, requestedAt),
        reconciliationRequestedAt: requestedAt,
      };
      return {
        document: {
          records: { ...current.records, [sourceMessageId]: next },
          version: 1,
        },
        result: undefined,
      };
    });
  }

  async listRequestedTombstoneReconciliations(
    limitInput: number,
  ): Promise<readonly ProgressObservationRecord[]> {
    const limit = parseInput(
      z.number().int().positive().max(MAX_TOMBSTONE_PAGE_SIZE),
      limitInput,
      "reconciliation limit",
    );
    const records = Object.values((await this.#store.read()).records)
      .filter(
        (record) =>
          isTerminalState(record.state) &&
          record.reconciliationRequestedAt !== undefined &&
          retainedThreadId(record) !== undefined,
      )
      .sort((left, right) => compareSnowflakes(left.source.messageId, right.source.messageId))
      .slice(0, limit)
      .map(frozenRecord);
    return Object.freeze(records);
  }

  async removeDeletedThreadTombstone(threadIdInput: string): Promise<void> {
    const threadId = parseInput(DiscordSnowflakeSchema, threadIdInput, "thread ID");
    await this.#store.transact((current) => {
      const entry = Object.entries(current.records).find(
        ([, record]) => isTerminalState(record.state) && retainedThreadId(record) === threadId,
      );
      if (entry === undefined) {
        throw notFound();
      }
      const [sourceMessageId] = entry;
      const { [sourceMessageId]: _removed, ...records } = current.records;
      return { document: { records, version: 1 }, result: undefined };
    });
  }

  async #transition(
    sourceMessageIdInput: string,
    state: "preparing" | "queued",
    updatedAtInput: string,
  ): Promise<void> {
    const sourceMessageId = parseInput(
      DiscordSnowflakeSchema,
      sourceMessageIdInput,
      "source message ID",
    );
    const updatedAt = parseInput(IsoTimestampSchema, updatedAtInput, "state timestamp");
    await this.#store.transact((current) => {
      const record = current.records[sourceMessageId];
      if (record === undefined) {
        throw notFound();
      }
      if (record.state === state) {
        return { document: current, result: undefined };
      }
      if (!legalTransitions[record.state].includes(state)) {
        throw conflict(`Progress observation cannot transition from ${record.state} to ${state}.`);
      }
      const next: ProgressObservationRecord = {
        ...withUpdatedAt(record, updatedAt),
        state,
      };
      return {
        document: {
          records: { ...current.records, [sourceMessageId]: next },
          version: 1,
        },
        result: undefined,
      };
    });
  }

  async #markDeliveryTerminal(
    sourceMessageIdInput: string,
    sequenceInput: number,
    status: "uncertain" | "failed",
    updatedAtInput: string,
  ): Promise<void> {
    const sourceMessageId = parseInput(
      DiscordSnowflakeSchema,
      sourceMessageIdInput,
      "source message ID",
    );
    const sequence = parseInput(z.number().int().positive(), sequenceInput, "delivery sequence");
    const updatedAt = parseInput(IsoTimestampSchema, updatedAtInput, "delivery timestamp");
    await this.#store.transact((current) => {
      const record = current.records[sourceMessageId];
      if (record === undefined) {
        throw notFound();
      }
      if (
        record.delivery.current?.status !== "sending" ||
        record.delivery.current.sequence !== sequence
      ) {
        throw conflict("Final delivery failure does not match the current sequence.");
      }
      const next: ProgressObservationRecord = {
        ...withUpdatedAt(record, updatedAt),
        delivery: {
          ...record.delivery,
          current: { sequence, status },
        },
      };
      return {
        document: {
          records: { ...current.records, [sourceMessageId]: next },
          version: 1,
        },
        result: undefined,
      };
    });
  }
}

export type { DiscordDeliveryReceipt, TurnProgressSource };
