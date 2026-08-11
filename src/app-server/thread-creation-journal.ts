import { isAbsolute } from "node:path";
import { z } from "zod";
import { BridgeError } from "../domain/errors.js";
import { IdentifierSchema, IsoTimestampSchema, ThreadIdSchema } from "../domain/schemas.js";
import { AtomicJsonStore } from "../storage/atomic-json.js";

export const DEFAULT_MAX_ACTIVE_THREAD_CREATION_RECORDS = 1_000;
export const DEFAULT_MAX_TOTAL_THREAD_CREATION_RECORDS = 100_000;
const MAX_CWD_BYTES = 16 * 1024;
const MAX_CONFIGURED_RECORDS = 1_000_000;

const JournalCwdSchema = z
  .string()
  .min(1)
  .max(MAX_CWD_BYTES)
  .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_CWD_BYTES)
  .refine((value) => isAbsolute(value) && !hasControlCharacters(value));

const ThreadCreationBaseSchema = z.object({
  operationId: IdentifierSchema,
  cwd: JournalCwdSchema,
  startedAt: IsoTimestampSchema,
});

export const ThreadCreationRecordSchema = z.discriminatedUnion("status", [
  ThreadCreationBaseSchema.extend({ status: z.literal("pending") }).strict(),
  ThreadCreationBaseSchema.extend({ status: z.literal("ambiguous") }).strict(),
  ThreadCreationBaseSchema.extend({ status: z.literal("not-sent") }).strict(),
  ThreadCreationBaseSchema.extend({
    status: z.literal("confirmed"),
    threadId: ThreadIdSchema,
  }).strict(),
  ThreadCreationBaseSchema.extend({
    status: z.literal("acknowledged"),
    threadId: ThreadIdSchema.optional(),
  }).strict(),
]);

const ThreadCreationBeginSchema = ThreadCreationBaseSchema.strict();
const AcknowledgeSchema = z.union([
  z.object({ operationId: IdentifierSchema }).strict(),
  z.object({ threadId: ThreadIdSchema }).strict(),
]);

export type ThreadCreationRecord = z.infer<typeof ThreadCreationRecordSchema>;
export type ThreadCreationBegin = z.infer<typeof ThreadCreationBeginSchema>;
export type ThreadCreationAcknowledgement = z.infer<typeof AcknowledgeSchema>;

export interface ThreadCreationJournal {
  begin(record: ThreadCreationBegin): Promise<void>;
  markAmbiguous(operationId: string): Promise<void>;
  markNotSent(operationId: string): Promise<void>;
  confirm(operationId: string, threadId: string): Promise<void>;
  get(operationId: string): Promise<ThreadCreationRecord | undefined>;
  list(): Promise<readonly ThreadCreationRecord[]>;
  acknowledge(reference: ThreadCreationAcknowledgement): Promise<void>;
}

export interface AtomicThreadCreationJournalOptions {
  readonly filePath: string;
  readonly maxActiveRecords?: number;
  readonly maxTotalRecords?: number;
}

interface ThreadCreationJournalDocument {
  readonly version: 1;
  readonly records: Record<string, ThreadCreationRecord>;
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function parseInput<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new BridgeError("INVALID_ARGUMENT", `Invalid thread creation journal ${label}.`);
  }
  return parsed.data;
}

function conflict(message: string): BridgeError {
  return new BridgeError(
    "CONFLICT",
    message,
    "Inspect and reconcile the durable thread creation journal before retrying.",
  );
}

function notFound(): BridgeError {
  return new BridgeError(
    "NOT_FOUND",
    "Thread creation journal record was not found.",
    "List pending thread creation records and select an exact operation or thread ID.",
  );
}

function configuredRecordLimit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_CONFIGURED_RECORDS) {
    throw new BridgeError("INVALID_ARGUMENT", `Invalid thread creation journal ${name}.`);
  }
  return value;
}

function activeRecordCount(records: Record<string, ThreadCreationRecord>): number {
  return Object.values(records).filter(
    (record) =>
      record.status === "pending" || record.status === "ambiguous" || record.status === "confirmed",
  ).length;
}

