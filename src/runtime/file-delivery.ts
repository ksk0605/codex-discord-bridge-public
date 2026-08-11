import type { ServerRequestResult } from "../app-server/protocol.js";
import {
  type AuthorizedDiscordSendFileArguments,
  parseDiscordSendFileArguments,
} from "../app-server/session.js";
import type { AuthorizedOutboundFile } from "../manager/workspaces.js";

const DEFAULT_MAX_FILES = 10;
const DEFAULT_MAX_CALLS = 32;
const MAX_CALL_ID_CODE_UNITS = 256;

type DynamicFileResult = ServerRequestResult<"item/tool/call">;

export interface DynamicFileCall {
  readonly callId: string;
  readonly arguments: unknown;
}

export interface TurnFileDeliveryCoordinatorOptions {
  readonly authorize: (input: unknown) => Promise<AuthorizedDiscordSendFileArguments>;
  readonly upload: (
    file: AuthorizedOutboundFile,
    message: string | undefined,
    signal: AbortSignal,
  ) => Promise<unknown>;
  readonly waitFor?: (operation: Promise<unknown>, timeoutMs: number) => Promise<boolean>;
  readonly maxFiles?: number;
  readonly maxCalls?: number;
}

interface CallRecord {
  readonly argumentsKey: string;
  readonly result: Promise<DynamicFileResult>;
}

interface PathDelivery {
  readonly file: AuthorizedOutboundFile;
  readonly result: Promise<DynamicFileResult>;
}

function successResult(): DynamicFileResult {
  return {
    success: true,
    contentItems: [{ type: "inputText", text: "File sent." }],
  };
}

function failureResult(): DynamicFileResult {
  return {
    success: false,
    contentItems: [{ type: "inputText", text: "File could not be sent." }],
  };
}

function configuredLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("File delivery limits must be positive safe integers.");
  }
  return value;
}

function validCallId(value: string): boolean {
  if (value.length === 0 || value.length > MAX_CALL_ID_CODE_UNITS) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return true;
}

async function defaultWaitFor(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
    throw new TypeError("File delivery timeout must be a non-negative safe integer.");
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (completed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(completed);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    void operation.then(
      () => finish(true),
      () => finish(true),
    );
  });
}

export class TurnFileDeliveryCoordinator {
  readonly #authorize: TurnFileDeliveryCoordinatorOptions["authorize"];
  readonly #upload: TurnFileDeliveryCoordinatorOptions["upload"];
  readonly #waitFor: NonNullable<TurnFileDeliveryCoordinatorOptions["waitFor"]>;
  readonly #maxFiles: number;
  readonly #maxCalls: number;
  readonly #abortController = new AbortController();
  readonly #calls = new Map<string, CallRecord>();
  readonly #pathDeliveries = new Map<string, PathDelivery>();
  readonly #successfulPaths = new Set<string>();
  readonly #activeFiles = new Set<AuthorizedOutboundFile>();
  readonly #closedFiles = new Set<AuthorizedOutboundFile>();
  #accepting = true;

  constructor(options: TurnFileDeliveryCoordinatorOptions) {
    this.#authorize = options.authorize;
    this.#upload = options.upload;
    this.#waitFor = options.waitFor ?? defaultWaitFor;
    this.#maxFiles = configuredLimit(options.maxFiles, DEFAULT_MAX_FILES);
    this.#maxCalls = configuredLimit(options.maxCalls, DEFAULT_MAX_CALLS);
  }

  handle(call: DynamicFileCall): Promise<DynamicFileResult> {
    if (!validCallId(call.callId)) return Promise.resolve(failureResult());

    let parsed: ReturnType<typeof parseDiscordSendFileArguments>;
    try {
      parsed = parseDiscordSendFileArguments(call.arguments);
    } catch {
      return Promise.resolve(failureResult());
    }

    const argumentsKey = JSON.stringify(parsed);
    const existing = this.#calls.get(call.callId);
    if (existing !== undefined) {
      return existing.argumentsKey === argumentsKey
        ? existing.result
        : Promise.resolve(failureResult());
    }
    if (!this.#accepting || this.#calls.size >= this.#maxCalls) {
      return Promise.resolve(failureResult());
    }

    const result = Promise.resolve().then(() => this.#deliver(call.arguments));
    this.#calls.set(call.callId, { argumentsKey, result });
    return result;
  }

  successfulPaths(): readonly string[] {
    return Object.freeze([...this.#successfulPaths]);
  }

  closeToNewRequests(): void {
    this.#accepting = false;
  }

  waitForSettled(timeoutMs: number): Promise<boolean> {
    const pending = Promise.allSettled([...this.#calls.values()].map(({ result }) => result));
    return this.#waitFor(pending, timeoutMs);
  }

  async abortAndWait(timeoutMs: number): Promise<boolean> {
    this.closeToNewRequests();
    this.#abortController.abort();
    const descriptorClosures = [...this.#activeFiles].map((file) => this.#closeFile(file));
    const pending = Promise.allSettled([
      ...[...this.#calls.values()].map(({ result }) => result),
      ...descriptorClosures,
    ]);
    return this.#waitFor(pending, timeoutMs);
  }

  forceRelease(): void {
    this.closeToNewRequests();
    this.#abortController.abort();
    for (const file of this.#activeFiles) void this.#closeFile(file);
    this.#calls.clear();
    this.#pathDeliveries.clear();
    this.#successfulPaths.clear();
    this.#activeFiles.clear();
  }

  async #deliver(input: unknown): Promise<DynamicFileResult> {
    let authorized: AuthorizedDiscordSendFileArguments;
    try {
      authorized = await this.#authorize(input);
    } catch {
      return failureResult();
    }

    const { file, message } = authorized;
    this.#activeFiles.add(file);
    if (!this.#accepting || this.#abortController.signal.aborted) {
      await this.#closeFile(file);
      return failureResult();
    }

    const existing = this.#pathDeliveries.get(file.canonicalPath);
    if (existing !== undefined) {
      if (existing.file !== file) await this.#closeFile(file);
      return existing.result;
    }
    if (this.#pathDeliveries.size >= this.#maxFiles) {
      await this.#closeFile(file);
      return failureResult();
    }

    const delivery = this.#uploadAndClose(file, message);
    const record = { file, result: delivery };
    this.#pathDeliveries.set(file.canonicalPath, record);
    return delivery;
  }

  async #uploadAndClose(
    file: AuthorizedOutboundFile,
    message: string | undefined,
  ): Promise<DynamicFileResult> {
    let succeeded = false;
    try {
      await this.#upload(file, message, this.#abortController.signal);
      succeeded = true;
      this.#successfulPaths.add(file.canonicalPath);
      return successResult();
    } catch {
      return failureResult();
    } finally {
      await this.#closeFile(file);
      if (!succeeded) {
        const current = this.#pathDeliveries.get(file.canonicalPath);
        if (current?.file === file) this.#pathDeliveries.delete(file.canonicalPath);
      }
    }
  }

  async #closeFile(file: AuthorizedOutboundFile): Promise<void> {
    this.#activeFiles.delete(file);
    if (this.#closedFiles.has(file)) return;
    this.#closedFiles.add(file);
    try {
      await file.close();
    } catch {
      // The retained descriptor is considered spent even when close reports an error.
    }
  }
}
