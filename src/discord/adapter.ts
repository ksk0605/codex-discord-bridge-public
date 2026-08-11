import { randomUUID } from "node:crypto";
import { addAbortSignal } from "node:stream";
import type { ThreadAutoArchiveDuration } from "discord.js";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  PermissionFlagsBits,
} from "discord.js";
import type { RequestId } from "../app-server/protocol.js";
import { BridgeError } from "../domain/errors.js";
import {
  type AccessPolicy,
  ModelIdSchema,
  ReasoningEffortSchema,
  type RegistryDocument,
} from "../domain/schemas.js";
import type { AuthorizedOutboundFile } from "../manager/workspaces.js";
import type {
  AgentRuntimeDeliveryDispatch,
  AgentRuntimeOutput,
  ModelSelection,
  ReasoningSelection,
} from "../runtime/agent-runtime.js";
import type {
  ApprovalInteraction,
  ApprovalNotice,
  ApprovalRouter,
} from "../runtime/approval-router.js";
import type { ModelSettingsStatus, ModelSummary } from "../runtime/model-settings.js";
import {
  createDiscordDeliveryReceipt,
  type DiscordDeliveryReceipt,
  type TurnProgressSource,
  type TurnProgressTerminal,
} from "../runtime/turn-progress.js";
import type { TurnInput } from "../runtime/turn-queue.js";
import { accessPolicyRevision } from "../storage/registry.js";
import { type DiscordAccessEvent, evaluateDiscordAccess } from "./access.js";
import type { DiscordAttachmentStorePort, DiscordMessageAttachment } from "./attachments.js";
import { redactDiscordSecrets } from "./format.js";
import { chunkDiscordMarkdown } from "./markdown-tables.js";

export type DiscordLocation = "dm" | "guild" | "thread";
export type CodexCommandName =
  | "status"
  | "models"
  | "model"
  | "reasoning"
  | "new"
  | "interrupt"
  | "spawn"
  | "stop"
  | "restart";

interface DiscordLocatedEvent {
  readonly channelId: string;
  readonly location: DiscordLocation;
  readonly guildId?: string;
  readonly parentChannelId?: string | undefined;
}

export interface DiscordMessageEvent extends DiscordLocatedEvent {
  readonly id: string;
  readonly authorId: string;
  readonly authorIsBot: boolean;
  readonly authorIsSystem: boolean;
  readonly content: string;
  readonly mentionsBot: boolean;
  readonly attachments: readonly DiscordMessageAttachment[];
  readonly threadOwnerId?: string;
}

export interface DiscordCommandEvent extends DiscordLocatedEvent {
  readonly id: string;
  readonly userId: string;
  readonly subcommand: string;
  readonly confirm?: boolean;
  readonly bot?: string;
  readonly workspace?: string;
  readonly name?: string;
  readonly effort?: string;
  acknowledge(): Promise<void>;
  respond(content: string): Promise<void>;
}

export interface DiscordButtonEvent extends DiscordLocatedEvent {
  readonly customId: string;
  readonly messageId: string;
  readonly userId: string;
  respond(content: string): Promise<void>;
}

export interface DiscordButtonPayload {
  readonly customId: string;
  readonly label: string;
  readonly style: "success" | "danger";
}

export interface DiscordMessagePayload {
  readonly content: string;
  readonly replyToMessageId?: string;
  readonly buttons?: readonly DiscordButtonPayload[];
}

export interface DiscordFilePayload {
  readonly file: AuthorizedOutboundFile;
  readonly content?: string;
  readonly replyToMessageId?: string;
  readonly signal: AbortSignal;
}

export interface DiscordProgressThreadOptions {
  readonly autoArchiveDuration?: ThreadAutoArchiveDuration;
}

export interface DiscordProgressThread {
  readonly id: string;
  readonly parentId: string;
  readonly ownerId: string;
}

export interface DiscordProgressCapabilities {
  readonly createPublicThreads: boolean;
  readonly sendMessagesInThreads: boolean;
  readonly manageThreads: boolean;
}

export interface DiscordProgressThreadState {
  readonly archived: boolean;
  readonly locked: boolean;
}

export type DiscordThreadInspection =
  | {
      readonly status: "found";
      readonly id: string;
      readonly parentId: string;
      readonly ownerId: string;
      readonly archived: boolean;
      readonly locked: boolean;
    }
  | {
      readonly status: "not-found";
      readonly threadId: string;
    };

type AsyncEventHandler<Event> = (event: Event) => Promise<void>;

export interface DiscordGatewayTransport {
  onMessage(handler: AsyncEventHandler<DiscordMessageEvent>): () => void;
  onCommand(handler: AsyncEventHandler<DiscordCommandEvent>): () => void;
  onButton(handler: AsyncEventHandler<DiscordButtonEvent>): () => void;
  login(token: string): Promise<void>;
  destroy(): Promise<void>;
  sendTyping(channelId: string): Promise<void>;
  sendMessage(channelId: string, payload: DiscordMessagePayload): Promise<{ id: string }>;
  sendFile(channelId: string, payload: DiscordFilePayload): Promise<{ id: string }>;
  sendDirectMessage(userId: string, payload: DiscordMessagePayload): Promise<{ id: string }>;
  createProgressThread(
    channelId: string,
    sourceMessageId: string,
    options?: DiscordProgressThreadOptions,
  ): Promise<DiscordProgressThread>;
  editMessage(
    channelId: string,
    messageId: string,
    payload: Pick<DiscordMessagePayload, "content">,
  ): Promise<{ id: string }>;
  setProgressThreadState(threadId: string, state: DiscordProgressThreadState): Promise<void>;
  inspectThread(threadId: string): Promise<DiscordThreadInspection>;
  inspectProgressCapabilities(channelId: string): Promise<DiscordProgressCapabilities>;
}

export interface DiscordAdapterRegistry {
  read(): Promise<RegistryDocument>;
  updateAccess(
    botName: string,
    expectedRevision: string,
    nextPolicy: AccessPolicy,
  ): Promise<AccessPolicy>;
  confirmOwner(botName: string, ownerUserId: string): Promise<unknown>;
}

