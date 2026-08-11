import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { type Readable, Transform, type TransformCallback, type Writable } from "node:stream";
import type { ZodType } from "zod";
import { BridgeError } from "../domain/errors.js";
import {
  type ApprovalRequestMethod,
  approvalResponseForRequest,
  type ClientNotificationMethod,
  type ClientNotificationParams,
  type ClientRequestMethod,
  type ClientRequestParams,
  type ClientRequestResult,
  clientNotificationSchemas,
  clientRequestSchemas,
  type MvpApprovalAction,
  methodNotSupportedResponse,
  type NonApprovalServerRequestMethod,
  ProtocolErrorSchema,
  RequestIdSchema,
  requestFailedResponse,
  type ServerNotificationMethod,
  type ServerNotificationParams,
  type ServerRequestMethod,
  type ServerRequestParams,
  type ServerRequestResult,
  serverNotificationSchemas,
  serverRequestSchemas,
} from "./protocol.js";

export type AppServerDebugEvent =
  | { direction: "inbound"; kind: "unknown-notification"; method: string }
  | {
      direction: "inbound";
      kind: "invalid-progress-notification";
      method: BestEffortProgressNotificationMethod;
    }
  | { direction: "inbound"; idType: "number" | "string"; kind: "late-response" };

const BEST_EFFORT_PROGRESS_NOTIFICATION_METHODS = [
  "turn/started",
  "item/agentMessage/delta",
  "error",
  "turn/plan/updated",
  "turn/diff/updated",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/commandExecution/outputDelta",
  "warning",
] as const satisfies readonly ServerNotificationMethod[];
type BestEffortProgressNotificationMethod =
  (typeof BEST_EFFORT_PROGRESS_NOTIFICATION_METHODS)[number];
const bestEffortProgressNotificationMethods = new Set<ServerNotificationMethod>(
  BEST_EFFORT_PROGRESS_NOTIFICATION_METHODS,
);

export interface AppServerClientOptions {
  input: Readable;
  output: Writable;
  defaultRequestTimeoutMs?: number;
  writeStallTimeoutMs?: number;
  maxLineBytes?: number;
  initialRequestId?: number;
  maxPendingRequests?: number;
  maxMessageBytes?: number;
  maxQueuedWrites?: number;
  maxQueuedWriteBytes?: number;
  maxRetiredRequestIds?: number;
  maxActiveServerRequests?: number;
  debugLogger?: (event: AppServerDebugEvent) => void;
}

export interface AppServerRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type AppServerRequestDelivery = "not-sent" | "remote-rejected" | "sent-unconfirmed";

export class AppServerRequestError extends BridgeError {
  override readonly name = "AppServerRequestError";

  constructor(
    code: BridgeError["code"],
    message: string,
    readonly delivery: AppServerRequestDelivery,
    remediation?: string,
    options?: ErrorOptions,
  ) {
    super(code, message, remediation, options);
  }
}

export function appServerRequestDelivery(error: unknown): AppServerRequestDelivery | undefined {
  return error instanceof AppServerRequestError ? error.delivery : undefined;
}

type NotificationListener<Method extends ServerNotificationMethod> = (
  params: ServerNotificationParams<Method>,
) => void;
type ServerRequestHandler<Method extends NonApprovalServerRequestMethod> = (
  params: ServerRequestParams<Method>,
) => Promise<ServerRequestResult<Method>> | ServerRequestResult<Method>;
export interface ApprovalRequestContext<Method extends ApprovalRequestMethod> {
  readonly id: string | number;
  readonly method: Method;
}
type ApprovalRequestHandler<Method extends ApprovalRequestMethod> = (
  params: ServerRequestParams<Method>,
  context: ApprovalRequestContext<Method>,
) => Promise<MvpApprovalAction> | MvpApprovalAction;

interface PendingRequest {
  method: ClientRequestMethod;
  resultSchema: ZodType;
  resolve: (value: unknown) => void;
  reject: (error: BridgeError) => void;
  timer?: NodeJS.Timeout;
  signal?: AbortSignal;
  abortListener?: () => void;
  sent: boolean;
  settled: boolean;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_WRITE_STALL_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_PENDING_REQUESTS = 1_024;
const DEFAULT_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_QUEUED_WRITES = 1_024;
const DEFAULT_MAX_QUEUED_WRITE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_RETIRED_REQUEST_IDS = 4_096;
const DEFAULT_MAX_ACTIVE_SERVER_REQUESTS = 128;
const MAX_TIMER_MS = 2_147_483_647;
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const MAX_QUEUED_WRITE_BYTES = 64 * 1024 * 1024;
const MAX_COLLECTION_LIMIT = 1_000_000;

interface SerializedMessage {
  line: string;
  bytes: number;
}

interface QueuedWriteEntry {
  line: string;
  bytes: number;
  requestKey?: string;
  onHandoff?: () => void;
  previous: QueuedWriteEntry | undefined;
  next: QueuedWriteEntry | undefined;
  state: "queued" | "writing" | "settled";
  resolve: () => void;
  reject: (error: BridgeError) => void;
}

function positiveSafeInteger(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new BridgeError("INVALID_ARGUMENT", `Invalid App Server client option ${name}.`);
  }
  return value;
}