function retainedThreadId(record: ThreadCreationRecord): string | undefined {
  if (record.status === "confirmed" || record.status === "acknowledged") {
    return record.threadId;
  }
  return undefined;
}

function documentSchema(
  maxActiveRecords: number,
  maxTotalRecords: number,
): z.ZodType<ThreadCreationJournalDocument> {
  return z
    .object({
      version: z.literal(1),
      records: z.record(IdentifierSchema, ThreadCreationRecordSchema),
    })
    .strict()
    .superRefine((document, context) => {
      if (Object.keys(document.records).length > maxTotalRecords) {
        context.addIssue({
          code: "custom",
          message: "Thread creation total record limit exceeded",
        });
      }
      if (activeRecordCount(document.records) > maxActiveRecords) {
        context.addIssue({
          code: "custom",
          message: "Thread creation active record limit exceeded",
        });
      }
      const threadOwners = new Map<string, string>();
      for (const [operationId, record] of Object.entries(document.records)) {
        if (operationId !== record.operationId) {
          context.addIssue({
            code: "custom",
            message: "Thread creation record key mismatch",
            path: ["records", operationId, "operationId"],
          });
        }
        const threadId = retainedThreadId(record);
        if (threadId !== undefined) {
          const owner = threadOwners.get(threadId);
          if (owner !== undefined && owner !== operationId) {
            context.addIssue({
              code: "custom",
              message: "Thread creation retained thread ID is duplicated",
              path: ["records", operationId, "threadId"],
            });
          } else {
            threadOwners.set(threadId, operationId);
          }
        }
      }
    });
}

function freezeRecord(record: ThreadCreationRecord): ThreadCreationRecord {
  return Object.freeze({ ...record });
}

export class AtomicThreadCreationJournal implements ThreadCreationJournal {
  readonly #store: AtomicJsonStore<ThreadCreationJournalDocument>;
  readonly #maxActiveRecords: number;
  readonly #maxTotalRecords: number;

