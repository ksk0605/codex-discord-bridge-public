import { type LocalDiscordAttachment, parseLocalDiscordAttachments } from "../discord/format.js";
import { BridgeError } from "../domain/errors.js";

export interface TurnInput {
  channelId: string;
  messageId: string;
  authorId: string;
  guildId?: string;
  parentChannelId?: string;
  interactionId?: string;
  text: string;
  attachments?: LocalDiscordAttachment[];
}

export type TurnItem = Readonly<Omit<TurnInput, "attachments">> & {
  readonly attachments?: readonly Readonly<LocalDiscordAttachment>[];
};

export type TurnRunner<TResult> = (item: TurnItem) => TResult | PromiseLike<TResult>;
export type TurnInterrupt = (item: TurnItem) => void | PromiseLike<void>;

export interface TurnQueueOptions<TResult> {
  run: TurnRunner<TResult>;
  interrupt?: TurnInterrupt;
  maxDepth?: number;
}

export interface DiscardedTurnNotice {
  readonly channelId: string;
  readonly messageId: string;
  readonly authorId: string;
  readonly guildId?: string;
  readonly parentChannelId?: string;
  readonly interactionId?: string;
}

export class TurnDiscardedError extends BridgeError {
  constructor(
    readonly reason: string,
    readonly source: DiscardedTurnNotice,
  ) {
    super("CONFLICT", `Turn ${source.messageId} was discarded: ${reason}`);
    this.name = "TurnDiscardedError";
  }

  get channelId(): string {
    return this.source.channelId;
  }

  get messageId(): string {
    return this.source.messageId;
  }

  get authorId(): string {
    return this.source.authorId;
  }
}

interface Pending<TResult> {
  item: TurnItem;
  resolve: (value: TResult | PromiseLike<TResult>) => void;
  reject: (reason?: unknown) => void;
}

const DEFAULT_MAX_DEPTH = 100;

export class TurnQueue<TResult> {
  private readonly run: TurnRunner<TResult>;
  private readonly interrupt: TurnInterrupt | undefined;
  private readonly maxDepth: number;
  private readonly pending: Pending<TResult>[] = [];
  private readonly interrupts = new WeakMap<Pending<TResult>, Promise<void>>();
  private active: Pending<TResult> | undefined;
  private draining = false;
  private idleWaiters: Array<() => void> = [];

  constructor(options: TurnQueueOptions<TResult>) {
    if (!options || typeof options.run !== "function") {
      throw new BridgeError("INVALID_ARGUMENT", "TurnQueue requires a run callback");
    }
    if (options.interrupt !== undefined && typeof options.interrupt !== "function") {
      throw new BridgeError("INVALID_ARGUMENT", "TurnQueue interrupt must be a function");
    }
    if (
      options.maxDepth !== undefined &&
      (!Number.isSafeInteger(options.maxDepth) || options.maxDepth < 1)
    ) {
      throw new BridgeError(
        "INVALID_ARGUMENT",
        "TurnQueue maxDepth must be a positive safe integer",
      );
    }
    this.run = options.run;
    this.interrupt = options.interrupt;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  }

  enqueue(input: TurnInput): Promise<TResult> {
    const item = snapshotInput(input);
    if (this.depth() >= this.maxDepth) {
      throw new BridgeError("CONFLICT", `TurnQueue depth limit ${this.maxDepth} exceeded`);
    }
    const promise = new Promise<TResult>((resolve, reject) => {
      this.pending.push({ item, resolve, reject });
    });
    void this.drain();
    return promise;
  }

  async interruptActive(): Promise<boolean> {
    const target = this.active;
    if (!target) return false;
    let operation = this.interrupts.get(target);
    if (operation === undefined) {
      let resolve!: () => void;
      let reject!: (reason?: unknown) => void;
      operation = new Promise<void>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      this.interrupts.set(target, operation);
      try {
        Promise.resolve(this.interrupt?.(target.item)).then(resolve, reject);
      } catch (error) {
        reject(error);
      }
    }
    await operation;
    return true;
  }