class GuardedLineTransform extends Transform {
  private lineBytes = 0;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(private readonly maxLineBytes: number) {
    super();
  }

  override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    try {
      this.decoder.decode(buffer, { stream: true });
      for (const byte of buffer) {
        if (byte === 0x0a) {
          this.lineBytes = 0;
        } else {
          this.lineBytes += 1;
          if (this.lineBytes > this.maxLineBytes) {
            callback(new Error("App Server line exceeded byte limit"));
            return;
          }
        }
      }
      callback(null, buffer);
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      this.decoder.decode();
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }
}

function requestKey(id: string | number): string {
  return `${typeof id}:${String(id)}`;
}

function runtimeError(message: string, cause?: unknown): BridgeError {
  return new BridgeError(
    "RUNTIME",
    message,
    "Restart the Codex App Server process and retry the operation.",
    cause === undefined ? undefined : { cause },
  );
}

function timeoutError(method: string, delivery: "not-sent" | "sent-unconfirmed"): BridgeError {
  return new AppServerRequestError(
    "TIMEOUT",
    `Codex App Server request ${method} timed out.`,
    delivery,
    "Retry the operation or restart the Codex App Server process.",
  );
}

function classifiedRequestError(
  error: BridgeError,
  delivery: AppServerRequestDelivery,
): AppServerRequestError {
  if (error instanceof AppServerRequestError && error.delivery === delivery) {
    return error;
  }
  return new AppServerRequestError(
    error.code,
    error.message,
    delivery,
    error.remediation,
    error.cause === undefined ? undefined : { cause: new Error("App Server request failed.") },
  );
}

function assertJsonSerializable(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Non-finite number");
    }
    return;
  }
  if (typeof value !== "object") {
    throw new Error("Unsupported JSON value");
  }
  if (ancestors.has(value)) {
    throw new Error("Circular JSON value");
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error("Unsupported JSON object");
  }
  ancestors.add(value);
  for (const entry of Array.isArray(value) ? value : Object.values(value)) {
    assertJsonSerializable(entry, ancestors);
  }
  ancestors.delete(value);
}

export class AppServerClient {
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly defaultRequestTimeoutMs: number;
  private readonly writeStallTimeoutMs: number;
  private readonly maxPendingRequests: number;
  private readonly maxMessageBytes: number;
  private readonly maxQueuedWrites: number;
  private readonly maxQueuedWriteBytes: number;
  private readonly maxRetiredRequestIds: number;
  private readonly maxActiveServerRequests: number;
  private readonly debugLogger: ((event: AppServerDebugEvent) => void) | undefined;
  private readonly lineGuard: GuardedLineTransform;
  private readonly reader: ReadlineInterface;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly notificationListeners = new Map<string, Set<(params: unknown) => void>>();
  private readonly requestHandlers = new Map<string, (params: unknown) => unknown>();
  private readonly approvalRequestHandlers = new Map<string, (params: unknown) => unknown>();
  private readonly activeServerRequestIds = new Set<string>();
  private readonly retiredRequestIds = new Set<string>();
  private readonly queuedRequestWrites = new Map<string, QueuedWriteEntry>();

  private nextRequestId: number;
  private queuedWrites = 0;
  private queuedWriteBytes = 0;
  private waitingWrites = 0;
  private writeQueueHead: QueuedWriteEntry | undefined;
  private writeQueueTail: QueuedWriteEntry | undefined;
  private activeWrite: QueuedWriteEntry | undefined;
  private writePumpRunning = false;
  private activeWriteReject: ((error: BridgeError) => void) | undefined;
  private activeDrainListener: (() => void) | undefined;
  private closeReason?: BridgeError;
  private isClosed = false;

  private readonly onInputError = (error: Error) => {
    this.failTransport(runtimeError("Codex App Server stdout failed.", error));
  };

  private readonly onOutputError = (error: Error) => {
    this.failTransport(runtimeError("Codex App Server stdin write failed.", error));
  };

  private readonly onOutputClose = () => {
    this.failTransport(runtimeError("Codex App Server stdin closed."));
  };

  private readonly onGuardError = (error: Error) => {
    this.failTransport(runtimeError("Codex App Server sent an invalid or oversized line.", error));
  };

  private readonly onReaderClose = () => {
    this.failTransport(runtimeError("Codex App Server stdout closed."));
  };