export interface DiscordAgentRuntime {
  readonly state: string;
  readonly queue: { depth(): number };
  enqueue(input: TurnInput): Promise<void>;
  interrupt(): Promise<void>;
  newSession(confirm: boolean, creationKey: string): Promise<{ threadId: string }>;
  modelStatus(): ModelSettingsStatus;
  listModels(): readonly ModelSummary[];
  setModel(selection: ModelSelection): Promise<ModelSettingsStatus>;
  setReasoningEffort(selection: ReasoningSelection): Promise<ModelSettingsStatus>;
}

export interface DiscordAgentManager {
  status(): Promise<unknown>;
  spawn(botName: string, workspaceName: string): Promise<unknown>;
  stop(): Promise<unknown>;
  restart(): Promise<unknown>;
}

export interface DiscordAdapterTimers {
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface DiscordObservationSource extends TurnProgressSource {
  readonly location: DiscordLocation;
  readonly parentChannelId?: string;
  readonly threadOwnerId?: string;
}

export interface DiscordObservationIngress {
  begin(source: DiscordObservationSource): Promise<{
    readonly durable: boolean;
    readonly kind: "thread" | "inPlace" | "none";
    readonly reused: boolean;
  }>;
  initializeAfterLogin?(): Promise<void>;
  isProgressOnlyThread(event: DiscordObservationSource): Promise<boolean>;
  preparing(source: TurnProgressSource): Promise<void>;
  queued(source: TurnProgressSource): Promise<void>;
  redirectProgressThreadInput(event: DiscordObservationSource): Promise<void>;
  terminal(source: TurnProgressSource, terminal: TurnProgressTerminal): Promise<void>;
}

export interface DiscordGatewayAdapterOptions {
  readonly botName: string;
  readonly transport: DiscordGatewayTransport;
  readonly registry: DiscordAdapterRegistry;
  readonly runtime: DiscordAgentRuntime;
  readonly manager: DiscordAgentManager;
  readonly approval: Pick<ApprovalRouter, "handleInteraction">;
  readonly observation?: DiscordObservationIngress;
  readonly attachmentStore?: DiscordAttachmentStorePort;
  readonly createPairingCode?: () => string;
  readonly now?: () => number;
  readonly timers?: DiscordAdapterTimers;
  readonly typingIntervalMs?: number;
  readonly onError?: (error: unknown) => void;
}

interface PendingApprovalButton {
  readonly requestId: RequestId;
  readonly messageId: string;
}

const DEFAULT_TYPING_INTERVAL_MS = 8_000;
const MAX_TYPING_INTERVAL_MS = 60_000;
const MAX_COMMAND_RESPONSE = 1_900;
const MAX_PENDING_APPROVAL_BUTTONS = 128;
const APPROVAL_BUTTON_PREFIX = "codex-approval:";

class IngressCommit {
  private settled = false;

  constructor(
    private readonly previous: Promise<void>,
    private readonly release: () => void,
  ) {}

  async handoff<TResult>(
    operation: () => TResult,
    prepare: () => Promise<void>,
  ): Promise<Awaited<TResult>> {
    await this.previous;
    if (this.settled) {
      throw new BridgeError("CONFLICT", "Discord message ingress is already settled.");
    }
    await prepare();
    let result: TResult;
    try {
      result = operation();
    } finally {
      this.settle();
    }
    return await result;
  }

  async skip(): Promise<void> {
    if (this.settled) return;
    await this.previous;
    this.settle();
  }

