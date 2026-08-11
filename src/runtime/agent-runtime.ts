import type { ServerRequestResult } from "../app-server/protocol.js";
import type {
  AuthorizedDiscordSendFileArguments,
  CodexModelCatalogEntry,
  CodexSessionEvent,
  CodexTurnSettings,
  DiscordTurnSource,
} from "../app-server/session.js";
import { formatDiscordTurnInput, MAX_DISCORD_ATTACHMENTS } from "../discord/format.js";
import { BridgeError } from "../domain/errors.js";
import type { AgentModelSettings, WorkspaceProfile } from "../domain/schemas.js";
import type { AuthorizedOutboundFile } from "../manager/workspaces.js";
import { TurnFileDeliveryCoordinator } from "./file-delivery.js";
import {
  type ModelSettingsStatus,
  type ModelSummary,
  resolveModelSettings,
  selectVisibleModel,
} from "./model-settings.js";
import {
  createTurnProgressEvent,
  createTurnProgressSource,
  type DiscordDeliveryReceipt,
  type TurnProgressEvent,
  type TurnProgressPort,
  type TurnProgressSource,
} from "./turn-progress.js";
import { type TurnInput, type TurnItem, TurnQueue } from "./turn-queue.js";

export type AgentRuntimeState = "stopped" | "starting" | "running" | "recovering" | "failed";

export class AgentRuntimeSessionError extends BridgeError {
  constructor(
    message: string,
    readonly orphanThreadId?: string,
  ) {
    super("RUNTIME", message, "Inspect the registry and reconcile the Codex session.");
    this.name = "AgentRuntimeSessionError";
  }
}

export interface AgentRuntimeBinding {
  readonly id: string;
  readonly threadId: string;
  readonly workspace: WorkspaceProfile;
  readonly inbox: string;
  readonly modelId?: string;
  readonly reasoningEffort?: string;
}

export type ModelSelection =
  | { readonly kind: "default" }
  | { readonly kind: "model"; readonly id: string };
export type ReasoningSelection =
  | { readonly kind: "default" }
  | { readonly kind: "effort"; readonly value: string };

export type AgentRuntimeEvent = CodexSessionEvent;

export interface AgentRuntimeSendFileRequest {
  readonly threadId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly arguments: unknown;
}

export type AgentRuntimeSendFileResult = ServerRequestResult<"item/tool/call">;

export interface AgentRuntimeSession {
  listModels(): Promise<readonly CodexModelCatalogEntry[]>;
  resume(threadId: string, workspace: WorkspaceProfile, inbox: string): Promise<void>;
  startTurn(
    threadId: string,
    input: string,
    source: DiscordTurnSource,
    settings: CodexTurnSettings,
  ): Promise<{ turnId: string }>;
  interrupt(threadId: string, turnId: string): Promise<void>;
  onNotification(
    method: AgentRuntimeEvent["method"],
    listener: (event: AgentRuntimeEvent) => void,
  ): () => void;
  onSendFileRequest(
    listener: (
      request: AgentRuntimeSendFileRequest,
    ) => Promise<AgentRuntimeSendFileResult> | AgentRuntimeSendFileResult,
  ): () => void;
  authorizeSendFile(threadId: string, input: unknown): Promise<AuthorizedDiscordSendFileArguments>;
  parseFileMarkers?(
    threadId: string,
    text: string,
    item: TurnItem,
  ): Promise<{ visibleText: string; files: AuthorizedOutboundFile[] }>;
  start?(
    workspace: WorkspaceProfile,
    inbox: string,
    creationKey: string,
  ): Promise<{ threadId: string }>;
  dispose?(): void;
}

export interface AgentRuntimeRegistry {
  readBinding(): Promise<AgentRuntimeBinding>;
  markState(state: AgentRuntimeState): Promise<void>;
  replaceThread(bindingId: string, threadId: string): Promise<AgentRuntimeBinding>;
  updateModelSettings(
    bindingId: string,
    settings: AgentModelSettings,
  ): Promise<AgentRuntimeBinding>;
}

export interface AgentRuntimeAppServer {
  start(): Promise<AgentRuntimeSession>;
  stop(): Promise<void>;
}

export interface AgentRuntimeOutput {
  sendText(
    channelId: string,
    messageId: string,
    text: string,
    dispatch?: AgentRuntimeDeliveryDispatch,
  ): Promise<readonly DiscordDeliveryReceipt[]>;
  sendFile?(
    channelId: string,
    messageId: string,
    file: AuthorizedOutboundFile,
    message?: string,
    signal?: AbortSignal,
    dispatch?: AgentRuntimeDeliveryDispatch,
  ): Promise<DiscordDeliveryReceipt>;
  report?(channelId: string, messageId: string, text: string): Promise<void>;
  reportOrphanThread?(threadId: string): Promise<void>;
}

export interface AgentRuntimeDeliveryDirective {
  readonly replyToMessageId?: string;
}

export type AgentRuntimeDeliveryOperation = (
  directive: AgentRuntimeDeliveryDirective,
) => Promise<DiscordDeliveryReceipt>;

export type AgentRuntimeDeliveryDispatch = (
  operation: AgentRuntimeDeliveryOperation,
) => Promise<DiscordDeliveryReceipt>;

export interface AgentRuntimePorts {
  readonly registry: AgentRuntimeRegistry;
  readonly appServer: AgentRuntimeAppServer;
  readonly output: AgentRuntimeOutput;
  readonly progress?: AgentRuntimeProgressPort;
}

export interface AgentRuntimeProgressPort extends TurnProgressPort {
  decorateFinalText?(source: TurnProgressSource, text: string): string;
  deliver?(
    source: TurnProgressSource,
    operation: AgentRuntimeDeliveryOperation,
  ): Promise<DiscordDeliveryReceipt>;
}