  constructor(options: AppServerClientOptions) {
    const defaultRequestTimeoutMs = positiveSafeInteger(
      "defaultRequestTimeoutMs",
      options.defaultRequestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      MAX_TIMER_MS,
    );
    const writeStallTimeoutMs = positiveSafeInteger(
      "writeStallTimeoutMs",
      options.writeStallTimeoutMs ?? DEFAULT_WRITE_STALL_TIMEOUT_MS,
      MAX_TIMER_MS,
    );
    const maxLineBytes = positiveSafeInteger(
      "maxLineBytes",
      options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES,
      MAX_LINE_BYTES,
    );
    const initialRequestId = positiveSafeInteger(
      "initialRequestId",
      options.initialRequestId ?? 1,
      Number.MAX_SAFE_INTEGER,
    );
    const maxPendingRequests = positiveSafeInteger(
      "maxPendingRequests",
      options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS,
      MAX_COLLECTION_LIMIT,
    );
    const maxMessageBytes = positiveSafeInteger(
      "maxMessageBytes",
      options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
      MAX_MESSAGE_BYTES,
    );
    const maxQueuedWrites = positiveSafeInteger(
      "maxQueuedWrites",
      options.maxQueuedWrites ?? DEFAULT_MAX_QUEUED_WRITES,
      MAX_COLLECTION_LIMIT,
    );
    const maxQueuedWriteBytes = positiveSafeInteger(
      "maxQueuedWriteBytes",
      options.maxQueuedWriteBytes ?? DEFAULT_MAX_QUEUED_WRITE_BYTES,
      MAX_QUEUED_WRITE_BYTES,
    );
    const maxRetiredRequestIds = positiveSafeInteger(
      "maxRetiredRequestIds",
      options.maxRetiredRequestIds ?? DEFAULT_MAX_RETIRED_REQUEST_IDS,
      MAX_COLLECTION_LIMIT,
    );
    const maxActiveServerRequests = positiveSafeInteger(
      "maxActiveServerRequests",
      options.maxActiveServerRequests ?? DEFAULT_MAX_ACTIVE_SERVER_REQUESTS,
      MAX_COLLECTION_LIMIT,
    );

    this.input = options.input;
    this.output = options.output;
    this.defaultRequestTimeoutMs = defaultRequestTimeoutMs;
    this.writeStallTimeoutMs = writeStallTimeoutMs;
    this.maxPendingRequests = maxPendingRequests;
    this.maxMessageBytes = maxMessageBytes;
    this.maxQueuedWrites = maxQueuedWrites;
    this.maxQueuedWriteBytes = maxQueuedWriteBytes;
    this.maxRetiredRequestIds = maxRetiredRequestIds;
    this.maxActiveServerRequests = maxActiveServerRequests;
    this.debugLogger = options.debugLogger;
    this.nextRequestId = initialRequestId;

    this.lineGuard = new GuardedLineTransform(maxLineBytes);
    this.reader = createInterface({ input: this.lineGuard, crlfDelay: Number.POSITIVE_INFINITY });
    this.input.on("error", this.onInputError);
    this.output.on("error", this.onOutputError);
    this.output.on("close", this.onOutputClose);
    this.lineGuard.on("error", this.onGuardError);
    this.reader.on("error", this.onGuardError);
    this.reader.on("line", (line) => this.handleLine(line));
    this.reader.on("close", this.onReaderClose);
    this.input.pipe(this.lineGuard);
  }

  get closed(): boolean {
    return this.isClosed;
  }

  get pendingRequestCount(): number {
    return this.pending.size;
  }

  get retiredRequestCount(): number {
    return this.retiredRequestIds.size;
  }

  get queuedWriteCount(): number {
    return this.queuedWrites;
  }

  get queuedWriteByteCount(): number {
    return this.queuedWriteBytes;
  }

  get waitingWriteCount(): number {
    return this.waitingWrites;
  }

  get activeServerRequestCount(): number {
    return this.activeServerRequestIds.size;
  }

