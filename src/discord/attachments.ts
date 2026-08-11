import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  type FileHandle,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { BridgeError } from "../domain/errors.js";
import { DiscordSnowflakeSchema } from "../domain/schemas.js";
import {
  type LocalDiscordAttachment,
  MAX_DISCORD_ATTACHMENTS,
  MAX_DISCORD_FILE_BYTES,
  parseLocalDiscordAttachments,
  sanitizeAttachmentFilename,
} from "./format.js";

const DEFAULT_HEADER_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 15_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
const MAX_URL_CODE_UNITS = 16 * 1024;
const MAX_ORIGINAL_FILENAME_CODE_UNITS = 16 * 1024;
const MAX_CONTENT_TYPE_CODE_UNITS = 255;

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

const DiscordMessageAttachmentSchema = z
  .object({
    id: DiscordSnowflakeSchema,
    filename: z.string().min(1).max(MAX_ORIGINAL_FILENAME_CODE_UNITS),
    size: z.number().int().min(0).max(MAX_DISCORD_FILE_BYTES),
    contentType: z
      .string()
      .min(1)
      .max(MAX_CONTENT_TYPE_CODE_UNITS)
      .refine((value) => !hasControlCharacters(value))
      .optional(),
    url: z.string().min(1).max(MAX_URL_CODE_UNITS),
  })
  .strict();
const DiscordAttachmentBatchInputSchema = z
  .object({
    channelId: DiscordSnowflakeSchema,
    messageId: DiscordSnowflakeSchema,
    attachments: z
      .array(DiscordMessageAttachmentSchema)
      .min(1)
      .max(MAX_DISCORD_ATTACHMENTS)
      .refine(
        (attachments) => new Set(attachments.map(({ id }) => id)).size === attachments.length,
      ),
  })
  .strict();

export interface DiscordMessageAttachment {
  readonly id: string;
  readonly filename: string;
  readonly size: number;
  readonly contentType?: string;
  readonly url: string;
}

export interface DiscordAttachmentBatchInput {
  readonly channelId: string;
  readonly messageId: string;
  readonly attachments: readonly DiscordMessageAttachment[];
}

export interface DiscordAttachmentStorePort {
  initialize(): Promise<void>;
  persist(input: DiscordAttachmentBatchInput): Promise<readonly LocalDiscordAttachment[]>;
  stop(): Promise<void>;
}

export interface DiscordAttachmentStoreOptions {
  readonly inboxDirectory: string;
  readonly stagingDirectory: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly fileSystem?: Partial<DiscordAttachmentStoreFileSystem>;
  readonly headerTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
}

export interface DiscordAttachmentStoreFileSystem {
  readdir(path: string): Promise<string[]>;
  publishDirectory(source: string, destination: string): Promise<void>;
  syncDirectory(path: string): Promise<void>;
}

interface ValidatedAttachment {
  readonly id: string;
  readonly filename: string;
  readonly size: number;
  readonly contentType?: string;
  readonly url: string;
  readonly storedBasename: string;
}

interface ActiveBatch {
  readonly controller: AbortController;
  readonly promise: Promise<readonly LocalDiscordAttachment[]>;
}

interface CanonicalDirectory {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
}

type StoreState = "new" | "initializing" | "ready" | "stopped";

function inboundError(message: string): BridgeError {
  return new BridgeError(
    "INVALID_ARGUMENT",
    message,
    "Send a bounded Discord attachment and retry.",
  );
}

function runtimeError(message: string): BridgeError {
  return new BridgeError(
    "RUNTIME",
    message,
    "Retry the attachment or inspect non-secret runner diagnostics.",
  );
}

function configuredTimeout(value: number | undefined, fallback: number): number {
  const timeout = value ?? fallback;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_MS) {
    throw inboundError("Invalid Discord attachment timeout configuration.");
  }
  return timeout;
}

function hasUnsafeUrlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code > 0x7e || code === 0x5c || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function decodedDotSegment(segment: string): boolean {
  try {
    const decoded = decodeURIComponent(segment);
    return decoded === "." || decoded === "..";
  } catch {
    return true;
  }
}

