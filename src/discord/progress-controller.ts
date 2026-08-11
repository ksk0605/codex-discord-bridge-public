import { BridgeError } from "../domain/errors.js";
import type { DiscordDeliveryReceipt, TurnProgressSource } from "../runtime/turn-progress.js";
import {
  createDiscordDeliveryReceipt,
  createTurnProgressSource,
  type TurnProgressEvent,
  type TurnProgressTerminal,
} from "../runtime/turn-progress.js";
import type {
  DiscordGatewayTransport,
  DiscordLocation,
  DiscordProgressCapabilities,
  DiscordProgressThread,
  DiscordThreadInspection,
} from "./adapter.js";
import { renderTurnProgressEvent } from "./progress-format.js";
import type {
  DeliveryReservation,
  ObservationState,
  ProgressDestination,
  ProgressObservationRecord,
  TombstonePage,
} from "./progress-journal.js";
import {
  DiscordProgressPump,
  type ProgressPump,
  type ProgressPumpDestination,
} from "./progress-pump.js";

const INITIAL_STATUS = "Preparing";
const PROGRESS_UNAVAILABLE_NOTICE =
  "Progress display is unavailable; the Codex turn will continue.";
const PROGRESS_THREAD_REDIRECT =
  "This is a read-only progress thread. Continue the conversation in the parent channel.";
const DEFAULT_TERMINAL_GRACE_MS = 1_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_RECONCILIATION_LIMIT = 100;
const DEFAULT_REDIRECT_COOLDOWN_MS = 30_000;
const DEFAULT_QUIESCE_WAIT_MS = 1_000;
const MAX_CONFIGURED_LIMIT = 1_000;
const MAX_CONFIGURED_TIMEOUT_MS = 300_000;

export interface DiscordProgressControllerSource extends TurnProgressSource {
  readonly location: DiscordLocation;
  readonly parentChannelId?: string;
  readonly threadOwnerId?: string;
}

export interface DiscordProgressThreadIngress {
  readonly channelId: string;
  readonly location: DiscordLocation;
  readonly parentChannelId?: string;
  readonly threadOwnerId?: string;
}

export type DiscordProgressTransport = Pick<
  DiscordGatewayTransport,
  | "createProgressThread"
  | "editMessage"
  | "inspectProgressCapabilities"
  | "inspectThread"
  | "sendMessage"
  | "setProgressThreadState"
>;