  async initialize(version: string): Promise<ClientRequestResult<"initialize">> {
    const result = await this.request("initialize", {
      clientInfo: {
        name: "codex-discord-bridge",
        title: "Codex Discord Bridge",
        version,
      },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    await this.notify("initialized");
    return result;
  }

  request<Method extends ClientRequestMethod>(
    method: Method,
    params: ClientRequestParams<Method>,
    options: AppServerRequestOptions = {},
  ): Promise<ClientRequestResult<Method>> {
    if (this.isClosed) {
      return Promise.reject(classifiedRequestError(this.closedError(), "not-sent"));
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(
        classifiedRequestError(
          runtimeError(`Codex App Server request ${method} was aborted.`),
          "not-sent",
        ),
      );
    }
    if (this.pending.size >= this.maxPendingRequests) {
      return Promise.reject(
        classifiedRequestError(
          runtimeError("Codex App Server pending request limit was exceeded."),
          "not-sent",
        ),
      );
    }
    const timeoutMs = options.timeoutMs ?? this.defaultRequestTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_MS) {
      return Promise.reject(
        new AppServerRequestError(
          "INVALID_ARGUMENT",
          "Request timeout must be a positive safe integer.",
          "not-sent",
        ),
      );
    }
    if (this.nextRequestId > Number.MAX_SAFE_INTEGER) {
      return Promise.reject(
        classifiedRequestError(
          runtimeError("Codex App Server request ID space is exhausted; refusing to reuse an ID."),
          "not-sent",
        ),
      );
    }

    const schemas = clientRequestSchemas[method];
    const parsedParams = schemas.params.safeParse(params);
    if (!parsedParams.success) {
      return Promise.reject(
        new AppServerRequestError(
          "INVALID_ARGUMENT",
          `Invalid parameters for App Server method ${method}.`,
          "not-sent",
        ),
      );
    }

    const id = this.nextRequestId;
    let serialized: SerializedMessage;
    try {
      serialized = this.serializeMessage({ method, id, params: parsedParams.data }, true);
    } catch (error) {
      return Promise.reject(
        classifiedRequestError(
          error instanceof BridgeError
            ? error
            : runtimeError("Codex App Server request serialization failed."),
          "not-sent",
        ),
      );
    }
    this.nextRequestId += 1;
    const key = requestKey(id);

    const response = new Promise<ClientRequestResult<Method>>((resolve, reject) => {
      const pending: PendingRequest = {
        method,
        resultSchema: schemas.result,
        resolve: (value) => resolve(value as ClientRequestResult<Method>),
        reject,
        sent: false,
        settled: false,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      };
      if (options.signal !== undefined) {
        pending.abortListener = () => {
          const delivery = this.pendingDelivery(key, pending);
          const failure = classifiedRequestError(
            runtimeError(`Codex App Server request ${method} was aborted.`),
            delivery,
          );
          if (this.cancelQueuedRequest(key, failure)) {
            this.settlePending(key, pending, "reject", failure);
          } else {
            this.retirePending(key, pending, failure);
          }
        };
        options.signal.addEventListener("abort", pending.abortListener, { once: true });
      }
      this.pending.set(key, pending);
      pending.timer = setTimeout(() => this.expirePending(key, pending), timeoutMs);
    });

    const pending = this.pending.get(key) as PendingRequest;
    void this.enqueueSerialized(serialized, {
      requestKey: key,
      onHandoff: () => {
        if (!pending.settled) {
          pending.sent = true;
        }
      },
    }).catch((error) => {
      if (!pending.settled) {
        this.failTransport(error);
      }
    });
    return response;
  }

  notify<Method extends ClientNotificationMethod>(
    method: Method,
    ...args: ClientNotificationParams<Method> extends undefined
      ? [params?: ClientNotificationParams<Method>]
      : [params: ClientNotificationParams<Method>]
  ): Promise<void> {
    if (this.isClosed) {
      return Promise.reject(this.closedError());
    }
    const params = args[0];
    const parsedParams = clientNotificationSchemas[method].safeParse(params);
    if (!parsedParams.success) {
      return Promise.reject(
        new BridgeError("INVALID_ARGUMENT", `Invalid notification parameters for ${method}.`),
      );
    }
    let serialized: SerializedMessage;
    try {
      serialized = this.serializeMessage(
        params === undefined ? { method } : { method, params },
        true,
      );
    } catch (error) {
      return Promise.reject(error);
    }
    return this.enqueueSerialized(serialized);
  }

  onNotification<Method extends ServerNotificationMethod>(
    method: Method,
    listener: NotificationListener<Method>,
  ): () => void {
    let listeners = this.notificationListeners.get(method);
    if (listeners === undefined) {
      listeners = new Set();
      this.notificationListeners.set(method, listeners);
    }
    listeners.add(listener as (params: unknown) => void);
    return () => {
      listeners?.delete(listener as (params: unknown) => void);
      if (listeners?.size === 0) {
        this.notificationListeners.delete(method);
      }
    };
  }

  handleRequest<Method extends NonApprovalServerRequestMethod>(
    method: Method,
    handler: ServerRequestHandler<Method>,
  ): () => void {
    if (method !== "item/tool/call") {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        "Approval methods require handleApprovalRequest().",
      );
    }
    this.requestHandlers.set(method, handler as (params: unknown) => unknown);
    return () => {
      if (this.requestHandlers.get(method) === handler) {
        this.requestHandlers.delete(method);
      }
    };
  }

  handleApprovalRequest<Method extends ApprovalRequestMethod>(
    method: Method,
    handler: ApprovalRequestHandler<Method>,
  ): () => void {
    if ((method as string) === "item/tool/call" || !Object.hasOwn(serverRequestSchemas, method)) {
      throw new BridgeError("INVALID_ARGUMENT", "Invalid App Server approval method.");
    }
    this.approvalRequestHandlers.set(method, handler as (params: unknown) => unknown);
    return () => {
      if (this.approvalRequestHandlers.get(method) === handler) {
        this.approvalRequestHandlers.delete(method);
      }
    };
  }