  constructor(options: AtomicThreadCreationJournalOptions) {
    if (!isAbsolute(options.filePath) || hasControlCharacters(options.filePath)) {
      throw new BridgeError("INVALID_ARGUMENT", "Invalid thread creation journal path.");
    }
    this.#maxActiveRecords = configuredRecordLimit(
      "maxActiveRecords",
      options.maxActiveRecords ?? DEFAULT_MAX_ACTIVE_THREAD_CREATION_RECORDS,
    );
    this.#maxTotalRecords = configuredRecordLimit(
      "maxTotalRecords",
      options.maxTotalRecords ?? DEFAULT_MAX_TOTAL_THREAD_CREATION_RECORDS,
    );
    if (this.#maxActiveRecords > this.#maxTotalRecords) {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        "Thread creation maxActiveRecords cannot exceed maxTotalRecords.",
      );
    }
    this.#store = new AtomicJsonStore({
      filePath: options.filePath,
      schema: documentSchema(this.#maxActiveRecords, this.#maxTotalRecords),
      initialDocument: () => ({ version: 1, records: {} }),
    });
  }

  async begin(recordInput: ThreadCreationBegin): Promise<void> {
    const record = parseInput(ThreadCreationBeginSchema, recordInput, "begin record");
    await this.#store.transact((current) => {
      if (Object.hasOwn(current.records, record.operationId)) {
        throw conflict("Thread creation operation already exists.");
      }
      if (Object.keys(current.records).length >= this.#maxTotalRecords) {
        throw new BridgeError(
          "CONFLICT",
          "Thread creation journal total durable record limit was reached.",
          "Capacity is finite because terminal tombstones are retained to prevent creation-key reuse; reconcile capacity and explicitly raise maxTotalRecords before creating another thread.",
        );
      }
      if (activeRecordCount(current.records) >= this.#maxActiveRecords) {
        throw conflict("Thread creation journal active record limit was reached.");
      }
      return {
        document: {
          version: 1,
          records: {
            ...current.records,
            [record.operationId]: { ...record, status: "pending" },
          },
        },
        result: undefined,
      };
    });
  }

  async markAmbiguous(operationIdInput: string): Promise<void> {
    const operationId = parseInput(IdentifierSchema, operationIdInput, "operation ID");
    await this.#store.transact((current) => {
      const record = current.records[operationId];
      if (record === undefined) {
        throw notFound();
      }
      if (record.status !== "pending" && record.status !== "ambiguous") {
        throw conflict("A terminal thread creation cannot become ambiguous.");
      }
      return {
        document: {
          version: 1,
          records: {
            ...current.records,
            [operationId]: { ...record, status: "ambiguous" },
          },
        },
        result: undefined,
      };
    });
  }

  async markNotSent(operationIdInput: string): Promise<void> {
    const operationId = parseInput(IdentifierSchema, operationIdInput, "operation ID");
    await this.#store.transact((current) => {
      const record = current.records[operationId];
      if (record === undefined) {
        throw notFound();
      }
      if (record.status === "not-sent") {
        return { document: current, result: undefined };
      }
      if (record.status !== "pending") {
        throw conflict("Only a pending thread creation can be marked not sent.");
      }
      return {
        document: {
          version: 1,
          records: {
            ...current.records,
            [operationId]: { ...record, status: "not-sent" },
          },
        },
        result: undefined,
      };
    });
  }

  async confirm(operationIdInput: string, threadIdInput: string): Promise<void> {
    const operationId = parseInput(IdentifierSchema, operationIdInput, "operation ID");
    const threadId = parseInput(ThreadIdSchema, threadIdInput, "thread ID");
    await this.#store.transact((current) => {
      const record = current.records[operationId];
      if (record === undefined) {
        throw notFound();
      }
      if (record.status === "confirmed") {
        if (record.threadId === threadId) {
          return { document: current, result: undefined };
        }
        throw conflict("Thread creation operation is already confirmed with another thread.");
      }
      if (record.status !== "pending" && record.status !== "ambiguous") {
        throw conflict("A terminal thread creation cannot be confirmed.");
      }
      if (
        Object.values(current.records).some(
          (candidate) =>
            candidate.operationId !== operationId && retainedThreadId(candidate) === threadId,
        )
      ) {
        throw conflict("Codex thread is already retained by another creation operation.");
      }
      return {
        document: {
          version: 1,
          records: {
            ...current.records,
            [operationId]: { ...record, status: "confirmed", threadId },
          },
        },
        result: undefined,
      };
    });
  }

  async get(operationIdInput: string): Promise<ThreadCreationRecord | undefined> {
    const operationId = parseInput(IdentifierSchema, operationIdInput, "operation ID");
    const record = (await this.#store.read()).records[operationId];
    return record === undefined ? undefined : freezeRecord(record);
  }

  async list(): Promise<readonly ThreadCreationRecord[]> {
    const records = Object.values((await this.#store.read()).records).map(freezeRecord);
    return Object.freeze(records);
  }

  async acknowledge(referenceInput: ThreadCreationAcknowledgement): Promise<void> {
    const reference = parseInput(AcknowledgeSchema, referenceInput, "acknowledgement");
    await this.#store.transact((current) => {
      const operationId =
        "operationId" in reference
          ? reference.operationId
          : Object.values(current.records).find(
              (record) =>
                (record.status === "confirmed" || record.status === "acknowledged") &&
                record.threadId === reference.threadId,
            )?.operationId;
      if (operationId === undefined) {
        throw notFound();
      }
      const record = current.records[operationId];
      if (record === undefined) {
        throw notFound();
      }
      if (record.status === "acknowledged") {
        return { document: current, result: undefined };
      }
      if (record.status !== "confirmed" && record.status !== "ambiguous") {
        throw conflict("Only a confirmed or reconciled ambiguous creation can be acknowledged.");
      }
      return {
        document: {
          version: 1,
          records: {
            ...current.records,
            [operationId]: { ...record, status: "acknowledged" },
          },
        },
        result: undefined,
      };
    });
  }
}