  discardPending(reason = "discarded"): DiscardedTurnNotice[] {
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new BridgeError("INVALID_ARGUMENT", "discard reason must be a non-empty string");
    }
    const discarded = this.pending.splice(0);
    const notices = discarded.map(({ item }) => sourceNotice(item));
    discarded.forEach(({ item, reject }) => {
      reject(new TurnDiscardedError(reason, sourceNotice(item)));
    });
    this.resolveIdleIfNeeded();
    return notices;
  }

  depth(): number {
    return this.pending.length + (this.active ? 1 : 0);
  }

  idle(): Promise<void> {
    if (!this.active && this.pending.length === 0 && !this.draining) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.length > 0) {
        const entry = this.pending.shift();
        if (!entry) break;
        this.active = entry;
        try {
          entry.resolve(await this.run(entry.item));
        } catch (error) {
          entry.reject(error);
        } finally {
          this.active = undefined;
        }
      }
    } finally {
      this.draining = false;
      this.resolveIdleIfNeeded();
    }
  }

  private resolveIdleIfNeeded(): void {
    if (this.active || this.pending.length || this.draining) return;
    const waiters = this.idleWaiters.splice(0);
    waiters.forEach((resolve) => {
      resolve();
    });
  }
}

function snapshotInput(input: TurnInput): TurnItem {
  if (!input || typeof input !== "object") {
    throw new BridgeError("INVALID_ARGUMENT", "turn input must be an object");
  }
  for (const key of ["channelId", "messageId", "authorId"] as const) {
    if (typeof input[key] !== "string" || input[key].length === 0) {
      throw new BridgeError("INVALID_ARGUMENT", `turn ${key} must be a non-empty string`);
    }
  }
  if (typeof input.text !== "string") {
    throw new BridgeError("INVALID_ARGUMENT", "turn text must be a string");
  }
  for (const key of ["guildId", "parentChannelId", "interactionId"] as const) {
    if (input[key] !== undefined && (typeof input[key] !== "string" || input[key].length === 0)) {
      throw new BridgeError("INVALID_ARGUMENT", `turn ${key} must be a non-empty string`);
    }
  }
  const attachments =
    input.attachments === undefined ? undefined : parseLocalDiscordAttachments(input.attachments);
  if (input.text.length === 0 && (attachments === undefined || attachments.length === 0)) {
    throw new BridgeError("INVALID_ARGUMENT", "turn requires text or at least one attachment");
  }
  const cloned = cloneValue({
    ...input,
    ...(attachments === undefined ? {} : { attachments }),
  });
  return deepFreeze(cloned) as TurnItem;
}

function sourceNotice(item: TurnItem): DiscardedTurnNotice {
  const { channelId, messageId, authorId, guildId, parentChannelId, interactionId } = item;
  return Object.freeze({
    channelId,
    messageId,
    authorId,
    ...(guildId === undefined ? {} : { guildId }),
    ...(parentChannelId === undefined ? {} : { parentChannelId }),
    ...(interactionId === undefined ? {} : { interactionId }),
  });
}

function cloneValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new BridgeError("INVALID_ARGUMENT", "turn input contains a non-finite number");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new BridgeError("INVALID_ARGUMENT", "turn input contains unsupported metadata");
  }
  if (seen.has(value)) throw new BridgeError("INVALID_ARGUMENT", "turn input cannot be cyclic");
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Date) {
    throw new BridgeError("INVALID_ARGUMENT", "turn input contains unsupported payload");
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new BridgeError("INVALID_ARGUMENT", "turn input metadata must use plain objects");
  }
  seen.add(value);
  const clone = Array.isArray(value)
    ? value.map((entry) => cloneValue(entry, seen))
    : Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, cloneValue(entry, seen)]),
      );
  seen.delete(value);
  return clone;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