  transportExited(reason?: BridgeError): void {
    this.close(reason ?? runtimeError("Codex App Server process exited."));
  }

  close(reason: BridgeError = runtimeError("Codex App Server client closed.")): void {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    this.closeReason = reason;

    this.input.unpipe(this.lineGuard);
    this.input.removeListener("error", this.onInputError);
    this.output.removeListener("error", this.onOutputError);
    this.output.removeListener("close", this.onOutputClose);
    this.lineGuard.removeListener("error", this.onGuardError);
    this.reader.removeAllListeners();
    this.reader.close();
    this.lineGuard.destroy();

    if (this.activeDrainListener !== undefined) {
      this.output.removeListener("drain", this.activeDrainListener);
      this.activeDrainListener = undefined;
    }
    this.activeWriteReject?.(reason);
    this.activeWriteReject = undefined;

    if (this.activeWrite !== undefined) {
      this.settleQueuedWrite(this.activeWrite, "reject", reason);
    }
    while (this.writeQueueHead !== undefined) {
      const entry = this.writeQueueHead;
      this.settleQueuedWrite(entry, "reject", reason);
    }

    for (const [key, pending] of this.pending) {
      this.settlePending(
        key,
        pending,
        "reject",
        classifiedRequestError(reason, pending.sent ? "sent-unconfirmed" : "not-sent"),
      );
    }
    this.notificationListeners.clear();
    this.requestHandlers.clear();
    this.approvalRequestHandlers.clear();
    this.activeServerRequestIds.clear();
    this.retiredRequestIds.clear();
  }

  private closedError(): BridgeError {
    return this.closeReason ?? runtimeError("Codex App Server client is closed.");
  }

  private failTransport(error: BridgeError): void {
    this.close(error);
  }

  private settlePending(
    key: string,
    pending: PendingRequest,
    action: "resolve" | "reject",
    value: unknown,
  ): void {
    if (pending.settled) {
      return;
    }
    pending.settled = true;
    if (pending.timer !== undefined) {
      clearTimeout(pending.timer);
    }
    if (pending.signal !== undefined && pending.abortListener !== undefined) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
    this.pending.delete(key);
    if (action === "resolve") {
      pending.resolve(value);
    } else {
      pending.reject(value as BridgeError);
    }
  }

  private retirePending(key: string, pending: PendingRequest, error: BridgeError): void {
    if (pending.settled) {
      return;
    }
    if (this.retiredRequestIds.size >= this.maxRetiredRequestIds) {
      this.failTransport(runtimeError("Codex App Server retired response ID limit was exceeded."));
      return;
    }
    this.retiredRequestIds.add(key);
    this.settlePending(key, pending, "reject", error);
  }

  private pendingDelivery(key: string, pending: PendingRequest): "not-sent" | "sent-unconfirmed" {
    const write = this.queuedRequestWrites.get(key);
    return pending.sent || write?.state === "writing" ? "sent-unconfirmed" : "not-sent";
  }

  private expirePending(key: string, pending: PendingRequest): void {
    if (pending.settled) {
      return;
    }
    const delivery = this.pendingDelivery(key, pending);
    const failure = timeoutError(pending.method, delivery);
    if (delivery === "not-sent") {
      this.cancelQueuedRequest(key, failure);
      this.settlePending(key, pending, "reject", failure);
      return;
    }
    this.retirePending(key, pending, failure);
  }

  private handleLine(line: string): void {
    if (this.isClosed) {
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      this.failTransport(runtimeError("Codex App Server sent malformed JSON.", error));
      return;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.failTransport(runtimeError("Codex App Server sent a malformed envelope."));
      return;
    }
    const envelope = value as Record<string, unknown>;
    if (Object.hasOwn(envelope, "jsonrpc")) {
      this.failTransport(runtimeError("Codex App Server sent an unexpected jsonrpc member."));
      return;
    }

    if (Object.hasOwn(envelope, "method")) {
      if (
        typeof envelope.method !== "string" ||
        Object.hasOwn(envelope, "result") ||
        Object.hasOwn(envelope, "error")
      ) {
        this.failTransport(runtimeError("Codex App Server sent a malformed method envelope."));
        return;
      }
      if (Object.hasOwn(envelope, "id")) {
        this.handleServerRequest(envelope);
      } else {
        this.handleNotification(envelope.method, envelope.params);
      }
      return;
    }

    if (Object.hasOwn(envelope, "id")) {
      this.handleResponse(envelope);
      return;
    }
    this.failTransport(runtimeError("Codex App Server sent a malformed envelope."));
  }