export interface AgentRuntimeClock {
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

export interface AgentRuntimeOptions {
  readonly clock?: AgentRuntimeClock;
  readonly maxQueueDepth?: number;
  readonly maxBufferCharacters?: number;
  readonly maxPendingStartCharacters?: number;
  readonly maxPendingStartEntries?: number;
  readonly maxPendingStartToolCalls?: number;
  readonly pendingStartTimeoutMs?: number;
  readonly maxRecoveryAttempts?: number;
  readonly recoveryBaseDelayMs?: number;
  readonly stopTimeoutMs?: number;
}

interface TurnState {
  readonly item: TurnItem;
  readonly generation: number;
  readonly items: Map<string, ItemState>;
  readonly fileDelivery: TurnFileDeliveryCoordinator;
  readonly finalDeliveryController: AbortController;
  readonly finalFiles: Set<AuthorizedOutboundFile>;
  readonly closedFinalFiles: Set<AuthorizedOutboundFile>;
  totalCharacters: number;
  completionStarted: boolean;
  outcome: "completed" | "interrupted" | "failed";
  progressTerminalStarted: boolean;
  settled: boolean;
  resolve?: () => void;
  reject?: (error: unknown) => void;
}

interface ItemState {
  readonly itemId: string;
  text: string;
  files: AuthorizedOutboundFile[];
  completed: boolean;
  phase?: "commentary" | "final_answer";
}

interface PendingStartDeferred {
  readonly promise: Promise<AgentRuntimeSendFileResult>;
  readonly resolve: (result: AgentRuntimeSendFileResult) => void;
}

type PendingStartEntry =
  | {
      readonly kind: "notification";
      readonly sequence: number;
      readonly event: Exclude<AgentRuntimeEvent, { method: "warning" }>;
    }
  | {
      readonly kind: "warning";
      readonly sequence: number;
      readonly event: Extract<AgentRuntimeEvent, { method: "warning" }>;
    }
  | {
      readonly kind: "toolRequest";
      readonly sequence: number;
      readonly request: AgentRuntimeSendFileRequest;
      readonly deferred: PendingStartDeferred;
    };

interface PendingStartBarrier {
  readonly generation: number;
  readonly session: AgentRuntimeSession;
  readonly item: TurnItem;
  readonly threadId: string;
  readonly entries: PendingStartEntry[];
  readonly failurePromise: Promise<never>;
  readonly rejectFailure: (error: BridgeError) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  characters: number;
  nextSequence: number;
  terminalSeen: boolean;
  toolCalls: number;
  warningAnchored: boolean;
  warningRequiresAnchor: boolean;
  failure?: BridgeError;
}

const DEFAULT_BUFFER = 256 * 1024;
const DEFAULT_PENDING_START_CHARACTERS = 256 * 1024;
const DEFAULT_PENDING_START_ENTRIES = 512;
const DEFAULT_PENDING_START_TOOL_CALLS = 16;
const DEFAULT_PENDING_START_TIMEOUT = 30_000;
const DEFAULT_RECOVERY_ATTEMPTS = 3;
const DEFAULT_BACKOFF = 100;
const DEFAULT_STOP_TIMEOUT = 5_000;
const noopClock: AgentRuntimeClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export class AgentRuntime {
  private readonly ports: AgentRuntimePorts;
  private readonly clock: AgentRuntimeClock;
  private readonly maxBufferCharacters: number;
  private readonly maxPendingStartCharacters: number;
  private readonly maxPendingStartEntries: number;
  private readonly maxPendingStartToolCalls: number;
  private readonly pendingStartTimeoutMs: number;
  private readonly maxRecoveryAttempts: number;
  private readonly recoveryBaseDelayMs: number;
  private readonly stopTimeoutMs: number;
  private lifecycle: Promise<void> = Promise.resolve();
  private session: AgentRuntimeSession | undefined;
  private binding: AgentRuntimeBinding | undefined;
  private catalog: readonly CodexModelCatalogEntry[] | undefined;
  private unsubscribe: Array<() => void> = [];
  private active: { item: TurnItem; turnId: string; generation: number } | undefined;
  private sessionGeneration = 0;
  private lastTerminalGeneration = 0;
  private pendingStart: PendingStartBarrier | undefined;
  private turns = new Map<string, TurnState>();
  private readonly terminalItems = new WeakSet<TurnItem>();
  private deliveryPaused = false;
  private pendingControls = 0;
  state: AgentRuntimeState = "stopped";
  readonly queue: TurnQueue<void>;

  constructor(ports: AgentRuntimePorts, options: AgentRuntimeOptions = {}) {
    validateOptions(options);
    if (typeof ports.output.reportOrphanThread !== "function") {
      throw new BridgeError("INVALID_ARGUMENT", "Agent runtime requires orphan thread reporting.");
    }
    this.ports = ports;
    this.clock = options.clock ?? noopClock;
    this.maxBufferCharacters = options.maxBufferCharacters ?? DEFAULT_BUFFER;
    this.maxPendingStartCharacters =
      options.maxPendingStartCharacters ?? DEFAULT_PENDING_START_CHARACTERS;
    this.maxPendingStartEntries = options.maxPendingStartEntries ?? DEFAULT_PENDING_START_ENTRIES;
    this.maxPendingStartToolCalls =
      options.maxPendingStartToolCalls ?? DEFAULT_PENDING_START_TOOL_CALLS;
    this.pendingStartTimeoutMs = options.pendingStartTimeoutMs ?? DEFAULT_PENDING_START_TIMEOUT;
    this.maxRecoveryAttempts = options.maxRecoveryAttempts ?? DEFAULT_RECOVERY_ATTEMPTS;
    this.recoveryBaseDelayMs = options.recoveryBaseDelayMs ?? DEFAULT_BACKOFF;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT;
    this.queue = new TurnQueue<void>({
      ...(options.maxQueueDepth === undefined ? {} : { maxDepth: options.maxQueueDepth }),
      run: (item) => this.runTurn(item),
      interrupt: () => this.interrupt(),
    });
  }

  enqueue(input: TurnInput): Promise<void> {
    if (this.state !== "running" || this.deliveryPaused || this.pendingControls > 0) {
      throw new BridgeError("CONFLICT", "Agent runtime is not accepting turns.");
    }
    return this.queue.enqueue(input);
  }

  start(): Promise<void> {
    return this.serial(async () => {
      if (this.state === "running") return;
      this.state = "starting";
      this.deliveryPaused = false;
      let serverStarted = false;
      try {
        const binding = await this.ports.registry.readBinding();
        validateTextId(binding.id, "binding ID");
        validateTextId(binding.threadId, "binding thread ID");
        const session = await this.ports.appServer.start();
        serverStarted = true;
        const catalog = await loadCatalog(session);
        await session.resume(binding.threadId, binding.workspace, binding.inbox);
        this.binding = binding;
        this.catalog = catalog;
        this.bindSession(session);
        this.session = session;
        this.state = "running";
        await this.ports.registry.markState("running");
      } catch (error) {
        this.clearSession();
        if (serverStarted) await this.ports.appServer.stop().catch(() => undefined);
        this.session = undefined;
        this.catalog = undefined;
        this.state = "failed";
        await this.ports.registry.markState("failed").catch(() => undefined);
        throw safeRuntimeError(error, "Agent runtime startup failed.");
      }
    });
  }

  async stop(): Promise<void> {
    await this.serial(async () => {
      if (this.state === "stopped") return;
      this.deliveryPaused = true;
      let primary: unknown;
      try {
        const discarded = this.queue.discardPending("runtime stopped");
        await this.reportDiscarded(discarded).catch(() => undefined);
        const pendingStart = this.pendingStart;
        if (pendingStart !== undefined) {
          this.failPendingStart(
            pendingStart,
            new BridgeError("CONFLICT", "Pending Codex turn start was stopped."),
          );
        }
        await this.interrupt();
        const idle = this.queue.idle();
        const completed = await boundedWait(idle, this.stopTimeoutMs, this.clock);
        if (!completed) {
          await this.failActive(
            new BridgeError("TIMEOUT", "Active Codex turn did not stop in time."),
          );
          await boundedWait(idle, this.stopTimeoutMs, this.clock);
        }
      } catch (error) {
        primary = error;
      } finally {
        if (primary !== undefined) {
          await this.failActive(safeRuntimeError(primary, "Agent runtime shutdown failed."));
        }
        this.clearSession();
        try {
          await this.ports.appServer.stop();
        } catch (error) {
          if (primary === undefined) primary = error;
        }
        this.state = "stopped";
        this.session = undefined;
        this.active = undefined;
        try {
          await this.ports.registry.markState("stopped");
        } catch (error) {
          if (primary === undefined) primary = error;
        }
      }
      if (primary !== undefined) {
        throw safeRuntimeError(primary, "Agent runtime shutdown failed.");
      }
    });
  }

  async interrupt(): Promise<void> {
    const active = this.active;
    if (!active || !this.session) return;
    const current = this.turns.get(active.turnId);
    if (current !== undefined) current.outcome = "interrupted";
    current?.fileDelivery.closeToNewRequests();
    current?.finalDeliveryController.abort(
      new BridgeError("CONFLICT", "Discord final file delivery was interrupted."),
    );
    const fileSettlement = current?.fileDelivery.abortAndWait(this.stopTimeoutMs);
    const finalFileClosure = current === undefined ? undefined : this.closeFinalFiles(current);
    let primary: unknown;
    try {
      await this.session.interrupt(this.binding?.threadId ?? "", active.turnId);
    } catch (error) {
      primary = error;
    }
    if (fileSettlement !== undefined && !(await fileSettlement)) {
      current?.fileDelivery.forceRelease();
    }
    await finalFileClosure;
    if (primary !== undefined) throw primary;
  }

  modelStatus(): ModelSettingsStatus {
    const binding = this.binding;
    const catalog = this.catalog;
    if (!binding || !catalog) {
      return Object.freeze({ configurationError: "Codex model settings are unavailable." });
    }
    const configured = configuredStatus(binding);
    try {
      return Object.freeze({
        ...configured,
        effective: resolveForBinding(binding, catalog),
      });
    } catch (error) {
      return Object.freeze({
        ...configured,
        configurationError:
          error instanceof BridgeError
            ? error.message
            : "Codex model settings could not be resolved.",
      });
    }
  }

  listModels(): readonly ModelSummary[] {
    const catalog = this.catalog;
    if (!catalog) {
      throw new BridgeError("CONFLICT", "Codex model catalog is unavailable.");
    }
    const current = this.modelStatus().effective?.modelId;
    return Object.freeze(
      catalog
        .filter((model) => !model.hidden)
        .map((model) =>
          Object.freeze({
            id: model.id,
            displayName: model.displayName,
            isDefault: model.isDefault,
            isCurrent: model.id === current,
            defaultReasoningEffort: model.defaultReasoningEffort,
            supportedReasoningEfforts: Object.freeze([...model.supportedReasoningEfforts]),
          }),
        ),
    );
  }

  setModel(selection: ModelSelection): Promise<ModelSettingsStatus> {
    return this.control(async () => {
      const { binding, catalog } = this.controlContext();
      let selected: CodexModelCatalogEntry;
      let modelId: string | undefined;
      if (selection.kind === "model") {
        selected = selectVisibleModel(catalog, selection.id);
        modelId = selected.id;
      } else {
        selected = effectiveEntry(
          resolveModelSettings({
            binding: {},
            ...(binding.workspace.model === undefined
              ? {}
              : { workspaceModel: binding.workspace.model }),
            catalog,
          }),
          catalog,
        );
      }
      const existingEffort = binding.reasoningEffort;
      const reasoningEffort =
        existingEffort !== undefined && selected.supportedReasoningEfforts.includes(existingEffort)
          ? existingEffort
          : undefined;
      const settings: AgentModelSettings = {
        ...(modelId === undefined ? {} : { modelId }),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      };
      resolveCandidate(binding, settings, catalog);
      const persisted = await this.persistModelSettings(binding.id, settings);
      this.binding = persisted;
      return this.modelStatus();
    });
  }

  setReasoningEffort(selection: ReasoningSelection): Promise<ModelSettingsStatus> {
    return this.control(async () => {
      const { binding, catalog } = this.controlContext();
      const settings: AgentModelSettings = {
        ...(binding.modelId === undefined ? {} : { modelId: binding.modelId }),
        ...(selection.kind === "effort" ? { reasoningEffort: selection.value } : {}),
      };
      if (selection.kind === "effort") {
        const effective = resolveCandidate(
          binding,
          binding.modelId === undefined ? {} : { modelId: binding.modelId },
          catalog,
        );
        if (!effective.supportedReasoningEfforts.includes(selection.value)) {
          throw new BridgeError(
            "INVALID_ARGUMENT",
            "The requested reasoning effort is unsupported by the selected model.",
          );
        }
      }
      const persisted = await this.persistModelSettings(binding.id, settings);
      this.binding = persisted;
      return this.modelStatus();
    });
  }

  async newSession(confirm: boolean, creationKey: string): Promise<{ threadId: string }> {
    return this.serial(async () => {
      if (!this.binding || !this.session)
        throw new BridgeError("CONFLICT", "Agent runtime is not running.");
      validateTextId(creationKey, "durable thread creation key");
      if (!confirm && this.queue.depth() > 0)
        throw new BridgeError(
          "CONFLICT",
          "Cannot replace an active or queued session without confirmation.",
        );
      this.deliveryPaused = true;
      try {
        if (confirm) {
          await this.interrupt();
          const discarded = this.queue.discardPending("session replaced");
          await this.reportDiscarded(discarded);
          const idle = this.queue.idle();
          if (!(await boundedWait(idle, this.stopTimeoutMs, this.clock))) {
            throw new BridgeError(
              "TIMEOUT",
              "Active Codex turn did not complete before session replacement.",
            );
          }
        }
        const oldBinding = this.binding;
        const oldSession = this.session;
        const creator = oldSession.start;
        if (!creator)
          throw new BridgeError("RUNTIME", "The session does not support thread creation.");
        const created = await creator.call(
          oldSession,
          oldBinding.workspace,
          oldBinding.inbox,
          creationKey,
        );
        let replaced: AgentRuntimeBinding;
        try {
          replaced = await this.ports.registry.replaceThread(oldBinding.id, created.threadId);
          if (replaced.threadId !== created.threadId) {
            throw new AgentRuntimeSessionError(
              `Registry replacement returned an unexpected thread for ${created.threadId}.`,
              created.threadId,
            );
          }
        } catch (error) {
          const failure =
            error instanceof AgentRuntimeSessionError
              ? error
              : new AgentRuntimeSessionError(
                  `Registry replacement failed after creating thread ${created.threadId}.`,
                  created.threadId,
                );
          await this.reportOrphan(created.threadId);
          throw failure;
        }
        this.binding = replaced;
        this.session = oldSession;
        try {
          await oldSession.resume(replaced.threadId, replaced.workspace, replaced.inbox);
        } catch (error) {
          await this.recover(error);
          this.deliveryPaused = false;
          return { threadId: created.threadId };
        }
        this.bindSession(oldSession);
        this.deliveryPaused = false;
        return { threadId: created.threadId };
      } catch (error) {
        this.deliveryPaused = false;
        if (error instanceof AgentRuntimeSessionError) throw error;
        throw safeRuntimeError(error, "Agent runtime session replacement failed.");
      }
    });
  }

  private async runTurn(item: TurnItem): Promise<void> {
    try {
      await this.runTurnActive(item);
    } catch (error) {
      if (!this.terminalItems.has(item)) {
        this.terminalItems.add(item);
        const interrupted = this.deliveryPaused;
        await this.forwardProgress(item, () =>
          this.ports.progress?.terminal(progressSourceFor(item), {
            ...(interrupted ? {} : { message: "Codex turn failed before final delivery." }),
            status: interrupted ? "interrupted" : "failed",
            type: "terminal",
          }),
        );
      }
      throw error;
    }
  }

  private async runTurnActive(item: TurnItem): Promise<void> {
    if (this.deliveryPaused) throw new BridgeError("CONFLICT", "Agent runtime delivery is paused.");
    const progressSource = progressSourceFor(item);
    await this.forwardProgress(item, () => this.ports.progress?.running(progressSource));
    const binding = this.binding;
    const session = this.session;
    const catalog = this.catalog;
    if (!binding || !session || !catalog)
      throw new BridgeError("RUNTIME", "Agent runtime session is unavailable.");
    const effective = resolveForBinding(binding, catalog);
    const settings = {
      model: effective.requestModel,
      effort: effective.reasoningEffort,
    };
    const input = formatDiscordTurnInput({
      channelId: item.channelId,
      messageId: item.messageId,
      authorId: item.authorId,
      ...(item.guildId === undefined ? {} : { guildId: item.guildId }),
      ...(item.parentChannelId === undefined ? {} : { parentChannelId: item.parentChannelId }),
      ...(item.attachments === undefined ? {} : { attachments: [...item.attachments] }),
      body: item.text,
    });
    let turnSession = session;
    let turnBinding = binding;
    let barrier = this.openPendingStart(turnSession, turnBinding, item);
    let started: { turnId: string };
    try {
      started = await Promise.race([
        turnSession.startTurn(turnBinding.threadId, input, sourceFor(item), settings),
        barrier.failurePromise,
      ]);
    } catch (error) {
      if (barrier.failure === error) throw error;
      this.failPendingStart(barrier, safeRuntimeError(error, "Codex turn start failed."));
      await this.recover(error);
      const recoveredSession = this.session;
      const recoveredBinding = this.binding;
      if (!recoveredSession || !recoveredBinding) {
        throw new BridgeError("RUNTIME", "Agent runtime recovery did not restore its session.");
      }
      const recoveredCatalog = this.catalog;
      if (!recoveredCatalog) {
        throw new BridgeError("RUNTIME", "Agent runtime recovery did not restore its catalog.");
      }
      const recoveredEffective = resolveForBinding(recoveredBinding, recoveredCatalog);
      turnSession = recoveredSession;
      turnBinding = recoveredBinding;
      barrier = this.openPendingStart(turnSession, turnBinding, item);
      try {
        started = await Promise.race([
          turnSession.startTurn(turnBinding.threadId, input, sourceFor(item), {
            model: recoveredEffective.requestModel,
            effort: recoveredEffective.reasoningEffort,
          }),
          barrier.failurePromise,
        ]);
      } catch (recoveredError) {
        if (barrier.failure === recoveredError) throw recoveredError;
        this.failPendingStart(
          barrier,
          safeRuntimeError(recoveredError, "Recovered Codex turn start failed."),
        );
        throw recoveredError;
      }
    }
    const turnId = started.turnId;
    validateTextId(turnId, "turn ID");
    this.assertPendingStart(barrier);
    this.active = { item, turnId, generation: barrier.generation };
    const state: TurnState = {
      item,
      generation: barrier.generation,
      items: new Map(),
      fileDelivery: this.createFileDelivery(turnSession, turnBinding, item),
      finalDeliveryController: new AbortController(),
      finalFiles: new Set(),
      closedFinalFiles: new Set(),
      totalCharacters: 0,
      completionStarted: false,
      outcome: "completed",
      progressTerminalStarted: false,
      settled: false,
    };
    this.turns.set(turnId, state);
    const completion = new Promise<void>((resolve, reject) => {
      state.resolve = resolve;
      state.reject = reject;
    });
    try {
      await this.forwardProgress(item, () => this.ports.progress?.bindTurn(progressSource, turnId));
      this.drainPendingStart(barrier, turnId);
      await completion;
    } finally {
      this.closePendingStart(barrier);
      this.clearActive(turnId);
    }
  }

  private bindSession(session: AgentRuntimeSession): void {
    this.clearSession();
    const generation = ++this.sessionGeneration;
    for (const method of [
      "turn/started",
      "item/started",
      "item/agentMessage/delta",
      "item/completed",
      "turn/plan/updated",
      "item/reasoning/summaryTextDelta",
      "warning",
      "turn/completed",
    ] as const) {
      this.unsubscribe.push(
        session.onNotification(method, (event) =>
          this.handleSessionEvent(session, generation, event),
        ),
      );
    }
    this.unsubscribe.push(
      session.onSendFileRequest((request) =>
        this.handleSessionSendFileRequest(session, generation, request),
      ),
    );
  }

  private clearSession(): void {
    for (const remove of this.unsubscribe.splice(0)) remove();
  }

  private openPendingStart(
    session: AgentRuntimeSession,
    binding: AgentRuntimeBinding,
    item: TurnItem,
  ): PendingStartBarrier {
    if (this.pendingStart !== undefined) {
      throw new BridgeError("CONFLICT", "A Codex turn start is already pending.");
    }
    let rejectFailure!: (error: BridgeError) => void;
    const failurePromise = new Promise<never>((_resolve, reject) => {
      rejectFailure = reject;
    });
    const warningRequiresAnchor = this.lastTerminalGeneration === this.sessionGeneration;
    const barrier: PendingStartBarrier = {
      generation: this.sessionGeneration,
      session,
      item,
      threadId: binding.threadId,
      entries: [],
      failurePromise,
      rejectFailure,
      timer: undefined,
      characters: 0,
      nextSequence: 0,
      terminalSeen: false,
      toolCalls: 0,
      warningAnchored: !warningRequiresAnchor,
      warningRequiresAnchor,
    };
    barrier.timer = setTimeout(() => {
      this.failPendingStart(
        barrier,
        new BridgeError("TIMEOUT", "Codex turn start event barrier timed out."),
      );
    }, this.pendingStartTimeoutMs);
    barrier.timer.unref?.();
    this.pendingStart = barrier;
    return barrier;
  }

  private assertPendingStart(barrier: PendingStartBarrier): void {
    if (barrier.failure !== undefined) throw barrier.failure;
    if (this.pendingStart !== barrier) {
      throw new BridgeError("RUNTIME", "Codex turn start event barrier was replaced.");
    }
  }

  private failPendingStart(barrier: PendingStartBarrier, error: BridgeError): void {
    if (barrier.failure === undefined) {
      barrier.failure = error;
      barrier.rejectFailure(error);
    }
    this.closePendingStart(barrier);
  }

  private closePendingStart(barrier: PendingStartBarrier): void {
    if (barrier.timer !== undefined) clearTimeout(barrier.timer);
    barrier.timer = undefined;
    if (this.pendingStart === barrier) this.pendingStart = undefined;
    for (const entry of barrier.entries.splice(0)) {
      if (entry.kind === "toolRequest") {
        entry.deferred.resolve(failedFileDeliveryResult());
      }
    }
  }

  private bufferPendingStart(
    barrier: PendingStartBarrier,
    entry: PendingStartEntry,
    characters: number,
  ): boolean {
    if (
      barrier.failure !== undefined ||
      barrier.entries.length >= this.maxPendingStartEntries ||
      barrier.characters + characters > this.maxPendingStartCharacters
    ) {
      this.failPendingStart(
        barrier,
        new BridgeError("RUNTIME", "Codex turn start event barrier exceeded its bounds."),
      );
      return false;
    }
    barrier.entries.push(entry);
    barrier.nextSequence += 1;
    barrier.characters += characters;
    return true;
  }

  private handleSessionEvent(
    session: AgentRuntimeSession,
    generation: number,
    event: AgentRuntimeEvent,
  ): void {
    if (session !== this.session) return;
    const barrier = this.pendingStart;
    if (barrier !== undefined && barrier.session === session && barrier.generation === generation) {
      if (event.method === "warning") {
        if (
          barrier.terminalSeen ||
          (barrier.warningRequiresAnchor && !barrier.warningAnchored) ||
          event.threadId === undefined ||
          event.threadId === null ||
          event.threadId !== barrier.threadId
        ) {
          return;
        }
        this.bufferPendingStart(
          barrier,
          { kind: "warning", sequence: barrier.nextSequence, event },
          pendingStartEventCharacters(event),
        );
        return;
      }
      if (event.threadId !== barrier.threadId) return;
      if (
        this.bufferPendingStart(
          barrier,
          { kind: "notification", sequence: barrier.nextSequence, event },
          pendingStartEventCharacters(event),
        ) &&
        event.method === "turn/completed"
      ) {
        barrier.terminalSeen = true;
      }
      if (event.method === "turn/started") barrier.warningAnchored = true;
      return;
    }
    if (event.method === "warning") {
      const active = this.active;
      if (
        active === undefined ||
        active.generation !== generation ||
        event.threadId === undefined ||
        event.threadId === null ||
        event.threadId !== this.binding?.threadId
      ) {
        return;
      }
      const current = this.turns.get(active.turnId);
      if (current === undefined || current.completionStarted || current.settled) return;
      this.emitProgress(current, event.progress);
      return;
    }
    const current = this.turns.get(event.turnId);
    if (current?.generation !== generation) return;
    this.handleEvent(event);
  }

  private handleSessionSendFileRequest(
    session: AgentRuntimeSession,
    generation: number,
    request: AgentRuntimeSendFileRequest,
  ): Promise<AgentRuntimeSendFileResult> {
    const barrier = this.pendingStart;
    if (barrier === undefined || barrier.session !== session || barrier.generation !== generation) {
      return this.handleSendFileRequest(session, request);
    }
    if (request.threadId !== barrier.threadId || barrier.terminalSeen) {
      return Promise.resolve(failedFileDeliveryResult());
    }
    if (barrier.toolCalls >= this.maxPendingStartToolCalls) {
      this.failPendingStart(
        barrier,
        new BridgeError("RUNTIME", "Codex turn start file tool limit exceeded."),
      );
      return Promise.resolve(failedFileDeliveryResult());
    }
    const deferred = pendingStartDeferred();
    barrier.toolCalls += 1;
    if (
      !this.bufferPendingStart(
        barrier,
        { kind: "toolRequest", sequence: barrier.nextSequence, request, deferred },
        pendingStartRequestCharacters(request),
      )
    ) {
      deferred.resolve(failedFileDeliveryResult());
    }
    return deferred.promise;
  }

  private drainPendingStart(barrier: PendingStartBarrier, turnId: string): void {
    this.assertPendingStart(barrier);
    if (barrier.timer !== undefined) clearTimeout(barrier.timer);
    barrier.timer = undefined;
    this.pendingStart = undefined;
    const entries = barrier.entries.splice(0).sort((left, right) => left.sequence - right.sequence);
    for (const entry of entries) {
      if (entry.kind === "warning") {
        const current = this.turns.get(turnId);
        if (current !== undefined && !current.completionStarted && !current.settled) {
          this.emitProgress(current, entry.event.progress);
        }
        continue;
      }
      if (entry.kind === "notification") {
        if (entry.event.threadId === barrier.threadId && entry.event.turnId === turnId) {
          this.handleEvent(entry.event);
        }
        continue;
      }
      if (entry.request.threadId !== barrier.threadId || entry.request.turnId !== turnId) {
        entry.deferred.resolve(failedFileDeliveryResult());
        continue;
      }
      void this.handleSendFileRequest(barrier.session, entry.request).then(
        entry.deferred.resolve,
        () => entry.deferred.resolve(failedFileDeliveryResult()),
      );
    }
  }

  private handleEvent(event: AgentRuntimeEvent): void {
    if (event.method === "warning") return;
    const current = this.turns.get(event.turnId);
    if (!current || this.binding?.threadId !== event.threadId) return;
    if ("progress" in event && event.progress !== undefined) {
      this.emitProgress(current, event.progress);
    }
    if (event.method === "item/started" && event.kind === "agentMessage") {
      if (!current.items.has(event.itemId))
        current.items.set(event.itemId, {
          itemId: event.itemId,
          text: "",
          files: [],
          completed: false,
          ...(event.phase === undefined ? {} : { phase: event.phase }),
        });
    } else if (event.method === "item/agentMessage/delta") {
      const item = current.items.get(event.itemId);
      if (!item || item.completed) return;
      if (item.phase === "commentary") {
        const text = progressText(event.delta);
        if (text !== undefined) {
          this.emitProgress(current, createTurnProgressEvent({ type: "commentary", text }));
        }
        return;
      }
      const next = boundedAppend(
        item.text,
        event.delta,
        this.maxBufferCharacters - current.totalCharacters + item.text.length,
      );
      current.totalCharacters += next.length - item.text.length;
      item.text = next;
    } else if (event.method === "item/completed" && event.kind === "agentMessage") {
      const item = current.items.get(event.itemId);
      if (!item || item.completed) return;
      const previousPhase = item.phase;
      if (event.phase !== undefined) item.phase = event.phase;
      if (item.phase === "commentary") {
        current.totalCharacters -= item.text.length;
        item.text = "";
        if (previousPhase !== "commentary") {
          const text = progressText(event.text);
          if (text !== undefined) {
            this.emitProgress(current, createTurnProgressEvent({ type: "commentary", text }));
          }
        }
        item.completed = true;
        return;
      }
      if (event.text !== undefined) {
        current.totalCharacters -= item.text.length;
        item.text = boundedAppend(
          "",
          event.text,
          this.maxBufferCharacters - current.totalCharacters,
        );
        current.totalCharacters += item.text.length;
      }
      item.completed = true;
      if (event.files) item.files.push(...event.files);
    } else if (event.method === "turn/completed") {
      if (current.completionStarted) return;
      current.completionStarted = true;
      this.lastTerminalGeneration = current.generation;
      current.fileDelivery.closeToNewRequests();
      void this.complete(current);
    }
  }

  private emitProgress(current: TurnState, event: TurnProgressEvent): void {
    const source = progressSourceFor(current.item);
    void this.forwardProgress(current.item, () => this.ports.progress?.event(source, event));
  }

  private async forwardProgress(
    item: Pick<TurnItem, "channelId" | "messageId">,
    operation: () => Promise<void> | undefined,
  ): Promise<void> {
    try {
      await operation();
    } catch {
      await this.ports.output
        .report?.(item.channelId, item.messageId, "Codex progress delivery failed.")
        .catch(() => undefined);
    }
  }

  private async deliver(current: TurnState): Promise<void> {
    const text = [...current.items.values()].map((item) => item.text).join("");
    const retained = [...current.items.values()].flatMap((item) => item.files);
    const files = [...retained];
    retained.forEach((file) => {
      current.finalFiles.add(file);
    });
    try {
      if (!(await current.fileDelivery.waitForSettled(this.stopTimeoutMs))) {
        const aborted = await current.fileDelivery.abortAndWait(this.stopTimeoutMs);
        if (!aborted) current.fileDelivery.forceRelease();
        throw new BridgeError("TIMEOUT", "Discord file tool delivery did not settle in time.");
      }
      const parsed = this.session?.parseFileMarkers
        ? await this.session.parseFileMarkers(this.binding?.threadId ?? "", text, current.item)
        : { visibleText: text, files: [] };
      files.push(...parsed.files);
      parsed.files.forEach((file) => {
        current.finalFiles.add(file);
      });
      if (current.finalDeliveryController.signal.aborted) {
        return;
      }
      const visibleText =
        this.ports.progress?.decorateFinalText?.(
          progressSourceFor(current.item),
          parsed.visibleText,
        ) ?? parsed.visibleText;
      const successfulPaths = new Set(current.fileDelivery.successfulPaths());
      const markerFiles = uniqueCanonicalFiles(files).filter(
        (file) => !successfulPaths.has(file.canonicalPath),
      );
      if (successfulPaths.size + markerFiles.length > MAX_DISCORD_ATTACHMENTS) {
        throw new BridgeError(
          "INVALID_ARGUMENT",
          "Discord file delivery exceeds the per-turn attachment limit.",
        );
      }
      if (!this.deliveryPaused) {
        const dispatch = this.finalDeliveryDispatch(current.item);
        if (visibleText.length > 0) {
          if (dispatch === undefined) {
            await this.ports.output.sendText(
              current.item.channelId,
              current.item.messageId,
              visibleText,
            );
          } else {
            await this.ports.output.sendText(
              current.item.channelId,
              current.item.messageId,
              visibleText,
              dispatch,
            );
          }
        }
        for (const file of markerFiles) {
          if (!this.ports.output.sendFile)
            throw new BridgeError("RUNTIME", "Discord file delivery is unavailable.");
          if (dispatch === undefined) {
            await this.ports.output.sendFile(
              current.item.channelId,
              current.item.messageId,
              file,
              undefined,
              current.finalDeliveryController.signal,
            );
          } else {
            await this.ports.output.sendFile(
              current.item.channelId,
              current.item.messageId,
              file,
              undefined,
              current.finalDeliveryController.signal,
              dispatch,
            );
          }
        }
      }
    } catch (error) {
      if (!current.finalDeliveryController.signal.aborted) throw error;
    } finally {
      await this.closeFinalFiles(current);
    }
  }

  private async complete(current: TurnState): Promise<void> {
    try {
      await this.deliver(current);
      await this.closeProgress(current);
      this.settle(current);
    } catch (error) {
      if (current.outcome !== "interrupted") current.outcome = "failed";
      await this.closeProgress(
        current,
        current.outcome === "failed" ? "Discord final delivery failed." : undefined,
      );
      this.settle(current, error);
    }
  }

  private async closeProgress(current: TurnState, message?: string): Promise<void> {
    if (current.progressTerminalStarted) return;
    current.progressTerminalStarted = true;
    this.terminalItems.add(current.item);
    await this.forwardProgress(current.item, () =>
      this.ports.progress?.terminal(progressSourceFor(current.item), {
        ...(message === undefined ? {} : { message }),
        status: current.outcome,
        type: "terminal",
      }),
    );
  }

  private async closeFinalFiles(current: TurnState): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const file of current.finalFiles) {
      if (current.closedFinalFiles.has(file)) continue;
      current.closedFinalFiles.add(file);
      pending.push(file.close().catch(() => undefined));
    }
    await Promise.allSettled(pending);
  }

  private createFileDelivery(
    session: AgentRuntimeSession,
    binding: AgentRuntimeBinding,
    item: TurnItem,
  ): TurnFileDeliveryCoordinator {
    return new TurnFileDeliveryCoordinator({
      authorize: (input) => session.authorizeSendFile(binding.threadId, input),
      upload: (file, message, signal) => {
        const sendFile = this.ports.output.sendFile;
        if (!sendFile) throw new BridgeError("RUNTIME", "Discord file delivery is unavailable.");
        const dispatch = this.finalDeliveryDispatch(item);
        return dispatch === undefined
          ? sendFile(item.channelId, item.messageId, file, message, signal)
          : sendFile(item.channelId, item.messageId, file, message, signal, dispatch);
      },
      waitFor: (operation, timeoutMs) => boundedWait(operation, timeoutMs, this.clock),
    });
  }

  private finalDeliveryDispatch(item: TurnItem): AgentRuntimeDeliveryDispatch | undefined {
    const progress = this.ports.progress;
    const deliver = progress?.deliver;
    if (deliver === undefined) return undefined;
    const source = progressSourceFor(item);
    return (operation) => deliver.call(progress, source, operation);
  }

  private handleSendFileRequest(
    session: AgentRuntimeSession,
    request: AgentRuntimeSendFileRequest,
  ): Promise<AgentRuntimeSendFileResult> {
    const current = this.turns.get(request.turnId);
    if (
      session !== this.session ||
      current === undefined ||
      this.active?.turnId !== request.turnId ||
      this.binding?.threadId !== request.threadId ||
      current.completionStarted ||
      current.settled
    ) {
      return Promise.resolve(failedFileDeliveryResult());
    }
    return current.fileDelivery.handle({ callId: request.callId, arguments: request.arguments });
  }

  private async recover(cause: unknown): Promise<void> {
    this.state = "recovering";
    for (let attempt = 0; attempt < this.maxRecoveryAttempts; attempt += 1) {
      try {
        await this.ports.appServer.stop();
        const expected = this.binding;
        const binding = await this.ports.registry.readBinding();
        if (!expected || !sameBinding(expected, binding)) {
          throw new AgentRuntimeSessionError("Registry binding changed during recovery.");
        }
        const session = await this.ports.appServer.start();
        const catalog = await loadCatalog(session);
        await session.resume(binding.threadId, binding.workspace, binding.inbox);
        this.binding = binding;
        this.catalog = catalog;
        this.bindSession(session);
        this.session = session;
        this.state = "running";
        return;
      } catch (error) {
        if (error instanceof AgentRuntimeSessionError) {
          this.state = "failed";
          await this.ports.registry.markState("failed").catch(() => undefined);
          throw error;
        }
        if (attempt + 1 < this.maxRecoveryAttempts)
          await this.clock.sleep(this.recoveryBaseDelayMs * 2 ** attempt);
      }
    }
    this.state = "failed";
    throw safeRuntimeError(cause, "Agent runtime recovery failed.");
  }

  private async reportDiscarded(
    notices: readonly { channelId: string; guildId?: string; messageId: string }[],
  ): Promise<void> {
    for (const notice of notices) {
      await this.forwardProgress(notice, () =>
        this.ports.progress?.terminal(
          createTurnProgressSource({
            channelId: notice.channelId,
            ...(notice.guildId === undefined ? {} : { guildId: notice.guildId }),
            messageId: notice.messageId,
          }),
          { status: "interrupted", type: "terminal" },
        ),
      );
      await this.ports.output.report?.(
        notice.channelId,
        notice.messageId,
        "Turn discarded by runtime lifecycle.",
      );
    }
  }

  private async reportOrphan(threadId: string): Promise<void> {
    const report = this.ports.output.reportOrphanThread;
    if (!report) return;
    await report(threadId).catch(() => undefined);
  }

  private async failActive(error: BridgeError): Promise<void> {
    const active = this.active;
    if (!active) return;
    const state = this.turns.get(active.turnId);
    if (state) {
      if (state.outcome === "completed") state.outcome = "failed";
      await this.closeProgress(
        state,
        state.outcome === "failed" ? "Codex turn stopped before final delivery." : undefined,
      );
      this.settle(state, error);
    }
  }

  private settle(state: TurnState, error?: unknown): void {
    if (state.settled) return;
    state.settled = true;
    if (error === undefined) state.resolve?.();
    else state.reject?.(error);
  }

  private clearActive(turnId: string): void {
    if (this.active?.turnId === turnId) this.active = undefined;
    this.turns.delete(turnId);
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.lifecycle.then(operation, operation);
    this.lifecycle = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private control<T>(operation: () => Promise<T>): Promise<T> {
    this.pendingControls += 1;
    return this.serial(operation).finally(() => {
      this.pendingControls -= 1;
    });
  }

  private controlContext(): {
    readonly binding: AgentRuntimeBinding;
    readonly catalog: readonly CodexModelCatalogEntry[];
  } {
    if (this.state !== "running" || !this.binding || !this.catalog) {
      throw new BridgeError("CONFLICT", "Agent runtime model controls are unavailable.");
    }
    if (this.queue.depth() !== 0) {
      throw new BridgeError("CONFLICT", "Agent runtime has an active or queued turn.");
    }
    return { binding: this.binding, catalog: this.catalog };
  }

  private persistModelSettings(
    bindingId: string,
    settings: AgentModelSettings,
  ): Promise<AgentRuntimeBinding> {
    const update = this.ports.registry.updateModelSettings;
    if (!update) {
      throw new BridgeError(
        "CONFIGURATION",
        "Agent runtime model settings persistence is unavailable.",
      );
    }
    return update.call(this.ports.registry, bindingId, settings);
  }
}

