import { BridgeError } from "../domain/errors.js";
import { MAX_RENDERED_PROGRESS_LENGTH, type RenderedProgressEvent } from "./progress-format.js";

const MIN_BATCH_DELAY_MS = 2_000;
const DEFAULT_HEARTBEAT_BUCKET_MS = 30_000;
const DEFAULT_MAX_DETAIL_EVENTS = 128;
const DEFAULT_MAX_DETAIL_CHARACTERS = 32_768;
const DEFAULT_STOP_WAIT_MS = 1_000;
const MAX_CONFIGURED_EVENTS = 10_000;
const MAX_CONFIGURED_CHARACTERS = 1_000_000;
const MAX_CONFIGURED_TIMEOUT_MS = 300_000;
const STATUS_CURRENT_PREFIX = "Current: ";
const STATUS_HEARTBEAT_PREFIX = "Last verified activity: ";

export const PROGRESS_TRUNCATION_NOTICE =
  "Additional progress detail was summarized because this turn reached its display limit.";

export interface RenderedTerminal {
  readonly text: string;
  readonly type: "terminal";
}

export interface ProgressPump {
  start(initialStatus: string): Promise<void>;
  push(event: RenderedProgressEvent): Promise<void>;
  heartbeat(observedAt: number): Promise<void>;
  terminal(status: RenderedTerminal): Promise<void>;
  stop(): Promise<void>;
}

export interface ProgressPumpDestination {
  createStatus(content: string, signal: AbortSignal): Promise<{ readonly id: string }>;
  editStatus(
    messageId: string,
    content: string,
    signal: AbortSignal,
  ): Promise<{ readonly id: string }>;
  append(content: string, signal: AbortSignal): Promise<{ readonly id: string }>;
}