  private handleResponse(envelope: Record<string, unknown>): void {
    const parsedId = RequestIdSchema.safeParse(envelope.id);
    const hasResult = Object.hasOwn(envelope, "result");
    const hasError = Object.hasOwn(envelope, "error");
    if (!parsedId.success || hasResult === hasError) {
      this.failTransport(runtimeError("Codex App Server sent a malformed response envelope."));
      return;
    }
    const key = requestKey(parsedId.data);
    const pending = this.pending.get(key);
    if (pending === undefined) {
      if (this.retiredRequestIds.delete(key)) {
        try {
          this.debugLogger?.({
            direction: "inbound",
            idType: typeof parsedId.data === "number" ? "number" : "string",
            kind: "late-response",
          });
        } catch {
          // Debug logging cannot affect protocol processing.
        }
        return;
      }
      this.failTransport(
        runtimeError("Codex App Server sent an unknown or duplicate response ID."),
      );
      return;
    }
    if (!pending.sent) {
      this.failTransport(runtimeError("Codex App Server responded before its request was sent."));
      return;
    }

    if (hasError) {
      const remoteError = ProtocolErrorSchema.safeParse(envelope.error);
      if (!remoteError.success) {
        this.failTransport(runtimeError("Codex App Server sent a malformed error response."));
        return;
      }
      this.settlePending(
        key,
        pending,
        "reject",
        new AppServerRequestError(
          "RUNTIME",
          `Codex App Server request ${pending.method} failed with code ${remoteError.data.code}.`,
          "remote-rejected",
          "Correct the rejected request or Codex configuration before retrying.",
        ),
      );
      return;
    }

    const result = pending.resultSchema.safeParse(envelope.result);
    if (!result.success) {
      this.failTransport(
        runtimeError(`Codex App Server returned an invalid ${pending.method} result.`),
      );
      return;
    }
    this.settlePending(key, pending, "resolve", result.data);
  }

  private handleNotification(method: string, params: unknown): void {
    if (!Object.hasOwn(serverNotificationSchemas, method)) {
      try {
        this.debugLogger?.({ direction: "inbound", kind: "unknown-notification", method });
      } catch {
        // Debug logging cannot affect protocol processing.
      }
      return;
    }
    const knownMethod = method as ServerNotificationMethod;
    const parsed = serverNotificationSchemas[knownMethod].safeParse(params);
    if (!parsed.success) {
      if (bestEffortProgressNotificationMethods.has(knownMethod)) {
        try {
          this.debugLogger?.({
            direction: "inbound",
            kind: "invalid-progress-notification",
            method: knownMethod as BestEffortProgressNotificationMethod,
          });
        } catch {
          // Debug logging cannot affect protocol processing.
        }
        return;
      }
      this.failTransport(runtimeError(`Codex App Server sent invalid ${knownMethod} parameters.`));
      return;
    }
    for (const listener of this.notificationListeners.get(knownMethod) ?? []) {
      try {
        listener(parsed.data);
      } catch {
        // Consumers own listener failures; transport processing must continue.
      }
    }
  }

  private handleServerRequest(envelope: Record<string, unknown>): void {
    const parsedId = RequestIdSchema.safeParse(envelope.id);
    if (!parsedId.success || typeof envelope.method !== "string") {
      this.failTransport(runtimeError("Codex App Server sent a malformed server request."));
      return;
    }
    const id = parsedId.data;
    const key = requestKey(id);
    if (this.activeServerRequestIds.has(key)) {
      this.failTransport(runtimeError("Codex App Server reused an active server request ID."));
      return;
    }
    if (this.activeServerRequestIds.size >= this.maxActiveServerRequests) {
      this.failTransport(
        runtimeError("Codex App Server active server request limit was exceeded."),
      );
      return;
    }
    this.activeServerRequestIds.add(key);
    const method = envelope.method;
    if (!Object.hasOwn(serverRequestSchemas, method)) {
      void this.respondToServerRequest(key, methodNotSupportedResponse(id));
      return;
    }
    if (!Object.hasOwn(envelope, "params")) {
      this.failTransport(runtimeError("Codex App Server sent a malformed server request."));
      return;
    }

    const knownMethod = method as ServerRequestMethod;
    const schemas = serverRequestSchemas[knownMethod];
    const parsedParams = schemas.params.safeParse(envelope.params);
    if (!parsedParams.success) {
      this.failTransport(runtimeError(`Codex App Server sent invalid ${knownMethod} parameters.`));
      return;
    }
    if (knownMethod !== "item/tool/call") {
      const approvalMethod = knownMethod as ApprovalRequestMethod;
      const handler = this.approvalRequestHandlers.get(approvalMethod);
      if (handler === undefined) {
        void this.respondToServerRequest(
          key,
          approvalResponseForRequest(id, approvalMethod, parsedParams.data as never, "decline"),
        );
        return;
      }
      void this.runApprovalRequestHandler(
        key,
        id,
        approvalMethod,
        handler,
        parsedParams.data as never,
      );
      return;
    }
    const handler = this.requestHandlers.get(knownMethod);
    if (handler === undefined) {
      void this.respondToServerRequest(key, requestFailedResponse(id));
      return;
    }

    void this.runServerRequestHandler(key, id, handler, schemas.result, parsedParams.data);
  }