export interface ProgressObservationJournalPort {
  initialize(updatedAt: string): Promise<number>;
  beginCreation(input: unknown): Promise<ProgressObservationRecord>;
  confirmDestination(
    sourceMessageId: string,
    destination: ProgressDestination,
    updatedAt: string,
  ): Promise<void>;
  markPreparing(sourceMessageId: string, updatedAt: string): Promise<void>;
  markQueued(sourceMessageId: string, updatedAt: string): Promise<void>;
  markRunning(sourceMessageId: string, turnId: string, updatedAt: string): Promise<void>;
  beginDelivery(sourceMessageId: string, updatedAt: string): Promise<DeliveryReservation>;
  acceptDelivery(
    sourceMessageId: string,
    sequence: number,
    receipt: DiscordDeliveryReceipt,
    updatedAt: string,
  ): Promise<void>;
  markDeliveryUncertain(
    sourceMessageId: string,
    sequence: number,
    updatedAt: string,
  ): Promise<void>;
  markDeliveryFailed(sourceMessageId: string, sequence: number, updatedAt: string): Promise<void>;
  close(
    sourceMessageId: string,
    state: Extract<ObservationState, "completed" | "interrupted" | "failed">,
    updatedAt: string,
  ): Promise<void>;
  get(sourceMessageId: string): Promise<ProgressObservationRecord | undefined>;
  isProgressThread(threadId: string): Promise<boolean>;
  listActive(): Promise<readonly ProgressObservationRecord[]>;
  listTerminalTombstones(options: {
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<TombstonePage>;
  listRequestedTombstoneReconciliations(
    limit: number,
  ): Promise<readonly ProgressObservationRecord[]>;
  removeDeletedThreadTombstone(threadId: string): Promise<void>;
}

export interface ProgressBeginResult {
  readonly durable: boolean;
  readonly kind: "thread" | "inPlace" | "none";
  readonly reused: boolean;
}

export interface ProgressDeliveryDirective {
  readonly replyToMessageId?: string;
}

export type ProgressDeliveryOperation = (
  directive: ProgressDeliveryDirective,
) => Promise<DiscordDeliveryReceipt>;

export interface DiscordProgressControllerOptions {
  readonly botUserId: string;
  readonly createPump?: (destination: ProgressPumpDestination) => ProgressPump;
  readonly heartbeatIntervalMs?: number;
  readonly journal: ProgressObservationJournalPort;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
  readonly quiesceWaitMs?: number;
  readonly reconciliationLimit?: number;
  readonly redirectCooldownMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly terminalGraceMs?: number;
  readonly timers?: DiscordProgressControllerTimers;
  readonly transport: DiscordProgressTransport;
}

export interface DiscordProgressControllerTimers {
  clearInterval(handle: unknown): void;
  setInterval(callback: () => void, milliseconds: number): unknown;
}

interface ActiveObservation {
  readonly controllerSource: DiscordProgressControllerSource;
  readonly destination?: ProgressDestination;
  readonly journalOwned: boolean;
  readonly kind: ProgressBeginResult["kind"];
  readonly pump?: ProgressPump;
  readonly source: TurnProgressSource;
  deliveryTail: Promise<void>;
  durable: boolean;
  firstAcceptedReceipt?: DiscordDeliveryReceipt;
  heartbeatTimer?: unknown;
  lastObservedAt: number;
  localAcceptedDeliveries: number;
  terminal: boolean;
}

function configuredInteger(
  value: number | undefined,
  defaultValue: number,
  maximum: number,
  label: string,
): number {
  const configured = value ?? defaultValue;
  if (!Number.isSafeInteger(configured) || configured <= 0 || configured > maximum) {
    throw new BridgeError("INVALID_ARGUMENT", `Invalid progress controller ${label}.`);
  }
  return configured;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const defaultTimers: DiscordProgressControllerTimers = {
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  setInterval: (callback, milliseconds) => {
    const timer = setInterval(callback, milliseconds);
    timer.unref();
    return timer;
  },
};

function sourceFrom(input: DiscordProgressControllerSource): {
  readonly controllerSource: DiscordProgressControllerSource;
  readonly source: TurnProgressSource;
} {
  if (input.location !== "dm" && input.location !== "guild" && input.location !== "thread") {
    throw new BridgeError("INVALID_ARGUMENT", "Invalid Discord progress source location.");
  }
  const source = createTurnProgressSource({
    channelId: input.channelId,
    ...(input.guildId === undefined ? {} : { guildId: input.guildId }),
    messageId: input.messageId,
  });
  if (input.location === "dm" && source.guildId !== undefined) {
    throw new BridgeError("INVALID_ARGUMENT", "Discord DM progress source cannot have a guild.");
  }
  if (input.location !== "dm" && source.guildId === undefined) {
    throw new BridgeError("INVALID_ARGUMENT", "Discord guild progress source requires a guild.");
  }
  if (input.location === "thread" && input.parentChannelId === undefined) {
    throw new BridgeError("INVALID_ARGUMENT", "Discord thread progress source requires a parent.");
  }
  return {
    controllerSource: Object.freeze({
      channelId: source.channelId,
      ...(source.guildId === undefined ? {} : { guildId: source.guildId }),
      location: input.location,
      messageId: source.messageId,
      ...(input.parentChannelId === undefined ? {} : { parentChannelId: input.parentChannelId }),
      ...(input.threadOwnerId === undefined ? {} : { threadOwnerId: input.threadOwnerId }),
    }),
    source,
  };
}

function sourceLink(source: TurnProgressSource): string {
  const guild = source.guildId ?? "@me";
  return `https://discord.com/channels/${guild}/${source.channelId}/${source.messageId}`;
}

function progressThreadLink(
  source: TurnProgressSource,
  destination: ProgressDestination | undefined,
): string | undefined {
  if (source.guildId === undefined || destination?.kind !== "thread") return undefined;
  return `https://discord.com/channels/${source.guildId}/${destination.threadId}`;
}

function deliveryReceiptLink(
  source: TurnProgressSource,
  receipt: DiscordDeliveryReceipt | undefined,
): string | undefined {
  if (receipt === undefined) return undefined;
  const guild = source.guildId ?? "@me";
  return `https://discord.com/channels/${guild}/${receipt.channelId}/${receipt.messageId}`;
}

function initialStatus(source: TurnProgressSource): string {
  return `${INITIAL_STATUS}\nSource: ${sourceLink(source)}`;
}

function allThreadCapabilities(capabilities: DiscordProgressCapabilities): boolean {
  return (
    capabilities.createPublicThreads &&
    capabilities.sendMessagesInThreads &&
    capabilities.manageThreads
  );
}

function retainedThreadId(record: ProgressObservationRecord): string | undefined {
  return record.destination?.kind === "thread"
    ? record.destination.threadId
    : record.expectedThreadId;
}

function isTerminalObservation(record: ProgressObservationRecord): boolean {
  return (
    record.state === "completed" || record.state === "interrupted" || record.state === "failed"
  );
}

function beginResult(
  kind: ProgressBeginResult["kind"],
  durable: boolean,
  reused: boolean,
): ProgressBeginResult {
  return Object.freeze({ durable, kind, reused });
}

function boundedRuntimeError(message: string): BridgeError {
  return new BridgeError("RUNTIME", message);
}

export class DiscordProgressController {
  private readonly active = new Map<string, ActiveObservation>();
  private readonly beginning = new Map<string, Promise<ProgressBeginResult>>();
  private readonly botUserId: string;
  private readonly createPump: (destination: ProgressPumpDestination) => ProgressPump;
  private readonly heartbeatIntervalMs: number;
  private readonly journal: ProgressObservationJournalPort;
  private readonly now: () => Date;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly quiesceWaitMs: number;
  private readonly reconciliationLimit: number;
  private readonly redirectCooldownMs: number;
  private readonly redirectLastSent = new Map<string, number>();
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly terminalGraceMs: number;
  private readonly timers: DiscordProgressControllerTimers;
  private readonly transport: DiscordProgressTransport;
  private quiescing = false;
  private stopPromise: Promise<void> | undefined;

  constructor(options: DiscordProgressControllerOptions) {
    this.botUserId = options.botUserId;
    this.journal = options.journal;
    this.transport = options.transport;
    this.createPump = options.createPump ?? ((destination) => new DiscordProgressPump(destination));
    this.heartbeatIntervalMs = configuredInteger(
      options.heartbeatIntervalMs,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
      MAX_CONFIGURED_TIMEOUT_MS,
      "heartbeat interval",
    );
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError;
    this.sleep = options.sleep ?? defaultSleep;
    this.terminalGraceMs = configuredInteger(
      options.terminalGraceMs,
      DEFAULT_TERMINAL_GRACE_MS,
      MAX_CONFIGURED_TIMEOUT_MS,
      "terminal grace",
    );
    this.reconciliationLimit = configuredInteger(
      options.reconciliationLimit,
      DEFAULT_RECONCILIATION_LIMIT,
      MAX_CONFIGURED_LIMIT,
      "reconciliation limit",
    );
    this.redirectCooldownMs = configuredInteger(
      options.redirectCooldownMs,
      DEFAULT_REDIRECT_COOLDOWN_MS,
      MAX_CONFIGURED_TIMEOUT_MS,
      "redirect cooldown",
    );
    this.quiesceWaitMs = configuredInteger(
      options.quiesceWaitMs,
      DEFAULT_QUIESCE_WAIT_MS,
      MAX_CONFIGURED_TIMEOUT_MS,
      "quiesce wait",
    );
    this.timers = options.timers ?? defaultTimers;
  }

  async initializeAfterLogin(): Promise<void> {
    const timestamp = this.timestamp();
    try {
      await this.journal.initialize(timestamp);
      const active = await this.journal.listActive();
      for (const record of active) {
        const state = record.state === "running" ? "interrupted" : "failed";
        const destination =
          record.destination ?? (await this.confirmRestartedThreadCreation(record, timestamp));
        await this.reportRestartTerminal(record, state, destination);
        await this.journal.close(record.source.messageId, state, timestamp);
        if (destination?.kind === "thread") {
          await this.closeProgressThread(destination, false);
        }
      }
      await this.reconcileTerminalTombstones();
    } catch (error) {
      throw boundedRuntimeError(
        error instanceof BridgeError
          ? "Progress journal startup failed."
          : "Progress controller startup failed.",
      );
    }
  }

  async reconcileTerminalTombstones(): Promise<void> {
    const requested = await this.journal.listRequestedTombstoneReconciliations(
      this.reconciliationLimit,
    );
    const page = await this.journal.listTerminalTombstones({
      limit: this.reconciliationLimit,
    });
    const records = [...requested, ...page.records];
    const inspected = new Set<string>();
    for (const record of records) {
      const threadId = retainedThreadId(record);
      if (threadId === undefined || inspected.has(threadId)) continue;
      inspected.add(threadId);
      try {
        const inspection = await this.transport.inspectThread(threadId);
        if (inspection.status === "not-found") {
          await this.journal.removeDeletedThreadTombstone(threadId);
        }
      } catch (error) {
        this.report(error);
      }
    }
  }

  begin(input: DiscordProgressControllerSource): Promise<ProgressBeginResult> {
    const parsed = sourceFrom(input);
    const existingActive = this.active.get(parsed.source.messageId);
    if (existingActive !== undefined) {
      return Promise.resolve(beginResult(existingActive.kind, existingActive.durable, true));
    }
    const existingBegin = this.beginning.get(parsed.source.messageId);
    if (existingBegin !== undefined) {
      return existingBegin.then((result) => beginResult(result.kind, result.durable, true));
    }
    const operation = this.beginParsed(parsed).finally(() => {
      if (this.beginning.get(parsed.source.messageId) === operation) {
        this.beginning.delete(parsed.source.messageId);
      }
    });
    this.beginning.set(parsed.source.messageId, operation);
    return operation;
  }

  private async beginParsed(parsed: ReturnType<typeof sourceFrom>): Promise<ProgressBeginResult> {
    if (this.quiescing) {
      const observation = this.noneObservation(parsed, false);
      this.active.set(parsed.source.messageId, observation);
      return beginResult("none", false, false);
    }

    let prior: ProgressObservationRecord | undefined;
    let record: ProgressObservationRecord;
    try {
      prior = await this.journal.get(parsed.source.messageId);
      record = await this.journal.beginCreation({
        createdAt: this.timestamp(),
        source: parsed.source,
        threadCreationExpected: parsed.controllerSource.location === "guild",
      });
    } catch {
      return this.beginWithoutJournal(parsed);
    }

    if (prior !== undefined && isTerminalObservation(record)) {
      return beginResult(
        record.destination?.kind ?? "none",
        record.destination !== undefined,
        true,
      );
    }

    if (record.destination !== undefined) {
      const reused = await this.beginFromDestination(parsed, record.destination, true);
      if (reused !== undefined) return beginResult(reused.kind, reused.durable, true);
      return this.fallbackAfterFailure(parsed, true);
    }

    if (parsed.controllerSource.location !== "guild") {
      const inPlace = await this.beginInPlace(parsed, true);
      if (inPlace !== undefined) {
        return beginResult(inPlace.kind, inPlace.durable, prior !== undefined);
      }
      return this.noDisplay(parsed, true, prior !== undefined);
    }

    let capabilities: DiscordProgressCapabilities;
    try {
      capabilities = await this.transport.inspectProgressCapabilities(parsed.source.channelId);
    } catch {
      const fallback = await this.beginInPlace(parsed, true);
      if (fallback !== undefined) return beginResult(fallback.kind, fallback.durable, false);
      return this.noDisplay(parsed, true, false);
    }
    if (!allThreadCapabilities(capabilities)) {
      const fallback = await this.beginInPlace(parsed, true);
      if (fallback !== undefined) return beginResult(fallback.kind, fallback.durable, false);
      return this.noDisplay(parsed, true, false);
    }

    try {
      const thread = await this.transport.createProgressThread(
        parsed.source.channelId,
        parsed.source.messageId,
        { autoArchiveDuration: 1_440 },
      );
      this.validateCreatedThread(parsed.source, thread);
      const destination: ProgressDestination = {
        kind: "thread",
        ownerId: thread.ownerId,
        parentChannelId: thread.parentId,
        threadId: thread.id,
      };
      await this.journal.confirmDestination(parsed.source.messageId, destination, this.timestamp());
      const observation = await this.beginFromDestination(parsed, destination, true);
      if (observation !== undefined) {
        return beginResult("thread", true, false);
      }
    } catch (error) {
      this.report(error);
    }
    return this.fallbackAfterFailure(parsed, true);
  }

  async preparing(source: TurnProgressSource): Promise<void> {
    const observation = this.observation(source);
    if (observation.durable) {
      await this.journal.markPreparing(observation.source.messageId, this.timestamp());
    }
    await this.pushState(observation, "preparing");
  }

  async queued(source: TurnProgressSource): Promise<void> {
    const observation = this.observation(source);
    if (observation.durable) {
      await this.journal.markQueued(observation.source.messageId, this.timestamp());
    }
    await this.pushState(observation, "queued");
  }

  async running(source: TurnProgressSource): Promise<void> {
    await this.pushState(this.observation(source), "running");
  }

  async bindTurn(source: TurnProgressSource, turnId: string): Promise<void> {
    const observation = this.observation(source);
    if (observation.durable) {
      await this.journal.markRunning(observation.source.messageId, turnId, this.timestamp());
    }
    await this.pushState(observation, "running");
  }

  async event(source: TurnProgressSource, event: TurnProgressEvent): Promise<void> {
    const observation = this.observation(source);
    this.touch(observation);
    await observation.pump?.push(renderTurnProgressEvent(event));
  }

  decorateFinalText(source: TurnProgressSource, text: string): string {
    if (text.length === 0) return text;
    const observation = this.observation(source);
    const link = progressThreadLink(observation.source, observation.destination);
    if (link === undefined || text.includes(link)) return text;
    return `Progress: ${link}\n\n${text}`;
  }

  deliver(
    source: TurnProgressSource,
    operation: ProgressDeliveryOperation,
  ): Promise<DiscordDeliveryReceipt> {
    const observation = this.observation(source);
    return this.serializeDelivery(observation, async () => {
      if (!observation.durable) {
        const first = observation.localAcceptedDeliveries === 0;
        const receipt = createDiscordDeliveryReceipt(
          await operation(first ? { replyToMessageId: observation.source.messageId } : {}),
        );
        observation.localAcceptedDeliveries += 1;
        observation.firstAcceptedReceipt ??= receipt;
        return receipt;
      }

      const reservation = await this.journal.beginDelivery(
        observation.source.messageId,
        this.timestamp(),
      );
      let receipt: DiscordDeliveryReceipt;
      try {
        receipt = createDiscordDeliveryReceipt(
          await operation(
            reservation.first ? { replyToMessageId: observation.source.messageId } : {},
          ),
        );
      } catch (error) {
        try {
          await this.journal.markDeliveryFailed(
            observation.source.messageId,
            reservation.sequence,
            this.timestamp(),
          );
        } catch {
          throw boundedRuntimeError("Final delivery failure could not be persisted.");
        }
        throw error;
      }
      try {
        await this.journal.acceptDelivery(
          observation.source.messageId,
          reservation.sequence,
          receipt,
          this.timestamp(),
        );
      } catch {
        try {
          await this.journal.markDeliveryUncertain(
            observation.source.messageId,
            reservation.sequence,
            this.timestamp(),
          );
        } catch {
          // Startup still converts a retained sending operation to uncertain.
        }
        throw boundedRuntimeError("Final delivery receipt could not be persisted.");
      }
      observation.firstAcceptedReceipt ??= receipt;
      return receipt;
    });
  }

  async terminal(source: TurnProgressSource, terminal: TurnProgressTerminal): Promise<void> {
    const observation = this.observation(source);
    if (observation.terminal) return;
    observation.terminal = true;
    this.clearHeartbeat(observation);
    await observation.deliveryTail;
    const receiptLink = deliveryReceiptLink(observation.source, observation.firstAcceptedReceipt);
    const rendered = renderTurnProgressEvent(
      receiptLink === undefined
        ? terminal
        : {
            ...terminal,
            message:
              terminal.message === undefined
                ? `Final response: ${receiptLink}`
                : `${terminal.message}\nFinal response: ${receiptLink}`,
          },
    );
    await observation.pump?.terminal({ text: rendered.text, type: "terminal" });

    const terminalState =
      terminal.status === "completed"
        ? "completed"
        : terminal.status === "interrupted"
          ? "interrupted"
          : "failed";
    let journalClosed = !observation.journalOwned;
    if (observation.journalOwned) {
      try {
        await this.journal.close(
          observation.source.messageId,
          observation.durable ? terminalState : "failed",
          this.timestamp(),
        );
        journalClosed = true;
      } catch (error) {
        this.report(error);
      }
    }

    if (journalClosed && observation.destination?.kind === "thread") {
      await this.closeProgressThread(observation.destination);
    }
    await observation.pump?.stop();
    this.active.delete(observation.source.messageId);
  }

  async isProgressOnlyThread(event: DiscordProgressThreadIngress): Promise<boolean> {
    if (event.location !== "thread") return false;
    if (!(await this.journal.isProgressThread(event.channelId))) return false;
    const inspection = await this.transport.inspectThread(event.channelId);
    if (
      inspection.status !== "found" ||
      inspection.id !== event.channelId ||
      inspection.ownerId !== this.botUserId ||
      event.parentChannelId === undefined ||
      inspection.parentId !== event.parentChannelId ||
      (event.threadOwnerId !== undefined && event.threadOwnerId !== inspection.ownerId)
    ) {
      throw new BridgeError(
        "CONFIGURATION",
        "Discord progress thread provenance does not match the durable journal.",
      );
    }
    return true;
  }

  async redirectProgressThreadInput(event: DiscordProgressThreadIngress): Promise<void> {
    if (event.location !== "thread") return;
    const now = this.now().getTime();
    const previous = this.redirectLastSent.get(event.channelId);
    if (previous !== undefined && now - previous < this.redirectCooldownMs) return;
    this.redirectLastSent.set(event.channelId, now);
    try {
      await this.transport.sendMessage(event.channelId, {
        content: PROGRESS_THREAD_REDIRECT,
      });
    } catch (error) {
      this.report(error);
    }
  }

  async quiesce(): Promise<void> {
    this.quiescing = true;
    await this.waitBounded(
      Promise.allSettled([
        ...this.beginning.values(),
        ...[...this.active.values()].map((observation) => observation.deliveryTail),
      ]),
      this.quiesceWaitMs,
    );
  }

  stop(): Promise<void> {
    if (this.stopPromise !== undefined) return this.stopPromise;
    this.stopPromise = (async () => {
      await this.quiesce();
      await Promise.allSettled(
        [...this.active.values()].map((observation) => {
          this.clearHeartbeat(observation);
          return observation.pump?.stop();
        }),
      );
      this.active.clear();
      this.redirectLastSent.clear();
    })();
    return this.stopPromise;
  }

  private async beginWithoutJournal(parsed: ReturnType<typeof sourceFrom>) {
    const inPlace = await this.beginInPlace(parsed, false);
    if (inPlace !== undefined) return beginResult("inPlace", inPlace.durable, false);
    return this.noDisplay(parsed, false, false);
  }

  private async fallbackAfterFailure(
    parsed: ReturnType<typeof sourceFrom>,
    journalOwned: boolean,
  ): Promise<ProgressBeginResult> {
    let retainedDestination: ProgressDestination | undefined;
    let canConfirm = false;
    if (journalOwned) {
      try {
        const record = await this.journal.get(parsed.source.messageId);
        retainedDestination = record?.destination;
        canConfirm = record !== undefined && record.destination === undefined;
      } catch (error) {
        this.report(error);
      }
    }
    const inPlace = await this.beginInPlace(
      parsed,
      canConfirm,
      undefined,
      journalOwned,
      retainedDestination,
    );
    if (inPlace !== undefined) return beginResult("inPlace", inPlace.durable, false);
    return this.noDisplay(parsed, journalOwned, false);
  }

  private async noDisplay(
    parsed: ReturnType<typeof sourceFrom>,
    journalOwned: boolean,
    reused: boolean,
  ): Promise<ProgressBeginResult> {
    try {
      await this.transport.sendMessage(parsed.source.channelId, {
        content: PROGRESS_UNAVAILABLE_NOTICE,
      });
    } catch (error) {
      this.report(error);
    }
    this.active.set(parsed.source.messageId, this.noneObservation(parsed, journalOwned));
    return beginResult("none", false, reused);
  }

  private noneObservation(
    parsed: ReturnType<typeof sourceFrom>,
    journalOwned: boolean,
  ): ActiveObservation {
    return {
      controllerSource: parsed.controllerSource,
      deliveryTail: Promise.resolve(),
      durable: false,
      journalOwned,
      kind: "none",
      lastObservedAt: this.nowMilliseconds(),
      localAcceptedDeliveries: 0,
      source: parsed.source,
      terminal: false,
    };
  }

  private async beginInPlace(
    parsed: ReturnType<typeof sourceFrom>,
    durableIntent: boolean,
    existing?: Extract<ProgressDestination, { kind: "inPlace" }>,
    journalOwned = durableIntent,
    retainedDestination?: ProgressDestination,
  ): Promise<ActiveObservation | undefined> {
    let acceptedStatusId: string | undefined;
    const destination: ProgressPumpDestination = {
      createStatus: async (content) => {
        const receipt =
          existing === undefined
            ? await this.transport.sendMessage(parsed.source.channelId, { content })
            : await this.transport.editMessage(existing.channelId, existing.messageId, { content });
        acceptedStatusId = receipt.id;
        return receipt;
      },
      editStatus: async (messageId, content) =>
        this.transport.editMessage(parsed.source.channelId, messageId, { content }),
      append: async () => {
        if (acceptedStatusId === undefined) {
          throw boundedRuntimeError("In-place progress status is unavailable.");
        }
        return { id: acceptedStatusId };
      },
    };
    const pump = this.createPump(destination);
    await pump.start(initialStatus(parsed.source));
    if (acceptedStatusId === undefined) {
      await pump.stop();
      return undefined;
    }
    const confirmed: ProgressDestination = {
      channelId: parsed.source.channelId,
      kind: "inPlace",
      messageId: acceptedStatusId,
    };
    let durable = durableIntent;
    if (durableIntent && existing === undefined) {
      try {
        await this.journal.confirmDestination(parsed.source.messageId, confirmed, this.timestamp());
      } catch (error) {
        durable = false;
        this.report(error);
      }
    }
    const observation: ActiveObservation = {
      controllerSource: parsed.controllerSource,
      deliveryTail: Promise.resolve(),
      destination: retainedDestination ?? confirmed,
      durable,
      journalOwned,
      kind: "inPlace",
      lastObservedAt: this.nowMilliseconds(),
      localAcceptedDeliveries: 0,
      pump,
      source: parsed.source,
      terminal: false,
    };
    this.activate(observation);
    return observation;
  }

  private async beginFromDestination(
    parsed: ReturnType<typeof sourceFrom>,
    destination: ProgressDestination,
    durable: boolean,
  ): Promise<ActiveObservation | undefined> {
    if (destination.kind === "inPlace") {
      return this.beginInPlace(parsed, durable, destination);
    }
    let statusAccepted = false;
    const pumpDestination: ProgressPumpDestination = {
      createStatus: async (content) => {
        const receipt = await this.transport.sendMessage(destination.threadId, { content });
        statusAccepted = true;
        return receipt;
      },
      editStatus: async (messageId, content) =>
        this.transport.editMessage(destination.threadId, messageId, { content }),
      append: async (content) => this.transport.sendMessage(destination.threadId, { content }),
    };
    const pump = this.createPump(pumpDestination);
    await pump.start(initialStatus(parsed.source));
    if (!statusAccepted) {
      await pump.stop();
      return undefined;
    }
    const observation: ActiveObservation = {
      controllerSource: parsed.controllerSource,
      deliveryTail: Promise.resolve(),
      destination,
      durable,
      journalOwned: true,
      kind: "thread",
      lastObservedAt: this.nowMilliseconds(),
      localAcceptedDeliveries: 0,
      pump,
      source: parsed.source,
      terminal: false,
    };
    this.activate(observation);
    return observation;
  }

  private validateCreatedThread(source: TurnProgressSource, thread: DiscordProgressThread): void {
    if (
      thread.id !== source.messageId ||
      thread.parentId !== source.channelId ||
      thread.ownerId !== this.botUserId
    ) {
      throw new BridgeError(
        "CONFIGURATION",
        "Discord created a progress thread with unexpected provenance.",
      );
    }
  }

  private observation(sourceInput: TurnProgressSource): ActiveObservation {
    const source = createTurnProgressSource({
      channelId: sourceInput.channelId,
      ...(sourceInput.guildId === undefined ? {} : { guildId: sourceInput.guildId }),
      messageId: sourceInput.messageId,
    });
    const observation = this.active.get(source.messageId);
    if (
      observation === undefined ||
      observation.source.channelId !== source.channelId ||
      observation.source.guildId !== source.guildId
    ) {
      throw new BridgeError("NOT_FOUND", "Progress observation was not found.");
    }
    return observation;
  }

  private async pushState(
    observation: ActiveObservation,
    state: "preparing" | "queued" | "running",
  ): Promise<void> {
    this.touch(observation);
    await observation.pump?.push(renderTurnProgressEvent({ state, type: "state" }));
  }

  private activate(observation: ActiveObservation): void {
    this.active.set(observation.source.messageId, observation);
    if (observation.pump === undefined) return;
    observation.heartbeatTimer = this.timers.setInterval(() => {
      if (observation.terminal || this.active.get(observation.source.messageId) !== observation) {
        return;
      }
      void observation.pump
        ?.heartbeat(observation.lastObservedAt)
        .catch((error) => this.report(error));
    }, this.heartbeatIntervalMs);
  }

  private touch(observation: ActiveObservation): void {
    observation.lastObservedAt = this.nowMilliseconds();
  }

  private clearHeartbeat(observation: ActiveObservation): void {
    if (observation.heartbeatTimer === undefined) return;
    this.timers.clearInterval(observation.heartbeatTimer);
    observation.heartbeatTimer = undefined;
  }

  private serializeDelivery(
    observation: ActiveObservation,
    operation: () => Promise<DiscordDeliveryReceipt>,
  ): Promise<DiscordDeliveryReceipt> {
    const pending = observation.deliveryTail.then(operation);
    observation.deliveryTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private async closeProgressThread(
    destination: Extract<ProgressDestination, { kind: "thread" }>,
    waitForGrace = true,
  ): Promise<void> {
    if (waitForGrace) await this.sleep(this.terminalGraceMs);
    try {
      const inspection = await this.transport.inspectThread(destination.threadId);
      this.assertThreadDestination(inspection, destination);
      await this.transport.setProgressThreadState(destination.threadId, {
        archived: true,
        locked: true,
      });
    } catch (error) {
      this.report(error);
    }
  }

  private async reportRestartTerminal(
    record: ProgressObservationRecord,
    status: Extract<ObservationState, "interrupted" | "failed">,
    destination: ProgressDestination | undefined,
  ): Promise<void> {
    if (destination === undefined) return;
    const uncertain = record.delivery.current?.status === "uncertain";
    const rendered = renderTurnProgressEvent({
      message: uncertain
        ? "Runner restarted before final delivery was confirmed. Final delivery may be partial or uncertain. Check the parent conversation; no output was replayed."
        : status === "failed"
          ? "Runner restarted before this turn started. The turn was not resumed."
          : "Runner restarted before this turn finished. The turn was not resumed.",
      status,
      type: "terminal",
    });
    try {
      if (destination.kind === "thread") {
        await this.transport.sendMessage(destination.threadId, {
          content: rendered.text,
        });
      } else {
        await this.transport.editMessage(destination.channelId, destination.messageId, {
          content: rendered.text,
        });
      }
    } catch (error) {
      this.report(error);
    }
  }

  private async confirmRestartedThreadCreation(
    record: ProgressObservationRecord,
    timestamp: string,
  ): Promise<Extract<ProgressDestination, { kind: "thread" }> | undefined> {
    if (record.expectedThreadId === undefined) return undefined;
    let inspection: DiscordThreadInspection;
    try {
      inspection = await this.transport.inspectThread(record.expectedThreadId);
      if (inspection.status === "not-found") return undefined;
    } catch (error) {
      this.report(error);
      return undefined;
    }
    const destination: Extract<ProgressDestination, { kind: "thread" }> = {
      kind: "thread",
      ownerId: this.botUserId,
      parentChannelId: record.source.channelId,
      threadId: record.expectedThreadId,
    };
    try {
      this.assertThreadDestination(inspection, destination);
    } catch (error) {
      this.report(error);
      return undefined;
    }
    await this.journal.confirmDestination(record.source.messageId, destination, timestamp);
    return destination;
  }

  private assertThreadDestination(
    inspection: DiscordThreadInspection,
    destination: Extract<ProgressDestination, { kind: "thread" }>,
  ): void {
    if (
      inspection.status !== "found" ||
      inspection.id !== destination.threadId ||
      inspection.ownerId !== destination.ownerId ||
      inspection.parentId !== destination.parentChannelId ||
      inspection.ownerId !== this.botUserId
    ) {
      throw new BridgeError(
        "CONFIGURATION",
        "Discord progress thread closure provenance did not match.",
      );
    }
  }

  private timestamp(): string {
    return new Date(this.nowMilliseconds()).toISOString();
  }

  private nowMilliseconds(): number {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new BridgeError("RUNTIME", "Progress controller clock is invalid.");
    }
    return value.getTime();
  }

  private report(error: unknown): void {
    try {
      this.onError?.(error);
    } catch {
      // Diagnostic hooks never affect progress or final delivery.
    }
  }

  private async waitBounded(pending: Promise<unknown>, milliseconds: number): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const bounded = new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, milliseconds);
    });
    try {
      await Promise.race([pending.then(() => undefined), bounded]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}