function boundedAppend(current: string, next: string, limit: number): string {
  if (current.length >= limit) return current;
  return current + next.slice(0, limit - current.length);
}

function sourceFor(item: TurnItem): DiscordTurnSource {
  return {
    messageId: item.messageId,
    channelId: item.channelId,
    authorId: item.authorId,
    ...(item.guildId === undefined ? {} : { guildId: item.guildId }),
    ...(item.parentChannelId === undefined ? {} : { parentChannelId: item.parentChannelId }),
    ...(item.interactionId === undefined ? {} : { interactionId: item.interactionId }),
  };
}

function progressSourceFor(item: TurnItem): TurnProgressSource {
  return createTurnProgressSource({
    channelId: item.channelId,
    messageId: item.messageId,
    ...(item.guildId === undefined ? {} : { guildId: item.guildId }),
  });
}

function progressText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
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

function pendingStartDeferred(): PendingStartDeferred {
  let resolve!: (result: AgentRuntimeSendFileResult) => void;
  const promise = new Promise<AgentRuntimeSendFileResult>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function pendingStartEventCharacters(event: AgentRuntimeEvent): number {
  return boundedSerializedCharacters(event);
}

function pendingStartRequestCharacters(request: AgentRuntimeSendFileRequest): number {
  return boundedSerializedCharacters({
    threadId: request.threadId,
    turnId: request.turnId,
    callId: request.callId,
    arguments: request.arguments,
  });
}

function boundedSerializedCharacters(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

async function boundedWait(
  promise: Promise<unknown>,
  timeout: number,
  clock: AgentRuntimeClock,
): Promise<boolean> {
  let settled = false;
  promise
    .finally(() => {
      settled = true;
    })
    .catch(() => undefined);
  const started = numericClock(clock.now());
  const iterations = Math.max(1, Math.ceil(timeout / 10) + 1);
  for (let attempt = 0; !settled && attempt < iterations; attempt += 1) {
    if (numericClock(clock.now()) - started >= timeout) break;
    await clock.sleep(Math.min(10, timeout));
  }
  return settled;
}

function safeRuntimeError(error: unknown, message: string): BridgeError {
  const code = error instanceof BridgeError ? error.code : "RUNTIME";
  return new BridgeError(code, message, "Restart the Codex App Server process and retry.");
}

function numericClock(value: number): number {
  if (!Number.isFinite(value))
    throw new BridgeError("INVALID_ARGUMENT", "Clock now() must return a finite number.");
  return value;
}

function uniqueFiles(files: readonly AuthorizedOutboundFile[]): AuthorizedOutboundFile[] {
  return [...new Set(files)];
}

function uniqueCanonicalFiles(files: readonly AuthorizedOutboundFile[]): AuthorizedOutboundFile[] {
  const seen = new Set<string>();
  return uniqueFiles(files).filter((file) => {
    if (seen.has(file.canonicalPath)) return false;
    seen.add(file.canonicalPath);
    return true;
  });
}

function failedFileDeliveryResult(): AgentRuntimeSendFileResult {
  return {
    success: false,
    contentItems: [{ type: "inputText", text: "File could not be sent." }],
  };
}

function sameBinding(left: AgentRuntimeBinding, right: AgentRuntimeBinding): boolean {
  return (
    left.id === right.id &&
    left.threadId === right.threadId &&
    left.workspace.name === right.workspace.name &&
    left.workspace.cwd === right.workspace.cwd &&
    left.workspace.model === right.workspace.model &&
    left.inbox === right.inbox &&
    left.modelId === right.modelId &&
    left.reasoningEffort === right.reasoningEffort
  );
}

function snapshotCatalog(
  catalog: readonly CodexModelCatalogEntry[],
): readonly CodexModelCatalogEntry[] {
  return Object.freeze(
    catalog.map((model) =>
      Object.freeze({
        ...model,
        supportedReasoningEfforts: Object.freeze([...model.supportedReasoningEfforts]),
      }),
    ),
  );
}

async function loadCatalog(
  session: AgentRuntimeSession,
): Promise<readonly CodexModelCatalogEntry[]> {
  const listModels = session.listModels;
  if (!listModels) {
    throw new BridgeError("CONFIGURATION", "Codex model catalog loading is unavailable.");
  }
  return snapshotCatalog(await listModels.call(session));
}

function bindingSettings(binding: AgentRuntimeBinding): AgentModelSettings {
  return {
    ...(binding.modelId === undefined ? {} : { modelId: binding.modelId }),
    ...(binding.reasoningEffort === undefined ? {} : { reasoningEffort: binding.reasoningEffort }),
  };
}

function configuredStatus(
  binding: AgentRuntimeBinding,
): Pick<ModelSettingsStatus, "configuredModelId" | "configuredReasoningEffort"> {
  return {
    ...(binding.modelId === undefined ? {} : { configuredModelId: binding.modelId }),
    ...(binding.reasoningEffort === undefined
      ? {}
      : { configuredReasoningEffort: binding.reasoningEffort }),
  };
}

function resolveForBinding(
  binding: AgentRuntimeBinding,
  catalog: readonly CodexModelCatalogEntry[],
) {
  return resolveModelSettings({
    binding: bindingSettings(binding),
    ...(binding.workspace.model === undefined ? {} : { workspaceModel: binding.workspace.model }),
    catalog,
  });
}

function resolveCandidate(
  binding: AgentRuntimeBinding,
  settings: AgentModelSettings,
  catalog: readonly CodexModelCatalogEntry[],
) {
  return resolveModelSettings({
    binding: settings,
    ...(binding.workspace.model === undefined ? {} : { workspaceModel: binding.workspace.model }),
    catalog,
  });
}

function effectiveEntry(
  effective: ReturnType<typeof resolveModelSettings>,
  catalog: readonly CodexModelCatalogEntry[],
): CodexModelCatalogEntry {
  const selected = catalog.find((model) => model.id === effective.modelId);
  if (!selected) {
    throw new BridgeError("CONFIGURATION", "Resolved Codex model is unavailable.");
  }
  return selected;
}

function validateTextId(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 512) {
    throw new BridgeError("INVALID_ARGUMENT", `${label} must be a bounded non-empty string.`);
  }
}

function validateOptions(options: AgentRuntimeOptions): void {
  const values: Array<[string, number | undefined, number]> = [
    ["maxQueueDepth", options.maxQueueDepth, 1],
    ["maxBufferCharacters", options.maxBufferCharacters, 1],
    ["maxPendingStartCharacters", options.maxPendingStartCharacters, 1],
    ["maxPendingStartEntries", options.maxPendingStartEntries, 1],
    ["maxPendingStartToolCalls", options.maxPendingStartToolCalls, 1],
    ["pendingStartTimeoutMs", options.pendingStartTimeoutMs, 1],
    ["maxRecoveryAttempts", options.maxRecoveryAttempts, 1],
    ["recoveryBaseDelayMs", options.recoveryBaseDelayMs, 0],
    ["stopTimeoutMs", options.stopTimeoutMs, 1],
  ];
  for (const [name, value, minimum] of values) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum)) {
      throw new BridgeError("INVALID_ARGUMENT", `Invalid AgentRuntime option ${name}.`);
    }
  }
  if (
    options.clock !== undefined &&
    (typeof options.clock.now !== "function" || typeof options.clock.sleep !== "function")
  ) {
    throw new BridgeError("INVALID_ARGUMENT", "Invalid AgentRuntime clock.");
  }
}