export interface ProgressPumpScheduler {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DiscordProgressPumpOptions {
  readonly batchDelayMs?: number;
  readonly heartbeatBucketMs?: number;
  readonly maxDetailCharacters?: number;
  readonly maxDetailEvents?: number;
  readonly scheduler?: ProgressPumpScheduler;
  readonly stopWaitMs?: number;
}

const DEFAULT_SCHEDULER: ProgressPumpScheduler = {
  now: () => Date.now(),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const RENDERED_EVENT_TYPES = new Set<RenderedProgressEvent["type"]>([
  "state",
  "reasoning",
  "commentary",
  "plan",
  "activity",
  "warning",
  "heartbeat",
  "terminal",
]);

function configuredInteger(
  value: number | undefined,
  defaultValue: number,
  maximum: number,
  name: string,
): number {
  const configured = value ?? defaultValue;
  if (!Number.isSafeInteger(configured) || configured <= 0 || configured > maximum) {
    throw new BridgeError("INVALID_ARGUMENT", `Invalid progress pump ${name}.`);
  }
  return configured;
}

function truncateUtf16(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const suffix = "...[TRUNCATED]";
  let end = maximum - suffix.length;
  if (
    end > 0 &&
    /[\uD800-\uDBFF]/u.test(value.charAt(end - 1)) &&
    /[\uDC00-\uDFFF]/u.test(value.charAt(end))
  ) {
    end -= 1;
  }
  return `${value.slice(0, Math.max(0, end))}${suffix}`;
}

function renderedText(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_RENDERED_PROGRESS_LENGTH
  ) {
    throw new BridgeError("INVALID_ARGUMENT", `Invalid rendered progress ${label}.`);
  }
  return value;
}

function renderedEvent(value: RenderedProgressEvent): RenderedProgressEvent {
  if (typeof value !== "object" || value === null || !RENDERED_EVENT_TYPES.has(value.type)) {
    throw new BridgeError("INVALID_ARGUMENT", "Invalid rendered progress event.");
  }
  const text = renderedText(value.text, "event");
  let streamText: string | undefined;
  if (value.streamText !== undefined) {
    if (value.type !== "commentary" && value.type !== "reasoning") {
      throw new BridgeError("INVALID_ARGUMENT", "Invalid rendered progress stream.");
    }
    streamText = renderedText(value.streamText, "stream");
    const prefix = value.type === "commentary" ? "Update: " : "Reasoning: ";
    if (text !== `${prefix}${streamText}`) {
      throw new BridgeError("INVALID_ARGUMENT", "Invalid rendered progress stream.");
    }
  }
  return Object.freeze({
    ...(streamText === undefined ? {} : { streamText }),
    text,
    type: value.type,
  });
}

function mergeStreamEvents(
  previous: RenderedProgressEvent | undefined,
  current: RenderedProgressEvent,
): RenderedProgressEvent | undefined {
  if (
    previous?.streamText === undefined ||
    current.streamText === undefined ||
    previous.type !== current.type
  ) {
    return undefined;
  }
  const prefix = current.type === "commentary" ? "Update: " : "Reasoning: ";
  const streamText = `${previous.streamText}${current.streamText}`;
  const text = `${prefix}${streamText}`;
  if (text.length > MAX_RENDERED_PROGRESS_LENGTH) {
    return undefined;
  }
  return Object.freeze({
    streamText,
    text,
    type: current.type,
  });
}

function renderedTerminal(value: RenderedTerminal): RenderedTerminal {
  if (typeof value !== "object" || value === null || value.type !== "terminal") {
    throw new BridgeError("INVALID_ARGUMENT", "Invalid rendered progress terminal.");
  }
  return Object.freeze({
    text: renderedText(value.text, "terminal"),
    type: "terminal" as const,
  });
}

function acceptedMessageId(value: unknown): string {
  if (typeof value !== "string" || !/^\d{1,32}$/u.test(value)) {
    throw new BridgeError("RUNTIME", "Progress destination returned an invalid message receipt.");
  }
  return value;
}

function detailChunks(events: readonly RenderedProgressEvent[]): readonly string[] {
  const chunks: string[] = [];
  let current = "";
  for (const event of events) {
    const next = current.length === 0 ? event.text : `${current}\n\n${event.text}`;
    if (next.length <= MAX_RENDERED_PROGRESS_LENGTH) {
      current = next;
      continue;
    }
    if (current.length > 0) chunks.push(current);
    current = event.text;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export class DiscordProgressPump implements ProgressPump {
  private readonly abortController = new AbortController();
  private readonly batchDelayMs: number;
  private readonly destination: ProgressPumpDestination;
  private readonly heartbeatBucketMs: number;
  private readonly maxDetailCharacters: number;
  private readonly maxDetailEvents: number;
  private readonly scheduler: ProgressPumpScheduler;
  private readonly stopWaitMs: number;
  private detailCharacters = 0;
  private detailClosed = false;
  private detailEvents = 0;
  private deliveryDisabled = false;
  private flushTimer: unknown;
  private heartbeatLabel: string | undefined;
  private initialStatus = "";
  private lastActivityText: string | undefined;
  private lastStatusContent: string | undefined;
  private latestStatus: string | undefined;
  private operationTail: Promise<void> = Promise.resolve();
  private readonly queue: RenderedProgressEvent[] = [];
  private started = false;
  private startPromise: Promise<void> | undefined;
  private statusMessageId: string | undefined;
  private stopped = false;
  private stopPromise: Promise<void> | undefined;
  private terminalPromise: Promise<void> | undefined;
  private terminalRequested = false;
  private truncationAttempted = false;
  private truncationPending = false;

  constructor(destination: ProgressPumpDestination, options: DiscordProgressPumpOptions = {}) {
    this.destination = destination;
    this.scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
    this.batchDelayMs = Math.max(
      MIN_BATCH_DELAY_MS,
      configuredInteger(
        options.batchDelayMs,
        MIN_BATCH_DELAY_MS,
        MAX_CONFIGURED_TIMEOUT_MS,
        "batch delay",
      ),
    );
    this.heartbeatBucketMs = configuredInteger(
      options.heartbeatBucketMs,
      DEFAULT_HEARTBEAT_BUCKET_MS,
      MAX_CONFIGURED_TIMEOUT_MS,
      "heartbeat interval",
    );
    this.maxDetailCharacters = configuredInteger(
      options.maxDetailCharacters,
      DEFAULT_MAX_DETAIL_CHARACTERS,
      MAX_CONFIGURED_CHARACTERS,
      "character limit",
    );
    this.maxDetailEvents = configuredInteger(
      options.maxDetailEvents,
      DEFAULT_MAX_DETAIL_EVENTS,
      MAX_CONFIGURED_EVENTS,
      "event limit",
    );
    this.stopWaitMs = configuredInteger(
      options.stopWaitMs,
      DEFAULT_STOP_WAIT_MS,
      MAX_CONFIGURED_TIMEOUT_MS,
      "stop wait",
    );
  }

  start(initialStatus: string): Promise<void> {
    if (this.startPromise !== undefined) return this.startPromise;
    if (this.stopped) return Promise.resolve();
    this.started = true;
    this.initialStatus = truncateUtf16(
      renderedText(initialStatus, "initial status"),
      MAX_RENDERED_PROGRESS_LENGTH,
    );
    this.startPromise = this.serialize(async () => {
      if (this.stopped) return;
      try {
        const receipt = await this.destination.createStatus(
          this.initialStatus,
          this.abortController.signal,
        );
        this.statusMessageId = acceptedMessageId(receipt.id);
        this.lastStatusContent = this.initialStatus;
      } catch {
        this.disableDelivery();
      }
    });
    return this.startPromise;
  }

  async push(input: RenderedProgressEvent): Promise<void> {
    this.requireStarted();
    if (this.stopped || this.terminalRequested || this.deliveryDisabled) return;
    const event = renderedEvent(input);
    if (event.type === "terminal") {
      await this.terminal({ text: event.text, type: "terminal" });
      return;
    }
    this.heartbeatLabel = undefined;

    if (event.type === "activity" && event.text === this.lastActivityText) {
      return;
    }
    if (event.type === "activity") {
      this.lastActivityText = event.text;
    }

    if (!this.detailClosed) {
      const queueIndex = this.queue.length - 1;
      const previous = this.queue[queueIndex];
      const merged = mergeStreamEvents(previous, event);
      const detailEvent = merged ?? event;
      const addedEvents = merged === undefined ? 1 : 0;
      const addedCharacters =
        merged === undefined
          ? event.text.length
          : merged.text.length - (previous?.text.length ?? 0);
      this.latestStatus = detailEvent.text;
      const exceedsEventLimit = this.detailEvents + addedEvents > this.maxDetailEvents;
      const exceedsCharacterLimit =
        this.detailCharacters + addedCharacters > this.maxDetailCharacters;
      if (exceedsEventLimit || exceedsCharacterLimit) {
        this.detailClosed = true;
        this.truncationPending = true;
      } else {
        if (merged === undefined) {
          this.queue.push(event);
        } else {
          this.queue[queueIndex] = merged;
        }
        this.detailEvents += addedEvents;
        this.detailCharacters += addedCharacters;
      }
    } else {
      this.latestStatus = event.text;
    }
    this.scheduleFlush();
  }

  heartbeat(observedAt: number): Promise<void> {
    this.requireStarted();
    if (
      this.stopped ||
      this.terminalRequested ||
      this.deliveryDisabled ||
      !Number.isFinite(observedAt)
    ) {
      return Promise.resolve();
    }
    const age = Math.max(0, this.scheduler.now() - observedAt);
    const bucket = Math.floor(age / this.heartbeatBucketMs);
    const label =
      bucket === 0 ? "now" : `${Math.round((bucket * this.heartbeatBucketMs) / 1_000)}s ago`;
    if (label === this.heartbeatLabel) return Promise.resolve();
    this.heartbeatLabel = label;
    return this.serialize(async () => {
      await this.deliverCurrentStatus();
    });
  }

  terminal(input: RenderedTerminal): Promise<void> {
    this.requireStarted();
    if (this.terminalPromise !== undefined) return this.terminalPromise;
    if (this.stopped) return Promise.resolve();
    const terminal = renderedTerminal(input);
    this.terminalRequested = true;
    this.cancelFlushTimer();
    this.terminalPromise = this.serialize(async () => {
      if (this.stopped) return;
      await this.flushNonterminal();
      this.queue.splice(0);

      const terminalStatus = this.renderStatus(`Terminal: ${terminal.text}`);
      if (this.statusMessageId !== undefined) {
        try {
          const receipt = await this.destination.editStatus(
            this.statusMessageId,
            terminalStatus,
            this.abortController.signal,
          );
          if (acceptedMessageId(receipt.id) !== this.statusMessageId) {
            throw new BridgeError("RUNTIME", "Progress destination edited an unexpected message.");
          }
          this.lastStatusContent = terminalStatus;
        } catch {
          // Terminal append remains worth one independent bounded attempt.
        }
      }
      try {
        const receipt = await this.destination.append(terminal.text, this.abortController.signal);
        acceptedMessageId(receipt.id);
      } catch {
        // Progress failures never reject the Codex turn.
      }
    });
    return this.terminalPromise;
  }

  stop(): Promise<void> {
    if (this.stopPromise !== undefined) return this.stopPromise;
    this.stopped = true;
    this.cancelFlushTimer();
    this.queue.splice(0);
    this.abortController.abort();
    this.stopPromise = this.waitBounded(this.operationTail);
    return this.stopPromise;
  }

  private requireStarted(): void {
    if (!this.started) {
      throw new BridgeError("CONFLICT", "Progress pump has not started.");
    }
  }

  private scheduleFlush(): void {
    if (
      this.flushTimer !== undefined ||
      this.stopped ||
      this.terminalRequested ||
      this.deliveryDisabled
    ) {
      return;
    }
    this.flushTimer = this.scheduler.setTimeout(() => {
      this.flushTimer = undefined;
      void this.serialize(() => this.flushNonterminal());
    }, this.batchDelayMs);
  }

  private cancelFlushTimer(): void {
    if (this.flushTimer === undefined) return;
    this.scheduler.clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }

  private async flushNonterminal(): Promise<void> {
    if (this.stopped || this.deliveryDisabled) return;
    const events = this.queue.splice(0);
    const shouldSendTruncation = this.truncationPending && !this.truncationAttempted;
    this.truncationPending = false;

    if (!(await this.deliverCurrentStatus())) return;
    for (const content of detailChunks(events)) {
      if (!(await this.append(content))) return;
    }
    if (shouldSendTruncation) {
      this.truncationAttempted = true;
      await this.append(PROGRESS_TRUNCATION_NOTICE);
    }
  }

  private async deliverCurrentStatus(): Promise<boolean> {
    if (this.stopped || this.deliveryDisabled) return false;
    if (this.statusMessageId === undefined) {
      this.disableDelivery();
      return false;
    }
    const content = this.renderStatus();
    if (content === this.lastStatusContent) return true;
    try {
      const receipt = await this.destination.editStatus(
        this.statusMessageId,
        content,
        this.abortController.signal,
      );
      if (acceptedMessageId(receipt.id) !== this.statusMessageId) {
        throw new BridgeError("RUNTIME", "Progress destination edited an unexpected message.");
      }
      this.lastStatusContent = content;
      return true;
    } catch {
      this.disableDelivery();
      return false;
    }
  }

  private async append(content: string): Promise<boolean> {
    if (this.stopped || this.deliveryDisabled) return false;
    try {
      const receipt = await this.destination.append(content, this.abortController.signal);
      acceptedMessageId(receipt.id);
      return true;
    } catch {
      this.disableDelivery();
      return false;
    }
  }

  private renderStatus(override?: string): string {
    const lines = [this.initialStatus];
    if (override !== undefined) {
      lines.push(override);
    } else {
      if (this.latestStatus !== undefined) {
        lines.push(`${STATUS_CURRENT_PREFIX}${this.latestStatus}`);
      }
      if (this.heartbeatLabel !== undefined) {
        lines.push(`${STATUS_HEARTBEAT_PREFIX}${this.heartbeatLabel}`);
      }
    }
    return truncateUtf16(lines.join("\n"), MAX_RENDERED_PROGRESS_LENGTH);
  }

  private disableDelivery(): void {
    this.deliveryDisabled = true;
    this.cancelFlushTimer();
    this.queue.splice(0);
  }

  private serialize(operation: () => Promise<void>): Promise<void> {
    const pending = this.operationTail.then(operation);
    this.operationTail = pending.catch(() => undefined);
    return this.operationTail;
  }

  private waitBounded(pending: Promise<void>): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.scheduler.clearTimeout(timer);
        resolve();
      };
      const timer = this.scheduler.setTimeout(finish, this.stopWaitMs);
      void pending.then(finish, finish);
    });
  }
}