  private settle(): void {
    if (this.settled) return;
    this.settled = true;
    this.release();
  }
}

const defaultTimers: DiscordAdapterTimers = {
  setInterval: (callback, milliseconds) => {
    const timer = setInterval(callback, milliseconds);
    timer.unref();
    return timer;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

const defaultObservationIngress: DiscordObservationIngress = Object.freeze({
  begin: async () => ({ durable: false, kind: "none" as const, reused: false }),
  isProgressOnlyThread: async () => false,
  preparing: async () => undefined,
  queued: async () => undefined,
  redirectProgressThreadInput: async () => undefined,
  terminal: async () => undefined,
});

function requiredRecordValue<T>(record: Record<string, T>, key: string, label: string): T {
  const value = Object.hasOwn(record, key) ? record[key] : undefined;
  if (value === undefined) {
    throw new BridgeError("CONFIGURATION", `${label} is missing for ${key}.`);
  }
  return value;
}

function accessEvent(
  kind: DiscordAccessEvent["kind"],
  event: DiscordLocatedEvent,
  senderId: string,
  content: string,
  automated: { bot?: boolean; system?: boolean } = {},
): DiscordAccessEvent {
  return {
    kind,
    location: event.location,
    senderId,
    channelId: event.channelId,
    ...(event.guildId === undefined ? {} : { guildId: event.guildId }),
    ...(event.parentChannelId === undefined ? {} : { parentChannelId: event.parentChannelId }),
    content,
    mentionsBot: kind === "message" && "mentionsBot" in event ? event.mentionsBot === true : false,
    ...(automated.bot === undefined ? {} : { senderIsBot: automated.bot }),
    ...(automated.system === undefined ? {} : { senderIsSystem: automated.system }),
  };
}

function observationSource(event: DiscordMessageEvent): DiscordObservationSource {
  return Object.freeze({
    channelId: event.channelId,
    ...(event.guildId === undefined ? {} : { guildId: event.guildId }),
    location: event.location,
    messageId: event.id,
    ...(event.parentChannelId === undefined ? {} : { parentChannelId: event.parentChannelId }),
    ...(event.threadOwnerId === undefined ? {} : { threadOwnerId: event.threadOwnerId }),
  });
}

function commandResult(value: unknown): string {
  let display: string;
  if (typeof value === "string") {
    display = value;
  } else {
    try {
      display = JSON.stringify(value);
    } catch {
      display = "Command completed.";
    }
  }
  return redactDiscordSecrets(display, { maxOutputLength: MAX_COMMAND_RESPONSE });
}

function invalidSetting(message: string): BridgeError {
  return new BridgeError("INVALID_ARGUMENT", message, "Correct the command option and retry.");
}

function modelSelection(value: string | undefined): ModelSelection {
  if (value === "default") return { kind: "default" };
  const parsed = ModelIdSchema.safeParse(value);
  if (!parsed.success) throw invalidSetting("Invalid Codex model ID.");
  return { kind: "model", id: parsed.data };
}

function reasoningSelection(value: string | undefined): ReasoningSelection {
  if (value === "default") return { kind: "default" };
  const parsed = ReasoningEffortSchema.safeParse(value);
  if (!parsed.success) throw invalidSetting("Invalid Codex reasoning effort.");
  return { kind: "effort", value: parsed.data };
}

function modelSourceLabel(
  source: NonNullable<ModelSettingsStatus["effective"]>["modelSource"],
): string {
  return source === "binding" ? "explicit" : `inherited: ${source}`;
}

function reasoningSourceLabel(
  source: NonNullable<ModelSettingsStatus["effective"]>["reasoningSource"],
): string {
  return source === "binding" ? "explicit" : "inherited: model default";
}

function formatModelStatus(status: ModelSettingsStatus): readonly string[] {
  const effective = status.effective;
  if (effective !== undefined) {
    return [
      `Model: ${effective.displayName} (${effective.modelId})${effective.hidden ? " (hidden)" : ""} [${modelSourceLabel(effective.modelSource)}]`,
      `Reasoning: ${effective.reasoningEffort} [${reasoningSourceLabel(effective.reasoningSource)}]`,
    ];
  }

  return [
    "Model: unavailable",
    ...(status.configuredModelId === undefined
      ? []
      : [`Configured model: ${status.configuredModelId}`]),
    ...(status.configuredReasoningEffort === undefined
      ? []
      : [`Configured reasoning: ${status.configuredReasoningEffort}`]),
    ...(status.configurationError === undefined
      ? []
      : [`Configuration error: ${status.configurationError}`]),
  ];
}

function formatManagerStatus(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "unavailable";
  }
}

function formatStatus(
  managerStatus: unknown,
  modelStatus: ModelSettingsStatus,
  runtimeState: string,
  queueDepth: number,
): string {
  return [
    "Codex status",
    ...formatModelStatus(modelStatus),
    `Runtime: ${runtimeState}`,
    `Queue depth: ${queueDepth}`,
    `Session: ${formatManagerStatus(managerStatus)}`,
  ].join("\n");
}

function formatModelSummary(model: ModelSummary): string {
  const markers = [
    ...(model.isCurrent ? ["current"] : []),
    ...(model.isDefault ? ["default"] : []),
  ];
  return [
    `- ${model.displayName} (${model.id})${markers.length === 0 ? "" : ` [${markers.join(", ")}]`}`,
    `  Default effort: ${model.defaultReasoningEffort}`,
    `  Supported efforts: ${model.supportedReasoningEfforts.join(", ")}`,
  ].join("\n");
}

function formatModelList(models: readonly ModelSummary[]): string {
  const header = "Available Codex models";
  if (models.length === 0) return `${header}\nNo visible models available.`;

  const included: string[] = [];
  let length = header.length;
  for (let index = 0; index < models.length; index += 1) {
    const model = models[index];
    if (model === undefined) break;
    const block = formatModelSummary(model);
    const omitted = models.length - index - 1;
    const suffix = omitted === 0 ? "" : `... ${omitted} models omitted`;
    const candidateLength =
      length + 1 + block.length + (suffix.length === 0 ? 0 : 1 + suffix.length);
    if (candidateLength > MAX_COMMAND_RESPONSE) break;
    included.push(block);
    length += 1 + block.length;
  }

  const omitted = models.length - included.length;
  return [header, ...included, ...(omitted === 0 ? [] : [`... ${omitted} models omitted`])].join(
    "\n",
  );
}

function approvalText(notice: ApprovalNotice): string {
  const details = [
    `Codex approval requested: ${notice.method}`,
    `Thread: ${notice.threadId}`,
    `Turn: ${notice.turnId}`,
    `Item: ${notice.itemId}`,
    ...(notice.command === undefined ? [] : [`Command: ${notice.command}`]),
    ...(notice.cwd === undefined ? [] : [`Working directory: ${notice.cwd}`]),
  ].join("\n");
  return redactDiscordSecrets(details, { maxOutputLength: MAX_COMMAND_RESPONSE });
}

export class DiscordGatewayAdapter implements AgentRuntimeOutput {
  private readonly options: DiscordGatewayAdapterOptions;
  private readonly observation: DiscordObservationIngress;
  private readonly now: () => number;
  private readonly timers: DiscordAdapterTimers;
  private readonly typingIntervalMs: number;
  private readonly pendingApprovals = new Map<string, PendingApprovalButton>();
  private readonly activeMessageHandlers = new Set<Promise<void>>();
  private unsubscribe: Array<() => void> = [];
  private commitTail = Promise.resolve();
  private attachmentStop: Promise<void> | undefined;
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private started = false;
  private quiescing = false;

  constructor(options: DiscordGatewayAdapterOptions) {
    if (
      !Number.isSafeInteger(options.typingIntervalMs ?? DEFAULT_TYPING_INTERVAL_MS) ||
      (options.typingIntervalMs ?? DEFAULT_TYPING_INTERVAL_MS) <= 0 ||
      (options.typingIntervalMs ?? DEFAULT_TYPING_INTERVAL_MS) > MAX_TYPING_INTERVAL_MS
    ) {
      throw new BridgeError("INVALID_ARGUMENT", "Invalid Discord typing interval.");
    }
    this.options = options;
    this.observation = options.observation ?? defaultObservationIngress;
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? defaultTimers;
    this.typingIntervalMs = options.typingIntervalMs ?? DEFAULT_TYPING_INTERVAL_MS;
  }

  start(token: string): Promise<void> {
    if (this.started) return Promise.resolve();
    if (this.quiescing) {
      return Promise.reject(new BridgeError("CONFLICT", "Discord adapter is stopping."));
    }
    if (this.startPromise !== undefined) return this.startPromise;
    const starting = this.startTransport(token);
    this.startPromise = starting;
    void starting
      .finally(() => {
        if (this.startPromise === starting) this.startPromise = undefined;
      })
      .catch(() => undefined);
    return starting;
  }

  private async startTransport(token: string): Promise<void> {
    try {
      await this.options.attachmentStore?.initialize();
      if (this.quiescing) {
        throw new BridgeError("CONFLICT", "Discord adapter is stopping.");
      }
      await this.options.transport.login(token);
      if (this.quiescing) {
        throw new BridgeError("CONFLICT", "Discord adapter is stopping.");
      }
      await this.observation.initializeAfterLogin?.();
      if (this.quiescing) {
        throw new BridgeError("CONFLICT", "Discord adapter is stopping.");
      }
      this.unsubscribe = [
        this.options.transport.onMessage((event) => this.dispatchMessage(event)),
        this.options.transport.onCommand((event) => this.handleCommand(event)),
        this.options.transport.onButton((event) => this.handleButton(event)),
      ];
      this.started = true;
    } catch (error) {
      this.removeListeners();
      this.attachmentStop ??= this.options.attachmentStore?.stop() ?? Promise.resolve();
      await this.attachmentStop.catch(() => undefined);
      throw error;
    }
  }

  quiesce(): void {
    if (this.quiescing) return;
    this.quiescing = true;
    this.removeListeners();
    this.pendingApprovals.clear();
    this.attachmentStop = this.options.attachmentStore?.stop() ?? Promise.resolve();
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.finishStop();
    return this.stopPromise;
  }

  private async finishStop(): Promise<void> {
    this.quiesce();
    const starting = this.startPromise;
    await this.attachmentStop;
    await starting?.catch(() => undefined);
    await Promise.allSettled([...this.activeMessageHandlers]);
    this.started = false;
    await this.options.transport.destroy();
  }

  async handleMessage(event: DiscordMessageEvent, commit?: IngressCommit): Promise<void> {
    let sourceAllowed = false;
    let progressStarted = false;
    let handedOff = false;
    let progressSource: DiscordObservationSource | undefined;
    try {
      const { bot, policy } = await this.snapshot();
      const decision = evaluateDiscordAccess({
        bot,
        policy,
        event: accessEvent("message", event, event.authorId, event.content, {
          bot: event.authorIsBot,
          system: event.authorIsSystem,
        }),
        now: this.now(),
        ...(this.options.createPairingCode === undefined
          ? {}
          : { createPairingCode: this.options.createPairingCode }),
      });
      if (decision.action === "drop") return;
      if (decision.action === "pair") {
        await this.persistPairing(policy, event, decision.code, decision.expiresAt);
        await this.options.transport.sendMessage(event.channelId, {
          content: `Pairing code: ${decision.code}`,
          replyToMessageId: event.id,
        });
        return;
      }

      sourceAllowed = true;
      if (event.content.length === 0 && event.attachments.length === 0) return;
      progressSource = observationSource(event);
      if (await this.observation.isProgressOnlyThread(progressSource)) {
        await this.observation.redirectProgressThreadInput(progressSource);
        return;
      }
      if (
        event.location === "dm" &&
        event.authorId === bot.ownerUserId &&
        bot.ownerConfirmedAt === undefined
      ) {
        await this.options.registry.confirmOwner(this.options.botName, event.authorId);
      }

      try {
        const observation = await this.observation.begin(progressSource);
        if (observation.reused) return;
        progressStarted = true;
        await this.observation.preparing(progressSource).catch((error) => this.reportError(error));
      } catch (error) {
        this.reportError(error);
      }

      await this.options.transport
        .sendTyping(event.channelId)
        .catch((error) => this.reportError(error));
      const typing = this.timers.setInterval(() => {
        void this.options.transport
          .sendTyping(event.channelId)
          .catch((error) => this.reportError(error));
      }, this.typingIntervalMs);
      try {
        const attachments =
          event.attachments.length === 0 ? [] : await this.persistAttachments(event);
        const enqueue = () => {
          if (this.quiescing) {
            throw new BridgeError("CONFLICT", "Discord adapter is stopping.");
          }
          return this.options.runtime.enqueue({
            channelId: event.channelId,
            messageId: event.id,
            authorId: event.authorId,
            ...(event.guildId === undefined ? {} : { guildId: event.guildId }),
            ...(event.parentChannelId === undefined
              ? {}
              : { parentChannelId: event.parentChannelId }),
            text: event.content,
            ...(attachments.length === 0 ? {} : { attachments: [...attachments] }),
          });
        };
        const prepareHandoff = async () => {
          if (!progressStarted || progressSource === undefined) return;
          await this.observation.queued(progressSource).catch((error) => this.reportError(error));
        };
        const enqueueAccepted = () => {
          const completion = enqueue();
          handedOff = true;
          return completion;
        };
        if (commit === undefined) {
          await prepareHandoff();
          await enqueueAccepted();
        } else {
          await commit.handoff(enqueueAccepted, prepareHandoff);
        }
      } finally {
        this.timers.clearInterval(typing);
      }
    } catch (error) {
      this.reportError(error);
      if (progressStarted && !handedOff && progressSource !== undefined) {
        await this.observation
          .terminal(progressSource, {
            message: "Discord ingress failed before enqueue.",
            status: "failed",
            type: "terminal",
          })
          .catch((terminalError) => this.reportError(terminalError));
      }
      if (sourceAllowed) {
        await this.options.transport
          .sendMessage(event.channelId, {
            content: "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.",
            replyToMessageId: event.id,
          })
          .catch((sendError) => this.reportError(sendError));
      }
    } finally {
      await commit?.skip();
    }
  }

  async handleCommand(event: DiscordCommandEvent): Promise<void> {
    try {
      const { bot, policy } = await this.snapshot();
      const decision = evaluateDiscordAccess({
        bot,
        policy,
        event: accessEvent("command", event, event.userId, `/codex ${event.subcommand}`),
        now: this.now(),
      });
      if (decision.action !== "deliver") {
        await event.respond("이 명령을 실행할 권한이 없습니다.");
        return;
      }

      await event.acknowledge();
      let result: unknown;
      switch (event.subcommand as CodexCommandName) {
        case "status": {
          const managerStatus = await this.options.manager.status();
          result = formatStatus(
            managerStatus,
            this.options.runtime.modelStatus(),
            this.options.runtime.state,
            this.options.runtime.queue.depth(),
          );
          break;
        }
        case "models":
          result = formatModelList(this.options.runtime.listModels());
          break;
        case "model":
          result = formatModelStatus(
            await this.options.runtime.setModel(modelSelection(event.name)),
          ).join("\n");
          break;
        case "reasoning":
          result = formatModelStatus(
            await this.options.runtime.setReasoningEffort(reasoningSelection(event.effort)),
          ).join("\n");
          break;
        case "new":
          result = await this.options.runtime.newSession(event.confirm === true, randomUUID());
          break;
        case "interrupt":
          await this.options.runtime.interrupt();
          result = { interrupted: true };
          break;
        case "spawn":
          if (event.bot === undefined || event.workspace === undefined) {
            throw new BridgeError("INVALID_ARGUMENT", "spawn requires bot and workspace options.");
          }
          result = await this.options.manager.spawn(event.bot, event.workspace);
          break;
        case "stop":
          result = await this.options.manager.stop();
          break;
        case "restart":
          result = await this.options.manager.restart();
          break;
        default:
          throw new BridgeError("INVALID_ARGUMENT", "Unknown /codex subcommand.");
      }
      await event.respond(commandResult(result));
    } catch (error) {
      this.reportError(error);
      const response =
        error instanceof BridgeError &&
        error.code === "CONFLICT" &&
        (event.subcommand === "model" || event.subcommand === "reasoning")
          ? "활성 또는 대기 중인 턴이 있습니다. 큐가 비면 다시 시도해 주세요."
          : "명령을 처리하지 못했습니다.";
      await event.respond(response).catch((sendError) => this.reportError(sendError));
    }
  }

  async handleButton(event: DiscordButtonEvent): Promise<void> {
    try {
      const { bot, policy } = await this.snapshot();
      const decision = evaluateDiscordAccess({
        bot,
        policy,
        event: accessEvent("approval", event, event.userId, event.customId),
        now: this.now(),
      });
      if (decision.action !== "deliver") {
        await event.respond("이 승인 요청을 처리할 권한이 없습니다.");
        return;
      }

      const parsed = this.parseApprovalButton(event.customId);
      const pending = parsed === undefined ? undefined : this.pendingApprovals.get(parsed.baseId);
      if (parsed === undefined || pending === undefined || pending.messageId !== event.messageId) {
        await event.respond("유효하지 않거나 만료된 승인 요청입니다.");
        return;
      }
      const interaction: ApprovalInteraction = {
        requestId: pending.requestId,
        messageId: event.messageId,
        userId: event.userId,
        action: parsed.action,
      };
      if (!this.options.approval.handleInteraction(interaction)) {
        await event.respond("유효하지 않거나 만료된 승인 요청입니다.");
        return;
      }
      this.pendingApprovals.delete(parsed.baseId);
      await event.respond(parsed.action === "allow" ? "승인했습니다." : "거부했습니다.");
    } catch (error) {
      this.reportError(error);
      await event.respond("승인 요청을 처리하지 못했습니다.").catch(() => undefined);
    }
  }

  async sendText(
    channelId: string,
    messageId: string,
    text: string,
    dispatch?: AgentRuntimeDeliveryDispatch,
  ): Promise<readonly DiscordDeliveryReceipt[]> {
    const { policy } = await this.snapshot();
    const chunks = chunkDiscordMarkdown(text, {
      limit: Math.min(policy.textChunkLimit, 2_000),
      mode: policy.chunkMode,
    });
    const receipts: DiscordDeliveryReceipt[] = [];
    for (const [index, content] of chunks.entries()) {
      const operation = async (directive: {
        readonly replyToMessageId?: string;
      }): Promise<DiscordDeliveryReceipt> => {
        const policyReply =
          dispatch === undefined &&
          (policy.replyToMode === "all" || (policy.replyToMode === "first" && index === 0));
        const replyToMessageId =
          directive.replyToMessageId ??
          (policyReply || (dispatch !== undefined && policy.replyToMode === "all")
            ? messageId
            : undefined);
        const sent = await this.options.transport.sendMessage(channelId, {
          content,
          ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
        });
        return createDiscordDeliveryReceipt({ channelId, messageId: sent.id });
      };
      receipts.push(await (dispatch === undefined ? operation({}) : dispatch(operation)));
    }
    return Object.freeze(receipts);
  }

  async report(channelId: string, messageId: string, text: string): Promise<void> {
    await this.sendText(channelId, messageId, text);
  }

  async sendFile(
    channelId: string,
    messageId: string,
    file: AuthorizedOutboundFile,
    message?: string,
    signal: AbortSignal = new AbortController().signal,
    dispatch?: AgentRuntimeDeliveryDispatch,
  ): Promise<DiscordDeliveryReceipt> {
    if (
      (message !== undefined && (typeof message !== "string" || message.length > 2_000)) ||
      !(signal instanceof AbortSignal) ||
      signal.aborted
    ) {
      throw new BridgeError("INVALID_ARGUMENT", "Invalid Discord file upload request.");
    }
    const { policy } = await this.snapshot();
    const operation = async (directive: {
      readonly replyToMessageId?: string;
    }): Promise<DiscordDeliveryReceipt> => {
      const replyToMessageId =
        directive.replyToMessageId ??
        (dispatch === undefined
          ? policy.replyToMode === "off"
            ? undefined
            : messageId
          : policy.replyToMode === "all"
            ? messageId
            : undefined);
      const sent = await this.options.transport.sendFile(channelId, {
        file,
        ...(message === undefined || message.length === 0 ? {} : { content: message }),
        ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
        signal,
      });
      return createDiscordDeliveryReceipt({ channelId, messageId: sent.id });
    };
    return dispatch === undefined ? operation({}) : dispatch(operation);
  }

  async sendApproval(notice: ApprovalNotice): Promise<string> {
    if (this.pendingApprovals.size >= MAX_PENDING_APPROVAL_BUTTONS) {
      throw new BridgeError("CONFLICT", "Too many pending Discord approval buttons.");
    }
    const baseId = `${APPROVAL_BUTTON_PREFIX}${randomUUID()}`;
    const sent = await this.options.transport.sendDirectMessage(notice.ownerId, {
      content: approvalText(notice),
      buttons: [
        { customId: `${baseId}:allow`, label: "Allow", style: "success" },
        { customId: `${baseId}:deny`, label: "Deny", style: "danger" },
      ],
    });
    this.pendingApprovals.set(baseId, { requestId: notice.requestId, messageId: sent.id });
    return sent.id;
  }

  private async snapshot() {
    const registry = await this.options.registry.read();
    return {
      bot: requiredRecordValue(registry.bots, this.options.botName, "Bot"),
      policy: requiredRecordValue(registry.access, this.options.botName, "Access policy"),
    };
  }

  private dispatchMessage(event: DiscordMessageEvent): Promise<void> {
    if (this.quiescing) return Promise.resolve();
    const previous = this.commitTail;
    let release!: () => void;
    this.commitTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = this.handleMessage(event, new IngressCommit(previous, release));
    this.activeMessageHandlers.add(operation);
    operation.then(
      () => this.activeMessageHandlers.delete(operation),
      () => this.activeMessageHandlers.delete(operation),
    );
    return operation;
  }

  private async persistAttachments(event: DiscordMessageEvent) {
    const store = this.options.attachmentStore;
    if (store === undefined) {
      throw new BridgeError("CONFIGURATION", "Discord attachment storage is unavailable.");
    }
    return store.persist({
      channelId: event.channelId,
      messageId: event.id,
      attachments: event.attachments,
    });
  }

  private async persistPairing(
    policy: AccessPolicy,
    event: DiscordMessageEvent,
    code: string,
    expiresAt: number,
  ): Promise<void> {
    if (Object.hasOwn(policy.pendingPairings, code)) return;
    const next: AccessPolicy = {
      ...policy,
      pendingPairings: {
        ...policy.pendingPairings,
        [code]: {
          senderId: event.authorId,
          dmChannelId: event.channelId,
          createdAt: new Date(this.now()).toISOString(),
          expiresAt: new Date(expiresAt).toISOString(),
          replyCount: 0,
        },
      },
    };
    await this.options.registry.updateAccess(
      this.options.botName,
      accessPolicyRevision(policy),
      next,
    );
  }

  private parseApprovalButton(
    customId: string,
  ): { baseId: string; action: "allow" | "deny" } | undefined {
    for (const action of ["allow", "deny"] as const) {
      const suffix = `:${action}`;
      if (customId.startsWith(APPROVAL_BUTTON_PREFIX) && customId.endsWith(suffix)) {
        return { baseId: customId.slice(0, -suffix.length), action };
      }
    }
    return undefined;
  }

  private removeListeners(): void {
    for (const unsubscribe of this.unsubscribe.splice(0)) {
      try {
        unsubscribe();
      } catch (error) {
        this.reportError(error);
      }
    }
  }

  private reportError(error: unknown): void {
    try {
      this.options.onError?.(error);
    } catch {
      // Error reporting must never break Gateway event handling.
    }
  }
}

function interactionLocation(guildId: string | null, channel: unknown): DiscordLocation {
  if (guildId === null) return "dm";
  return typeof channel === "object" &&
    channel !== null &&
    "isThread" in channel &&
    typeof channel.isThread === "function" &&
    channel.isThread()
    ? "thread"
    : "guild";
}

function parentChannelId(channel: unknown): string | undefined {
  if (typeof channel !== "object" || channel === null || !("parentId" in channel)) return undefined;
  const value = channel.parentId;
  return typeof value === "string" ? value : undefined;
}

function discordThreadOwnerId(channel: unknown): string | undefined {
  if (typeof channel !== "object" || channel === null || !("ownerId" in channel)) return undefined;
  const value = channel.ownerId;
  return typeof value === "string" ? value : undefined;
}

function progressAllowedMentions() {
  return {
    parse: [] as [],
    users: [] as string[],
    roles: [] as string[],
    repliedUser: false,
  };
}

function discordNumericField(error: unknown, field: "code" | "status"): number | undefined {
  if (typeof error !== "object" || error === null || !(field in error)) return undefined;
  const value = (error as Record<"code" | "status", unknown>)[field];
  return typeof value === "number" ? value : undefined;
}

function boundedDiscordError(
  error: unknown,
  messages: {
    readonly unauthorized: string;
    readonly rateLimited: string;
    readonly notFound: string;
    readonly failed: string;
  },
): BridgeError {
  if (error instanceof BridgeError) return error;
  const code = discordNumericField(error, "code");
  const status = discordNumericField(error, "status");
  if (code === 50_001 || code === 50_013 || status === 401 || status === 403) {
    return new BridgeError("UNAUTHORIZED", messages.unauthorized);
  }
  if (status === 429) {
    return new BridgeError("RUNTIME", messages.rateLimited);
  }
  if (code === 10_003 || code === 10_008 || status === 404) {
    return new BridgeError("NOT_FOUND", messages.notFound);
  }
  return new BridgeError("RUNTIME", messages.failed);
}

function acceptedDiscordId(value: unknown, failureMessage: string): string {
  if (typeof value !== "string" || !/^\d{1,32}$/u.test(value)) {
    throw new BridgeError("RUNTIME", failureMessage);
  }
  return value;
}

const PROGRESS_THREAD_REASON = "Codex progress observation";

function componentsFor(buttons: readonly DiscordButtonPayload[] | undefined) {
  if (buttons === undefined || buttons.length === 0) return [];
  const row = new ActionRowBuilder<ButtonBuilder>();
  row.addComponents(
    buttons.map((button) =>
      new ButtonBuilder()
        .setCustomId(button.customId)
        .setLabel(button.label)
        .setStyle(button.style === "success" ? ButtonStyle.Success : ButtonStyle.Danger),
    ),
  );
  return [row];
}

export class DiscordJsGatewayTransport implements DiscordGatewayTransport {
  readonly client: Client;

  constructor(
    client = new Client({
      intents: [
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    }),
  ) {
    this.client = client;
  }

  onMessage(handler: AsyncEventHandler<DiscordMessageEvent>): () => void {
    const wrapped = (message: import("discord.js").Message) => {
      const location = interactionLocation(message.guildId, message.channel);
      const messageParentId = location === "thread" ? parentChannelId(message.channel) : undefined;
      const messageThreadOwnerId =
        location === "thread" ? discordThreadOwnerId(message.channel) : undefined;
      const event: DiscordMessageEvent = {
        id: message.id,
        channelId: message.channelId,
        location,
        authorId: message.author.id,
        authorIsBot: message.author.bot,
        authorIsSystem: message.author.system,
        content: message.content,
        mentionsBot: this.client.user !== null && message.mentions.users.has(this.client.user.id),
        attachments: [...message.attachments.values()].map((attachment) => ({
          id: attachment.id,
          filename: attachment.name,
          size: attachment.size,
          ...(attachment.contentType === null ? {} : { contentType: attachment.contentType }),
          url: attachment.url,
        })),
        ...(message.guildId === null ? {} : { guildId: message.guildId }),
        ...(location !== "thread" || messageParentId === undefined
          ? {}
          : { parentChannelId: messageParentId }),
        ...(location !== "thread" || messageThreadOwnerId === undefined
          ? {}
          : { threadOwnerId: messageThreadOwnerId }),
      };
      void handler(event).catch((error) => this.emitError(error));
    };
    this.client.on(Events.MessageCreate, wrapped);
    return () => this.client.off(Events.MessageCreate, wrapped);
  }

  onCommand(handler: AsyncEventHandler<DiscordCommandEvent>): () => void {
    const wrapped = (interaction: import("discord.js").Interaction) => {
      if (!interaction.isChatInputCommand() || interaction.commandName !== "codex") return;
      const location = interactionLocation(interaction.guildId, interaction.channel);
      const subcommand = interaction.options.getSubcommand(false) ?? "";
      const parentId = parentChannelId(interaction.channel);
      const confirm = subcommand === "new" ? interaction.options.getBoolean("confirm") : null;
      const bot = subcommand === "spawn" ? interaction.options.getString("bot") : null;
      const workspace = subcommand === "spawn" ? interaction.options.getString("workspace") : null;
      const name = subcommand === "model" ? interaction.options.getString("name") : null;
      const effort = subcommand === "reasoning" ? interaction.options.getString("effort") : null;
      const event: DiscordCommandEvent = {
        id: interaction.id,
        channelId: interaction.channelId,
        location,
        userId: interaction.user.id,
        subcommand,
        ...(interaction.guildId === null ? {} : { guildId: interaction.guildId }),
        ...(parentId === undefined ? {} : { parentChannelId: parentId }),
        ...(confirm === null ? {} : { confirm }),
        ...(bot === null ? {} : { bot }),
        ...(workspace === null ? {} : { workspace }),
        ...(name === null ? {} : { name }),
        ...(effort === null ? {} : { effort }),
        acknowledge: async () => {
          if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          }
        },
        respond: async (content) => {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content });
          } else {
            await interaction.reply({ content, flags: MessageFlags.Ephemeral });
          }
        },
      };
      void handler(event).catch((error) => this.emitError(error));
    };
    this.client.on(Events.InteractionCreate, wrapped);
    return () => this.client.off(Events.InteractionCreate, wrapped);
  }

  onButton(handler: AsyncEventHandler<DiscordButtonEvent>): () => void {
    const wrapped = (interaction: import("discord.js").Interaction) => {
      if (!interaction.isButton() || !interaction.customId.startsWith(APPROVAL_BUTTON_PREFIX))
        return;
      const location = interactionLocation(interaction.guildId, interaction.channel);
      const parentId = parentChannelId(interaction.channel);
      const event: DiscordButtonEvent = {
        customId: interaction.customId,
        messageId: interaction.message.id,
        channelId: interaction.channelId,
        location,
        userId: interaction.user.id,
        ...(interaction.guildId === null ? {} : { guildId: interaction.guildId }),
        ...(parentId === undefined ? {} : { parentChannelId: parentId }),
        respond: async (content) => {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content });
          } else {
            await interaction.reply({ content, flags: MessageFlags.Ephemeral });
          }
        },
      };
      void handler(event).catch((error) => this.emitError(error));
    };
    this.client.on(Events.InteractionCreate, wrapped);
    return () => this.client.off(Events.InteractionCreate, wrapped);
  }

  async login(token: string): Promise<void> {
    await this.client.login(token);
  }

  async destroy(): Promise<void> {
    this.client.destroy();
  }

  async sendTyping(channelId: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (channel === null || !channel.isSendable()) {
      throw new BridgeError("NOT_FOUND", `Discord channel is not sendable: ${channelId}`);
    }
    await channel.sendTyping();
  }

  async sendMessage(channelId: string, payload: DiscordMessagePayload): Promise<{ id: string }> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel === null || !channel.isSendable()) {
        throw new BridgeError("NOT_FOUND", `Discord channel is not sendable: ${channelId}`);
      }
      const sent = await channel.send({
        content: payload.content,
        components: componentsFor(payload.buttons),
        allowedMentions: progressAllowedMentions(),
        ...(payload.replyToMessageId === undefined
          ? {}
          : { reply: { messageReference: payload.replyToMessageId, failIfNotExists: false } }),
      });
      return {
        id: acceptedDiscordId(sent.id, "Discord returned an invalid message receipt."),
      };
    } catch (error) {
      throw boundedDiscordError(error, {
        unauthorized: "Discord denied message sending.",
        rateLimited: "Discord rate-limited message sending.",
        notFound: "Discord message channel was not found.",
        failed: "Discord message send failed.",
      });
    }
  }

  async createProgressThread(
    channelId: string,
    sourceMessageId: string,
    options: DiscordProgressThreadOptions = {},
  ): Promise<DiscordProgressThread> {
    try {
      acceptedDiscordId(channelId, "Discord parent channel ID is invalid.");
      acceptedDiscordId(sourceMessageId, "Discord source message ID is invalid.");
      const channel = await this.client.channels.fetch(channelId);
      if (
        channel === null ||
        (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)
      ) {
        throw new BridgeError(
          "INVALID_ARGUMENT",
          "Discord progress threads require a guild text channel.",
        );
      }
      const sourceMessage = await channel.messages.fetch(sourceMessageId);
      const autoArchiveDuration = options.autoArchiveDuration ?? 1_440;
      if (![60, 1_440, 4_320, 10_080].includes(autoArchiveDuration)) {
        throw new BridgeError(
          "INVALID_ARGUMENT",
          "Discord progress thread auto-archive duration is invalid.",
        );
      }
      const thread = await sourceMessage.startThread({
        name: `Codex progress ${sourceMessageId.slice(-8)}`,
        autoArchiveDuration,
        reason: PROGRESS_THREAD_REASON,
      });
      return {
        id: acceptedDiscordId(thread.id, "Discord returned an invalid progress thread."),
        parentId: acceptedDiscordId(
          thread.parentId,
          "Discord returned an invalid progress thread.",
        ),
        ownerId: acceptedDiscordId(thread.ownerId, "Discord returned an invalid progress thread."),
      };
    } catch (error) {
      throw boundedDiscordError(error, {
        unauthorized: "Discord denied progress thread creation.",
        rateLimited: "Discord rate-limited progress thread creation.",
        notFound: "Discord source message or channel was not found.",
        failed: "Discord progress thread creation failed.",
      });
    }
  }

  async editMessage(
    channelId: string,
    messageId: string,
    payload: Pick<DiscordMessagePayload, "content">,
  ): Promise<{ id: string }> {
    try {
      const botUserId = this.requireBotUserId();
      const channel = await this.client.channels.fetch(channelId);
      if (channel === null || !channel.isSendable() || !("messages" in channel)) {
        throw new BridgeError("NOT_FOUND", "Discord progress message channel was not found.");
      }
      const message = await channel.messages.fetch(messageId);
      if (message.author.id !== botUserId || !message.editable) {
        throw new BridgeError(
          "UNAUTHORIZED",
          "Discord progress message is not editable by this bot.",
        );
      }
      const edited = await message.edit({
        content: payload.content,
        allowedMentions: progressAllowedMentions(),
      });
      return {
        id: acceptedDiscordId(edited.id, "Discord returned an invalid message receipt."),
      };
    } catch (error) {
      throw boundedDiscordError(error, {
        unauthorized: "Discord denied progress message editing.",
        rateLimited: "Discord rate-limited progress message editing.",
        notFound: "Discord progress message was not found.",
        failed: "Discord progress message editing failed.",
      });
    }
  }

  async inspectProgressCapabilities(channelId: string): Promise<DiscordProgressCapabilities> {
    try {
      const botUserId = this.requireBotUserId();
      const channel = await this.client.channels.fetch(channelId);
      if (
        channel === null ||
        (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)
      ) {
        throw new BridgeError(
          "INVALID_ARGUMENT",
          "Discord progress threads require a guild text channel.",
        );
      }
      const permissions = channel.permissionsFor(botUserId);
      if (permissions === null) {
        throw new BridgeError(
          "UNAUTHORIZED",
          "Discord progress thread permissions are unavailable.",
        );
      }
      return {
        createPublicThreads: permissions.has(PermissionFlagsBits.CreatePublicThreads),
        sendMessagesInThreads: permissions.has(PermissionFlagsBits.SendMessagesInThreads),
        manageThreads: permissions.has(PermissionFlagsBits.ManageThreads),
      };
    } catch (error) {
      throw boundedDiscordError(error, {
        unauthorized: "Discord denied progress permission inspection.",
        rateLimited: "Discord rate-limited progress permission inspection.",
        notFound: "Discord progress parent channel was not found.",
        failed: "Discord progress permission inspection failed.",
      });
    }
  }

  async inspectThread(threadId: string): Promise<DiscordThreadInspection> {
    try {
      const channel = await this.client.channels.fetch(threadId);
      if (channel === null) return { status: "not-found", threadId };
      if (!channel.isThread()) {
        throw new BridgeError("CONFIGURATION", "Discord channel is not a progress thread.");
      }
      return {
        status: "found",
        id: acceptedDiscordId(channel.id, "Discord returned invalid thread metadata."),
        parentId: acceptedDiscordId(channel.parentId, "Discord returned invalid thread metadata."),
        ownerId: acceptedDiscordId(channel.ownerId, "Discord returned invalid thread metadata."),
        archived: channel.archived === true,
        locked: channel.locked === true,
      };
    } catch (error) {
      if (discordNumericField(error, "code") === 10_003) {
        return { status: "not-found", threadId };
      }
      throw boundedDiscordError(error, {
        unauthorized: "Discord denied access to the progress thread.",
        rateLimited: "Discord rate-limited progress thread inspection.",
        notFound: "Discord progress thread was not found.",
        failed: "Discord progress thread inspection failed.",
      });
    }
  }

  async setProgressThreadState(threadId: string, state: DiscordProgressThreadState): Promise<void> {
    try {
      const botUserId = this.requireBotUserId();
      const channel = await this.client.channels.fetch(threadId);
      if (channel === null || !channel.isThread()) {
        throw new BridgeError("NOT_FOUND", "Discord progress thread was not found.");
      }
      if (channel.ownerId !== botUserId) {
        throw new BridgeError("UNAUTHORIZED", "Discord progress thread is not owned by this bot.");
      }
      if (!state.archived && channel.archived !== false) {
        await channel.setArchived(false, PROGRESS_THREAD_REASON);
      }
      if (channel.locked !== state.locked) {
        await channel.setLocked(state.locked, PROGRESS_THREAD_REASON);
      }
      if (state.archived && channel.archived !== true) {
        await channel.setArchived(true, PROGRESS_THREAD_REASON);
      }
    } catch (error) {
      throw boundedDiscordError(error, {
        unauthorized: "Discord denied progress thread state changes.",
        rateLimited: "Discord rate-limited progress thread state changes.",
        notFound: "Discord progress thread was not found.",
        failed: "Discord progress thread state change failed.",
      });
    }
  }

  async sendFile(channelId: string, payload: DiscordFilePayload): Promise<{ id: string }> {
    if (payload.signal.aborted) payload.signal.throwIfAborted();
    const channel = await this.client.channels.fetch(channelId);
    if (channel === null || !channel.isSendable()) {
      throw new BridgeError("NOT_FOUND", `Discord channel is not sendable: ${channelId}`);
    }
    if (payload.signal.aborted) payload.signal.throwIfAborted();
    const stream = addAbortSignal(payload.signal, payload.file.createReadStream());
    const sent = await channel.send({
      ...(payload.content === undefined ? {} : { content: payload.content }),
      files: [{ attachment: stream, name: payload.file.displayFilename }],
      ...(payload.replyToMessageId === undefined
        ? {}
        : { reply: { messageReference: payload.replyToMessageId, failIfNotExists: false } }),
    });
    return { id: sent.id };
  }

  async sendDirectMessage(userId: string, payload: DiscordMessagePayload): Promise<{ id: string }> {
    const user = await this.client.users.fetch(userId);
    const sent = await user.send({
      content: payload.content,
      components: componentsFor(payload.buttons),
    });
    return { id: sent.id };
  }

  private emitError(error: unknown): void {
    this.client.emit(Events.Error, error instanceof Error ? error : new Error(String(error)));
  }

  private requireBotUserId(): string {
    const botUserId = this.client.user?.id;
    if (botUserId === undefined) {
      throw new BridgeError("CONFIGURATION", "Discord bot identity is unavailable.");
    }
    return acceptedDiscordId(botUserId, "Discord bot identity is invalid.");
  }
}

export function createDiscordJsGatewayTransport(): DiscordGatewayTransport {
  return new DiscordJsGatewayTransport();
}