function validateDiscordAttachmentUrl(
  urlInput: string,
  channelId: string,
  attachmentId: string,
): string {
  if (hasUnsafeUrlCharacters(urlInput)) {
    throw inboundError("Discord attachment URL is invalid.");
  }
  const raw = /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)(\/[^?#]*)(\?[^#]*)?$/u.exec(
    urlInput,
  );
  if (raw?.[1] === undefined || raw[2] === undefined) {
    throw inboundError("Discord attachment URL origin is not allowed.");
  }
  if (/%2f|%5c/iu.test(raw[2])) {
    throw inboundError("Discord attachment URL path is invalid.");
  }
  const rawSegments = raw[2].split("/");
  if (
    rawSegments.length !== 5 ||
    rawSegments[0] !== "" ||
    rawSegments[1] !== "attachments" ||
    rawSegments[2] !== channelId ||
    rawSegments[3] !== attachmentId ||
    rawSegments[4] === undefined ||
    rawSegments[4].length === 0 ||
    rawSegments.some(decodedDotSegment)
  ) {
    throw inboundError("Discord attachment URL path is invalid.");
  }

  let parsed: URL;
  try {
    parsed = new URL(urlInput);
  } catch {
    throw inboundError("Discord attachment URL is invalid.");
  }
  const parsedSegments = parsed.pathname.split("/");
  if (
    parsed.protocol !== "https:" ||
    (parsed.hostname !== "cdn.discordapp.com" && parsed.hostname !== "media.discordapp.net") ||
    parsed.hostname !== raw[1] ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.hash !== "" ||
    parsedSegments.length !== 5 ||
    parsedSegments[2] !== channelId ||
    parsedSegments[3] !== attachmentId
  ) {
    throw inboundError("Discord attachment URL is invalid.");
  }
  return parsed.href;
}

function parseBatch(input: unknown): {
  readonly channelId: string;
  readonly messageId: string;
  readonly attachments: readonly ValidatedAttachment[];
} {
  const parsed = DiscordAttachmentBatchInputSchema.safeParse(input);
  if (!parsed.success) {
    throw inboundError("Discord attachment metadata is invalid or oversized.");
  }
  return {
    channelId: parsed.data.channelId,
    messageId: parsed.data.messageId,
    attachments: parsed.data.attachments.map((attachment) => {
      const filename = sanitizeAttachmentFilename(attachment.filename);
      return Object.freeze({
        id: attachment.id,
        filename,
        size: attachment.size,
        ...(attachment.contentType === undefined ? {} : { contentType: attachment.contentType }),
        url: validateDiscordAttachmentUrl(attachment.url, parsed.data.channelId, attachment.id),
        storedBasename: `${attachment.id}-${filename}`,
      });
    }),
  };
}

function containsPath(parent: string, child: string): boolean {
  const difference = relative(parent, child);
  return difference === "" || (!difference.startsWith(`..${sep}`) && difference !== "..");
}

function sameDirectory(left: CanonicalDirectory, right: CanonicalDirectory): boolean {
  return left.path === right.path && left.device === right.device && left.inode === right.inode;
}

async function canonicalDirectory(pathInput: string): Promise<CanonicalDirectory> {
  if (!isAbsolute(pathInput)) {
    throw runtimeError("Discord attachment directory must be absolute.");
  }
  let path: string;
  try {
    path = await realpath(pathInput);
    const metadata = await stat(path);
    if (!metadata.isDirectory() || resolve(path) !== path) {
      throw runtimeError("Discord attachment directory is invalid.");
    }
    return { path, device: metadata.dev, inode: metadata.ino };
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw runtimeError("Discord attachment directory is unavailable.");
  }
}

function abortReason(signal: AbortSignal): BridgeError {
  return signal.reason instanceof BridgeError
    ? signal.reason
    : runtimeError("Discord attachment operation was cancelled.");
}

function awaitWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = () => rejectPromise(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        rejectPromise(error);
      },
    );
  });
}

function timeoutAbort(
  controller: AbortController,
  milliseconds: number,
  message: string,
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => controller.abort(runtimeError(message)), milliseconds);
  timer.unref();
  return timer;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (written.bytesWritten <= 0) {
      throw runtimeError("Discord attachment file write made no progress.");
    }
    offset += written.bytesWritten;
  }
}

function parseContentLength(response: Response, expected: number): void {
  const value = response.headers.get("content-length");
  if (value === null) return;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw runtimeError("Discord attachment response length is invalid.");
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length !== expected || length > MAX_DISCORD_FILE_BYTES) {
    throw runtimeError("Discord attachment response length did not match metadata.");
  }
}

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  if (handle === undefined) return;
  await handle.close().catch(() => undefined);
}

export class DiscordAttachmentStore implements DiscordAttachmentStorePort {
  private readonly inboxInput: string;
  private readonly stagingInput: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly fileSystem: DiscordAttachmentStoreFileSystem;
  private readonly headerTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly totalTimeoutMs: number;
  private readonly active = new Set<ActiveBatch>();
  private state: StoreState = "new";
  private inboxDirectory: CanonicalDirectory | undefined;
  private stagingDirectory: CanonicalDirectory | undefined;
  private initialization: Promise<void> | undefined;