  private async runApprovalRequestHandler<Method extends ApprovalRequestMethod>(
    key: string,
    id: string | number,
    method: Method,
    handler: (params: unknown, context: ApprovalRequestContext<Method>) => unknown,
    params: ServerRequestParams<Method>,
  ): Promise<void> {
    let action: unknown = "decline";
    try {
      action = await handler(params, { id, method });
    } catch {
      // Approval handler failures always become a request-aware decline.
    }
    await this.respondToServerRequest(key, approvalResponseForRequest(id, method, params, action));
  }

  private async runServerRequestHandler(
    key: string,
    id: string | number,
    handler: (params: unknown) => unknown,
    resultSchema: ZodType,
    params: unknown,
  ): Promise<void> {
    let response: object = requestFailedResponse(id);
    try {
      const result = await handler(params);
      const parsedResult = resultSchema.safeParse(result);
      if (parsedResult.success) {
        response = { id, result: parsedResult.data };
      }
    } catch {
      // Handler failures are converted to a bounded safe protocol error.
    }
    await this.respondToServerRequest(key, response);
  }

  private async respondToServerRequest(key: string, message: object): Promise<void> {
    try {
      await this.enqueueMessage(message);
    } catch (error) {
      this.failTransport(error as BridgeError);
    } finally {
      this.activeServerRequestIds.delete(key);
    }
  }

  private serializeMessage(message: object, invalidArgument: boolean): SerializedMessage {
    let line: string;
    try {
      assertJsonSerializable(message);
      line = `${JSON.stringify(message)}\n`;
    } catch {
      throw new BridgeError(
        invalidArgument ? "INVALID_ARGUMENT" : "RUNTIME",
        invalidArgument
          ? "App Server message parameters are not JSON serializable."
          : "Unable to serialize an App Server message.",
        invalidArgument
          ? undefined
          : "Restart the Codex App Server process and retry the operation.",
      );
    }
    const bytes = Buffer.byteLength(line);
    if (bytes > this.maxMessageBytes) {
      throw new BridgeError(
        invalidArgument ? "INVALID_ARGUMENT" : "RUNTIME",
        "App Server message exceeded the configured byte limit.",
        invalidArgument
          ? undefined
          : "Restart the Codex App Server process and retry the operation.",
      );
    }
    return { bytes, line };
  }

  private enqueueMessage(message: object): Promise<void> {
    if (this.isClosed) {
      return Promise.reject(this.closedError());
    }
    let serialized: SerializedMessage;
    try {
      serialized = this.serializeMessage(message, false);
    } catch (error) {
      const failure = error as BridgeError;
      this.failTransport(failure);
      return Promise.reject(failure);
    }
    return this.enqueueSerialized(serialized);
  }

  private enqueueSerialized(
    serialized: SerializedMessage,
    options: { requestKey?: string; onHandoff?: () => void } = {},
  ): Promise<void> {
    if (this.isClosed) {
      return Promise.reject(this.closedError());
    }
    if (
      this.queuedWrites >= this.maxQueuedWrites ||
      this.queuedWriteBytes + serialized.bytes > this.maxQueuedWriteBytes
    ) {
      const failure = runtimeError("Codex App Server write queue limit was exceeded.");
      this.failTransport(failure);
      return Promise.reject(failure);
    }
    this.queuedWrites += 1;
    this.queuedWriteBytes += serialized.bytes;
    let resolve!: () => void;
    let reject!: (error: BridgeError) => void;
    const completion = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const entry: QueuedWriteEntry = {
      line: serialized.line,
      bytes: serialized.bytes,
      ...(options.requestKey === undefined ? {} : { requestKey: options.requestKey }),
      ...(options.onHandoff === undefined ? {} : { onHandoff: options.onHandoff }),
      previous: undefined,
      next: undefined,
      state: "queued",
      resolve,
      reject,
    };
    this.appendQueuedWrite(entry);
    if (entry.requestKey !== undefined) {
      this.queuedRequestWrites.set(entry.requestKey, entry);
    }
    this.startWritePump();
    return completion;
  }

  private cancelQueuedRequest(key: string, error: BridgeError): boolean {
    const entry = this.queuedRequestWrites.get(key);
    if (entry === undefined || entry.state !== "queued") {
      return false;
    }
    this.settleQueuedWrite(entry, "reject", error);
    return true;
  }

  private appendQueuedWrite(entry: QueuedWriteEntry): void {
    entry.previous = this.writeQueueTail;
    if (this.writeQueueTail === undefined) {
      this.writeQueueHead = entry;
    } else {
      this.writeQueueTail.next = entry;
    }
    this.writeQueueTail = entry;
    this.waitingWrites += 1;
  }

  private takeQueuedWrite(): QueuedWriteEntry | undefined {
    const entry = this.writeQueueHead;
    if (entry === undefined) {
      return undefined;
    }
    this.unlinkQueuedWrite(entry);
    entry.state = "writing";
    this.activeWrite = entry;
    return entry;
  }

  private unlinkQueuedWrite(entry: QueuedWriteEntry): void {
    if (entry.previous === undefined) {
      this.writeQueueHead = entry.next;
    } else {
      entry.previous.next = entry.next;
    }
    if (entry.next === undefined) {
      this.writeQueueTail = entry.previous;
    } else {
      entry.next.previous = entry.previous;
    }
    entry.previous = undefined;
    entry.next = undefined;
    this.waitingWrites -= 1;
  }

  private startWritePump(): void {
    if (this.writePumpRunning || this.isClosed) {
      return;
    }
    this.writePumpRunning = true;
    void this.runWritePump()
      .catch((error) => {
        const failure = runtimeError("Codex App Server write queue failed.", error);
        this.failTransport(failure);
      })
      .finally(() => {
        this.writePumpRunning = false;
        if (!this.isClosed && this.writeQueueHead !== undefined) {
          this.startWritePump();
        }
      });
  }

  private async runWritePump(): Promise<void> {
    while (!this.isClosed) {
      const entry = this.takeQueuedWrite();
      if (entry === undefined) {
        return;
      }
      try {
        await this.performWrite(entry.line, entry.onHandoff);
      } catch (error) {
        const failure =
          error instanceof BridgeError
            ? error
            : runtimeError("Codex App Server stdin write failed.", error);
        this.settleQueuedWrite(entry, "reject", failure);
        this.failTransport(failure);
        return;
      }
      this.settleQueuedWrite(entry, "resolve");
    }
  }

  private settleQueuedWrite(
    entry: QueuedWriteEntry,
    action: "resolve" | "reject",
    error?: BridgeError,
  ): void {
    if (entry.state === "settled") {
      return;
    }
    if (entry.state === "queued") {
      this.unlinkQueuedWrite(entry);
    } else if (this.activeWrite === entry) {
      this.activeWrite = undefined;
    }
    entry.state = "settled";
    if (
      entry.requestKey !== undefined &&
      this.queuedRequestWrites.get(entry.requestKey) === entry
    ) {
      this.queuedRequestWrites.delete(entry.requestKey);
    }
    this.queuedWrites -= 1;
    this.queuedWriteBytes -= entry.bytes;
    const resolve = entry.resolve;
    const reject = entry.reject;
    entry.line = "";
    entry.bytes = 0;
    entry.resolve = () => undefined;
    entry.reject = () => undefined;
    delete entry.requestKey;
    delete entry.onHandoff;
    if (action === "resolve") {
      resolve();
    } else {
      reject(error ?? runtimeError("Codex App Server write was cancelled."));
    }
  }

  private performWrite(line: string, onHandoff?: () => void): Promise<void> {
    if (this.isClosed) {
      return Promise.reject(this.closedError());
    }
    return new Promise((resolve, reject) => {
      let writeReturned = false;
      let callbackDone = false;
      let drainDone = false;
      let settled = false;
      let stallTimer: NodeJS.Timeout | undefined;

      const armStallTimer = () => {
        if (settled) {
          return;
        }
        if (stallTimer !== undefined) {
          clearTimeout(stallTimer);
        }
        stallTimer = setTimeout(() => {
          rejectWrite(
            new BridgeError(
              "TIMEOUT",
              "Codex App Server stdin write made no progress before its deadline.",
              "Restart the Codex App Server process before retrying.",
            ),
          );
        }, this.writeStallTimeoutMs);
      };

      const cleanup = () => {
        if (stallTimer !== undefined) {
          clearTimeout(stallTimer);
          stallTimer = undefined;
        }
        if (this.activeDrainListener === onDrain) {
          this.output.removeListener("drain", onDrain);
          this.activeDrainListener = undefined;
        }
        if (this.activeWriteReject === rejectWrite) {
          this.activeWriteReject = undefined;
        }
      };
      const rejectWrite = (error: BridgeError) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };
      const finish = () => {
        if (!settled && writeReturned && callbackDone && drainDone) {
          settled = true;
          cleanup();
          resolve();
        }
      };
      const onDrain = () => {
        if (settled) {
          return;
        }
        drainDone = true;
        armStallTimer();
        finish();
      };

      this.activeWriteReject = rejectWrite;
      armStallTimer();
      try {
        const accepted = this.output.write(line, (error) => {
          if (settled) {
            return;
          }
          if (error !== undefined && error !== null) {
            rejectWrite(runtimeError("Codex App Server stdin write failed.", error));
            return;
          }
          callbackDone = true;
          armStallTimer();
          finish();
        });
        onHandoff?.();
        drainDone = accepted;
        writeReturned = true;
        armStallTimer();
        if (!accepted) {
          this.activeDrainListener = onDrain;
          this.output.once("drain", onDrain);
        }
        finish();
      } catch (error) {
        rejectWrite(runtimeError("Codex App Server stdin write failed.", error));
      }
    });
  }
}