  constructor(options: DiscordAttachmentStoreOptions) {
    if (typeof options !== "object" || options === null) {
      throw inboundError("Discord attachment store options are invalid.");
    }
    this.inboxInput = options.inboxDirectory;
    this.stagingInput = options.stagingDirectory;
    this.fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.fetch !== "function") {
      throw inboundError("Discord attachment fetch implementation is invalid.");
    }
    this.fileSystem = {
      readdir: options.fileSystem?.readdir ?? ((path) => readdir(path)),
      publishDirectory: options.fileSystem?.publishDirectory ?? rename,
      syncDirectory: options.fileSystem?.syncDirectory ?? syncDirectory,
    };
    this.headerTimeoutMs = configuredTimeout(options.headerTimeoutMs, DEFAULT_HEADER_TIMEOUT_MS);
    this.idleTimeoutMs = configuredTimeout(options.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS);
    this.totalTimeoutMs = configuredTimeout(options.totalTimeoutMs, DEFAULT_TOTAL_TIMEOUT_MS);
    if (this.headerTimeoutMs > this.totalTimeoutMs || this.idleTimeoutMs > this.totalTimeoutMs) {
      throw inboundError("Discord attachment timeouts exceed the total timeout.");
    }
  }

  initialize(): Promise<void> {
    if (this.state === "ready") return Promise.resolve();
    if (this.state === "stopped") {
      return Promise.reject(runtimeError("Discord attachment store is stopped."));
    }
    if (this.initialization !== undefined) return this.initialization;
    this.state = "initializing";
    const initialization = this.initializeStore().finally(() => {
      if (this.initialization === initialization) this.initialization = undefined;
    });
    this.initialization = initialization;
    return initialization;
  }

  private async initializeStore(): Promise<void> {
    try {
      const [inbox, staging] = await Promise.all([
        canonicalDirectory(this.inboxInput),
        canonicalDirectory(this.stagingInput),
      ]);
      if (
        inbox.device !== staging.device ||
        containsPath(inbox.path, staging.path) ||
        containsPath(staging.path, inbox.path)
      ) {
        throw runtimeError("Discord attachment directories cannot publish atomically.");
      }
      const entries = await this.fileSystem.readdir(staging.path);
      if (this.state !== "initializing") {
        throw runtimeError("Discord attachment store initialization was cancelled.");
      }
      for (const entry of entries) {
        await rm(join(staging.path, entry), { force: true, recursive: true });
      }
      if (this.state !== "initializing") {
        throw runtimeError("Discord attachment store initialization was cancelled.");
      }
      this.inboxDirectory = inbox;
      this.stagingDirectory = staging;
      this.state = "ready";
    } catch (error) {
      if (this.state !== "stopped") this.state = "new";
      throw error;
    }
  }

  persist(input: DiscordAttachmentBatchInput): Promise<readonly LocalDiscordAttachment[]> {
    if (
      this.state !== "ready" ||
      this.inboxDirectory === undefined ||
      this.stagingDirectory === undefined
    ) {
      return Promise.reject(runtimeError("Discord attachment store is not accepting files."));
    }
    let parsed: ReturnType<typeof parseBatch>;
    try {
      parsed = parseBatch(input);
    } catch (error) {
      return Promise.reject(error);
    }
    const controller = new AbortController();
    const record = {} as ActiveBatch;
    const promise = this.persistBatch(parsed, controller).finally(() => {
      this.active.delete(record);
    });
    Object.assign(record, { controller, promise });
    this.active.add(record);
    return promise;
  }

  async stop(): Promise<void> {
    if (this.state === "stopped") return;
    this.state = "stopped";
    await this.initialization?.catch(() => undefined);
    for (const { controller } of this.active) {
      controller.abort(runtimeError("Discord attachment store is stopping."));
    }
    await Promise.allSettled([...this.active].map(({ promise }) => promise));
  }

  private async persistBatch(
    input: ReturnType<typeof parseBatch>,
    controller: AbortController,
  ): Promise<readonly LocalDiscordAttachment[]> {
    const inboxIdentity = this.inboxDirectory;
    const stagingIdentity = this.stagingDirectory;
    if (inboxIdentity === undefined || stagingIdentity === undefined) {
      throw runtimeError("Discord attachment store is unavailable.");
    }
    await this.revalidateDirectories(inboxIdentity, stagingIdentity);
    const inbox = inboxIdentity.path;
    const stagingRoot = stagingIdentity.path;
    const totalTimer = timeoutAbort(
      controller,
      this.totalTimeoutMs,
      "Discord attachment download timed out.",
    );
    const batchName = `${input.messageId}-${randomUUID()}`;
    const stagingBatch = join(stagingRoot, batchName);
    const publishedBatch = join(inbox, batchName);
    let published = false;
    try {
      await mkdir(stagingBatch, { mode: 0o700 });
      for (const attachment of input.attachments) {
        await this.download(stagingBatch, attachment, controller);
      }
      await this.fileSystem.syncDirectory(stagingBatch);
      await this.revalidateDirectories(inboxIdentity, stagingIdentity);
      if (controller.signal.aborted) throw abortReason(controller.signal);
      if (!containsPath(inbox, publishedBatch) || basename(publishedBatch) !== batchName) {
        throw runtimeError("Discord attachment publication target is invalid.");
      }
      await this.fileSystem.publishDirectory(stagingBatch, publishedBatch);
      published = true;
      await this.fileSystem.syncDirectory(inbox);
      const records = await Promise.all(
        input.attachments.map(async (attachment) => ({
          id: attachment.id,
          filename: attachment.filename,
          size: attachment.size,
          ...(attachment.contentType === undefined ? {} : { contentType: attachment.contentType }),
          localPath: await realpath(join(publishedBatch, attachment.storedBasename)),
        })),
      );
      return parseLocalDiscordAttachments(records);
    } catch (error) {
      if (!published) {
        await rm(stagingBatch, { force: true, recursive: true }).catch(() => undefined);
      }
      if (error instanceof BridgeError) throw error;
      throw runtimeError("Discord attachment batch could not be stored.");
    } finally {
      clearTimeout(totalTimer);
    }
  }

  private async revalidateDirectories(
    expectedInbox: CanonicalDirectory,
    expectedStaging: CanonicalDirectory,
  ): Promise<void> {
    const [inbox, staging] = await Promise.all([
      canonicalDirectory(this.inboxInput),
      canonicalDirectory(this.stagingInput),
    ]);
    if (
      !sameDirectory(inbox, expectedInbox) ||
      !sameDirectory(staging, expectedStaging) ||
      inbox.device !== staging.device
    ) {
      throw runtimeError("Discord attachment directory identity changed.");
    }
  }

  private async download(
    stagingBatch: string,
    attachment: ValidatedAttachment,
    controller: AbortController,
  ): Promise<void> {
    const signal = controller.signal;
    const headerTimer = timeoutAbort(
      controller,
      this.headerTimeoutMs,
      "Discord attachment response headers timed out.",
    );
    let response: Response;
    try {
      response = await awaitWithSignal(
        this.fetch(attachment.url, { redirect: "error", signal }),
        signal,
      );
    } catch {
      if (signal.aborted) throw abortReason(signal);
      throw runtimeError("Discord attachment download failed.");
    } finally {
      clearTimeout(headerTimer);
    }
    if (!response.ok || response.body === null) {
      throw runtimeError("Discord attachment response was rejected.");
    }
    parseContentLength(response, attachment.size);

    const finalPath = join(stagingBatch, attachment.storedBasename);
    const temporaryPath = `${finalPath}.part-${randomUUID()}`;
    let handle: FileHandle | undefined;
    const reader = response.body.getReader();
    let completed = false;
    try {
      handle = await open(
        temporaryPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      );
      let received = 0;
      for (;;) {
        const idleTimer = timeoutAbort(
          controller,
          this.idleTimeoutMs,
          "Discord attachment response body timed out.",
        );
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await awaitWithSignal(reader.read(), signal);
        } finally {
          clearTimeout(idleTimer);
        }
        if (chunk.done) break;
        received += chunk.value.byteLength;
        if (received > attachment.size || received > MAX_DISCORD_FILE_BYTES) {
          throw runtimeError("Discord attachment response exceeded its byte limit.");
        }
        await awaitWithSignal(writeAll(handle, chunk.value), signal);
      }
      if (received !== attachment.size) {
        throw runtimeError("Discord attachment response size did not match metadata.");
      }
      await awaitWithSignal(handle.sync(), signal);
      await handle.close();
      handle = undefined;
      await awaitWithSignal(rename(temporaryPath, finalPath), signal);
      completed = true;
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      if (error instanceof BridgeError) throw error;
      throw runtimeError("Discord attachment body could not be stored.");
    } finally {
      try {
        void reader.cancel().catch(() => undefined);
      } catch {
        // The retained file and staging cleanup below do not depend on remote cancellation.
      }
      await closeQuietly(handle);
      if (!completed) await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}
