import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppServerClient } from "../app-server/client.js";
import { CodexAppServerProcess } from "../app-server/process.js";
import type {
  ApprovalRequestMethod,
  ServerRequestParams,
  ServerRequestResult,
} from "../app-server/protocol.js";
import { CodexSessionService, projectCodexSessionEvent } from "../app-server/session.js";
import { AtomicThreadCreationJournal } from "../app-server/thread-creation-journal.js";
import {
  createDiscordJsGatewayTransport,
  type DiscordAgentManager,
  DiscordGatewayAdapter,
  type DiscordGatewayTransport,
} from "../discord/adapter.js";
import {
  DiscordAttachmentStore,
  type DiscordAttachmentStoreOptions,
  type DiscordAttachmentStorePort,
} from "../discord/attachments.js";
import { redactDiscordSecrets } from "../discord/format.js";
import { createIngressLog } from "../discord/ingress-log.js";
import {
  DiscordProgressController,
  type DiscordProgressControllerOptions,
} from "../discord/progress-controller.js";
import {
  AtomicProgressObservationJournal,
  type AtomicProgressObservationJournalOptions,
} from "../discord/progress-journal.js";
import { BridgeError } from "../domain/errors.js";
import type { AgentBinding, RegistryDocument } from "../domain/schemas.js";
import { injectConfigPath, loadInjectConfig } from "../inject/config.js";
import { InjectGuard } from "../inject/guard.js";
import { InjectService } from "../inject/service.js";
import {
  type InjectSocketServer,
  injectSocketPath,
  startInjectSocketServer,
} from "../inject/socket.js";
import { createDefaultManagerService, type ManagerService } from "../manager/service.js";
import { WorkspaceNormalizer } from "../manager/workspaces.js";
import {
  AgentRunner,
  type RunnerComponent,
  type RunnerComponentContext,
  type RunnerRegistryRecord,
} from "../runner.js";
import { createDefaultCredentialStore } from "../secrets/platform.js";
import { RegistryStore } from "../storage/registry.js";
import {
  AgentRuntime,
  type AgentRuntimeAppServer,
  type AgentRuntimeBinding,
  type AgentRuntimeRegistry,
  type AgentRuntimeSendFileRequest,
  type AgentRuntimeSendFileResult,
  type AgentRuntimeSession,
} from "./agent-runtime.js";
import { ApprovalRouter } from "./approval-router.js";
import { DeliveryLedger } from "./delivery-ledger.js";
import { GuardianOverrideRouter } from "./guardian-override.js";
import { createRuntimeLog } from "./lifecycle-log.js";

const APPROVAL_METHODS: readonly ApprovalRequestMethod[] = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "execCommandApproval",
  "applyPatchApproval",
];

interface GuardianOverrideConfig {
  readonly ttlMinutes?: number;
  readonly autoRetry?: boolean;
  readonly fallbackChannelId?: string;
  readonly approvalChannelId?: string;
}

// Opt-in per bot: <instance>/guardian-override.json {"enabled": true, ...}. Absent or invalid
// means the bot keeps the plain Auto Review behaviour.
async function loadGuardianOverrideConfig(
  path: string,
  reportError: (error: unknown) => void,
): Promise<GuardianOverrideConfig | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return undefined;
    const config = value as Record<string, unknown>;
    if (config.enabled !== true) return undefined;
    const ttl = config.ttlMinutes;
    const channel = config.fallbackChannelId;
    const approvalChannel = config.approvalChannelId;
    return {
      ...(typeof approvalChannel === "string" && /^\d{5,32}$/.test(approvalChannel)
        ? { approvalChannelId: approvalChannel }
        : {}),
      ...(typeof ttl === "number" && Number.isInteger(ttl) && ttl >= 1 && ttl <= 240
        ? { ttlMinutes: ttl }
        : {}),
      ...(typeof config.autoRetry === "boolean" ? { autoRetry: config.autoRetry } : {}),
      ...(typeof channel === "string" && /^\d{5,32}$/.test(channel)
        ? { fallbackChannelId: channel }
        : {}),
    };
  } catch (error) {
    reportError(error);
    return undefined;
  }
}

function ownValue<T>(record: Record<string, T>, key: string, label: string): T {
  const value = Object.hasOwn(record, key) ? record[key] : undefined;
  if (value === undefined) throw new BridgeError("CONFIGURATION", `${label} not found: ${key}`);
  return value;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function prepareAttachmentStagingDirectory(
  instanceDirectory: string,
  stagingDirectory: string,
): Promise<void> {
  try {
    const canonicalInstance = await realpath(instanceDirectory);
    try {
      await mkdir(stagingDirectory, { mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
    const entry = await lstat(stagingDirectory);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error("Unsafe attachment staging entry");
    }
    const canonicalStaging = await realpath(stagingDirectory);
    if (dirname(canonicalStaging) !== canonicalInstance) {
      throw new Error("Attachment staging escaped its instance directory");
    }
    const flags =
      fsConstants.O_RDONLY |
      fsConstants.O_NONBLOCK |
      fsConstants.O_NOFOLLOW |
      (typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0);
    const handle = await open(stagingDirectory, flags);
    try {
      if (!(await handle.stat()).isDirectory()) {
        throw new Error("Attachment staging descriptor is not a directory");
      }
      await handle.chmod(0o700);
    } finally {
      await handle.close();
    }
  } catch {
    throw new BridgeError(
      "CONFIGURATION",
      "Attachment staging directory is unavailable or unsafe.",
      "Repair the binding instance directory and retry.",
    );
  }
}

function bindingRecord(document: RegistryDocument, instanceId: string): RunnerRegistryRecord {
  const binding = ownValue(document.bindings, instanceId, "Binding");
  return {
    binding,
    bot: ownValue(document.bots, binding.botName, "Bot"),
    workspace: ownValue(document.workspaces, binding.workspace, "Workspace"),
  };
}

function acceptedApproval(response: unknown): "accept" | "decline" {
  if (typeof response !== "object" || response === null || !("result" in response)) {
    return "decline";
  }
  const result = response.result;
  if (typeof result !== "object" || result === null) return "decline";
  if ("scope" in result && result.scope === "turn") return "accept";
  if (!("decision" in result)) return "decline";
  return result.decision === "accept" || result.decision === "approved" ? "accept" : "decline";
}

export function createRuntimeSession(
  client: AppServerClient,
  session: CodexSessionService,
): AgentRuntimeSession {
  let sendFileListener:
    | ((
        request: AgentRuntimeSendFileRequest,
      ) => Promise<AgentRuntimeSendFileResult> | AgentRuntimeSendFileResult)
    | undefined;
  const removeSendFileHandler = client.handleRequest("item/tool/call", async (params) => {
    if (params.tool !== "discord_send_file" || sendFileListener === undefined) {
      return failedFileDeliveryResult();
    }
    try {
      return await sendFileListener({
        threadId: params.threadId,
        turnId: params.turnId,
        callId: params.callId,
        arguments: params.arguments,
      });
    } catch {
      return failedFileDeliveryResult();
    }
  });
  const onNotification: AgentRuntimeSession["onNotification"] = (method, listener) => {
    switch (method) {
      case "turn/started":
      case "turn/completed":
        return client.onNotification(method, (params) => {
          const event = projectCodexSessionEvent(method, params);
          if (event !== undefined) listener(event);
        });
      case "item/started":
        return client.onNotification(method, (params) => {
          const event = projectCodexSessionEvent(method, params);
          if (event !== undefined) listener(event);
        });
      case "item/completed":
        return client.onNotification(method, (params) => {
          const event = projectCodexSessionEvent(method, params);
          if (event !== undefined) listener(event);
        });
      case "item/agentMessage/delta":
        return client.onNotification(method, (params) => {
          const event = projectCodexSessionEvent(method, params);
          if (event !== undefined) listener(event);
        });
      case "turn/plan/updated":
      case "item/reasoning/summaryTextDelta":
      case "warning":
        return client.onNotification(method, (params) => {
          const event = projectCodexSessionEvent(method, params);
          if (event !== undefined) listener(event);
        });
    }
  };
  return {
    terminalTurnStatusFromRollout: (threadId, turnId) =>
      session.terminalTurnStatusFromRollout(threadId, turnId),
    terminalTurnStatus: (threadId, turnId) => session.terminalTurnStatus(threadId, turnId),
    listModels: () => session.listModels(),
    resume: (threadId, workspace, inbox) => session.resume(threadId, workspace, inbox),
    startTurn: (threadId, input, source, settings) =>
      session.startTurn(threadId, input, source, settings),
    interrupt: (threadId, turnId) => session.interrupt(threadId, turnId),
    start: (workspace, inbox, creationKey) => session.start(workspace, inbox, creationKey),
    onNotification,
    onSendFileRequest: (listener) => {
      if (sendFileListener !== undefined) {
        throw new BridgeError("CONFLICT", "A Discord file request listener is already installed.");
      }
      sendFileListener = listener;
      return () => {
        if (sendFileListener === listener) sendFileListener = undefined;
      };
    },
    authorizeSendFile: (threadId, input) => session.authorizeSendFile(threadId, input),
    parseFileMarkers: (threadId, text) => session.parseFileMarkers(threadId, text),
    dispose: () => {
      sendFileListener = undefined;
      removeSendFileHandler();
    },
  };
}

function failedFileDeliveryResult(): ServerRequestResult<"item/tool/call"> {
  return {
    success: false,
    contentItems: [{ type: "inputText", text: "File could not be sent." }],
  };
}

function runtimeBinding(
  binding: AgentBinding,
  workspace: RunnerRegistryRecord["workspace"],
  inbox: string,
): AgentRuntimeBinding {
  if (binding.workspace !== workspace.name) {
    throw new BridgeError("CONFIGURATION", "Binding workspace changed during registry update.");
  }
  return {
    id: binding.id,
    threadId: binding.threadId,
    workspace,
    inbox,
    ...(binding.modelId === undefined ? {} : { modelId: binding.modelId }),
    ...(binding.reasoningEffort === undefined ? {} : { reasoningEffort: binding.reasoningEffort }),
  };
}

type RuntimeRegistryStore = Pick<
  RegistryStore,
  "read" | "markObservedState" | "replaceThread" | "updateModelSettings"
>;

export function createRuntimeRegistryPort(
  registry: RuntimeRegistryStore,
  instanceId: string,
  inbox: string,
): AgentRuntimeRegistry {
  const readBinding = async (bindingId: string): Promise<AgentRuntimeBinding> => {
    const record = bindingRecord(await registry.read(), bindingId);
    return runtimeBinding(record.binding, record.workspace, inbox);
  };
  const readWorkspace = async (bindingId: string): Promise<RunnerRegistryRecord["workspace"]> =>
    bindingRecord(await registry.read(), bindingId).workspace;

  return {
    readBinding: () => readBinding(instanceId),
    markState: async (state) => {
      if (state === "recovering") return;
      await registry.markObservedState(instanceId, state);
    },
    replaceThread: async (bindingId, threadId) => {
      const workspace = await readWorkspace(bindingId);
      const binding = await registry.replaceThread(bindingId, threadId);
      return runtimeBinding(binding, workspace, inbox);
    },
    updateModelSettings: async (bindingId, settings) => {
      const workspace = await readWorkspace(bindingId);
      const binding = await registry.updateModelSettings(bindingId, settings);
      return runtimeBinding(binding, workspace, inbox);
    },
  };
}

interface FallbackAgentManagerOptions {
  readonly sharedManager: Pick<ManagerService, "status" | "spawnForOwner">;
  readonly runtime: {
    readonly state: AgentRuntime["state"];
    readonly queue: Pick<AgentRuntime["queue"], "depth">;
    modelStatus(): ReturnType<AgentRuntime["modelStatus"]>;
  };
  readonly bindingId: string;
  readonly ownerUserId: string;
  requestShutdown(restart?: boolean): void;
}

export function createFallbackAgentManager(
  options: FallbackAgentManagerOptions,
): DiscordAgentManager {
  return {
    status: async () => ({
      persisted: await options.sharedManager.status(options.bindingId),
      runtimeState: options.runtime.state,
      queueDepth: options.runtime.queue.depth(),
      model: options.runtime.modelStatus(),
    }),
    spawn: (botName, workspaceName) =>
      options.sharedManager.spawnForOwner(options.ownerUserId, botName, workspaceName),
    stop: async () => {
      setImmediate(() => options.requestShutdown(false));
      return { stopping: true };
    },
    restart: async () => {
      setImmediate(() => options.requestShutdown(true));
      return { restarting: true };
    },
  };
}

class RuntimeAppServer {
  private readonly process = new CodexAppServerProcess();
  private readonly workspaceNormalizer: WorkspaceNormalizer;
  private readonly journal: AtomicThreadCreationJournal;
  private readonly approval: ApprovalRouter;
  private readonly guardian: Pick<GuardianOverrideRouter, "handleReview"> | undefined;
  private approvalUnsubscribe: Array<() => void> = [];
  private runtimeSession: AgentRuntimeSession | undefined;
  private client: AppServerClient | undefined;

  constructor(
    workspaceNormalizer: WorkspaceNormalizer,
    journal: AtomicThreadCreationJournal,
    approval: ApprovalRouter,
    guardian?: Pick<GuardianOverrideRouter, "handleReview">,
  ) {
    this.workspaceNormalizer = workspaceNormalizer;
    this.journal = journal;
    this.approval = approval;
    this.guardian = guardian;
  }

  // Official owner override of one Auto Review denial, on the live App Server.
  async approveGuardianDenied(threadId: string, event: Record<string, unknown>): Promise<void> {
    const client = this.client;
    if (client === undefined) throw new BridgeError("CONFLICT", "Codex App Server is not running.");
    await client.request("thread/approveGuardianDeniedAction", { threadId, event });
  }

  async start(): Promise<AgentRuntimeSession> {
    const client = await this.process.start();
    try {
      await client.initialize("0.1.0");
      this.bindApprovals(client);
      this.client = client;
      const guardian = this.guardian;
      if (guardian !== undefined) {
        this.approvalUnsubscribe.push(
          client.onNotification("item/autoApprovalReview/completed", (review) =>
            guardian.handleReview(review),
          ),
        );
      }
      const session = new CodexSessionService({
        client,
        workspaceNormalizer: this.workspaceNormalizer,
        threadCreationJournal: this.journal,
      });
      const runtimeSession = createRuntimeSession(client, session);
      this.runtimeSession = runtimeSession;
      return runtimeSession;
    } catch (error) {
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.runtimeSession?.dispose?.();
    this.runtimeSession = undefined;
    this.client = undefined;
    for (const unsubscribe of this.approvalUnsubscribe.splice(0)) unsubscribe();
    await this.process.stop();
  }

  private bindApprovals(client: AppServerClient): void {
    for (const method of APPROVAL_METHODS) {
      this.approvalUnsubscribe.push(
        client.handleApprovalRequest(method, async (params, context) => {
          const response = await this.approval.register({
            id: context.id,
            method,
            params: params as ServerRequestParams<typeof method>,
          });
          return acceptedApproval(response);
        }),
      );
    }
  }
}

export interface RuntimeAppServerOptions {
  readonly workspaceNormalizer: WorkspaceNormalizer;
  readonly journal: AtomicThreadCreationJournal;
  readonly approval: ApprovalRouter;
  readonly guardian?: Pick<GuardianOverrideRouter, "handleReview">;
}

export interface ProductionAgentComponentOptions {
  readonly createTransport?: () => DiscordGatewayTransport;
  readonly createAttachmentStore?: (
    options: DiscordAttachmentStoreOptions,
  ) => DiscordAttachmentStorePort;
  readonly createAppServer?: (options: RuntimeAppServerOptions) => AgentRuntimeAppServer;
  readonly createProgressJournal?: (
    options: AtomicProgressObservationJournalOptions,
  ) => AtomicProgressObservationJournal;
  readonly createProgressController?: (
    options: DiscordProgressControllerOptions,
  ) => DiscordProgressController;
  readonly createManager?: (context: {
    readonly binding: AgentBinding;
    readonly runtime: AgentRuntime;
    requestShutdown(restart?: boolean): void;
    readonly registry: RegistryStore;
  }) => DiscordAgentManager;
}

export async function createProductionAgentComponent(
  context: RunnerComponentContext,
  options: ProductionAgentComponentOptions = {},
): Promise<RunnerComponent> {
  const registry = new RegistryStore({ registryPath: context.paths.registryPath });
  const sharedManager = await createDefaultManagerService(context.paths);
  const inbox = context.paths.instanceInboxDirectory(context.binding.id);
  const workspaceNormalizer = new WorkspaceNormalizer({
    bridgePaths: {
      root: context.paths.root,
      registryPath: context.paths.registryPath,
      logsDirectory: context.paths.logsDirectory,
      instancesDirectory: context.paths.instancesDirectory,
      inboxDirectory: context.paths.inboxDirectory,
      managerStatePaths: [context.paths.registryPath],
    },
  });
  const journal = new AtomicThreadCreationJournal({
    filePath: join(context.paths.instanceDirectory(context.binding.id), "thread-creations.json"),
  });
  const stagingDirectory = join(
    context.paths.instanceDirectory(context.binding.id),
    "attachment-staging",
  );
  await prepareAttachmentStagingDirectory(
    context.paths.instanceDirectory(context.binding.id),
    stagingDirectory,
  );
  const attachmentStoreOptions: DiscordAttachmentStoreOptions = {
    inboxDirectory: inbox,
    stagingDirectory,
  };
  const attachmentStore =
    options.createAttachmentStore?.(attachmentStoreOptions) ??
    new DiscordAttachmentStore(attachmentStoreOptions);
  const transport = options.createTransport?.() ?? createDiscordJsGatewayTransport();
  const reportError = (error: unknown): void => {
    process.stderr.write(`${redactDiscordSecrets(error, { maxOutputLength: 1_000 })}\n`);
  };
  const progressJournalOptions: AtomicProgressObservationJournalOptions = {
    filePath: join(
      context.paths.instanceDirectory(context.binding.id),
      "progress-observations.json",
    ),
  };
  const progressJournal =
    options.createProgressJournal?.(progressJournalOptions) ??
    new AtomicProgressObservationJournal(progressJournalOptions);
  const fixedProgressThread = await readFile(
    join(context.paths.instanceDirectory(context.binding.id), "fixed-progress-thread.json"),
    "utf8",
  )
    .then((value) => {
      const config: unknown = JSON.parse(value);
      if (
        typeof config !== "object" ||
        config === null ||
        !("parentChannelId" in config) ||
        !("threadId" in config) ||
        typeof config.parentChannelId !== "string" ||
        typeof config.threadId !== "string" ||
        !/^\d{17,20}$/.test(config.parentChannelId) ||
        !/^\d{17,20}$/.test(config.threadId) ||
        ("enabled" in config && typeof config.enabled !== "boolean") ||
        config.parentChannelId === config.threadId
      ) {
        throw new Error("Invalid fixed progress thread configuration.");
      }
      return {
        parentChannelId: config.parentChannelId,
        threadId: config.threadId,
        enabled: !("enabled" in config) || config.enabled === true,
      };
    })
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") reportError(error);
      return undefined;
    });
  const progressControllerOptions: DiscordProgressControllerOptions = {
    ...(fixedProgressThread ? { fixedProgressThread } : {}),
    botUserId: context.bot.botUserId,
    journal: progressJournal,
    onError: reportError,
    transport,
  };
  const progress =
    options.createProgressController?.(progressControllerOptions) ??
    new DiscordProgressController(progressControllerOptions);
  let adapter: DiscordGatewayAdapter;
  const approval = new ApprovalRouter({
    ownerId: context.bot.ownerUserId,
    discord: { sendApproval: (notice) => adapter.sendApproval(notice) },
  });
  const guardianConfig = await loadGuardianOverrideConfig(
    join(context.paths.instanceDirectory(context.binding.id), "guardian-override.json"),
    reportError,
  );
  let runtimeAppServer: RuntimeAppServer | undefined;
  let runtimeRef: AgentRuntime | undefined;
  const guardian =
    guardianConfig === undefined
      ? undefined
      : new GuardianOverrideRouter({
          ownerId: context.bot.ownerUserId,
          botName: context.bot.name,
          logPath: join(
            context.paths.instanceDirectory(context.binding.id),
            "guardian-overrides.jsonl",
          ),
          ...(guardianConfig.ttlMinutes === undefined
            ? {}
            : { ttlMs: guardianConfig.ttlMinutes * 60_000 }),
          ...(guardianConfig.autoRetry === undefined
            ? {}
            : { autoRetry: guardianConfig.autoRetry }),
          ...(guardianConfig.fallbackChannelId === undefined
            ? {}
            : { fallbackChannelId: guardianConfig.fallbackChannelId }),
          onError: reportError,
          ports: {
            sendNotice: (notice) => adapter.sendGuardianOverride(notice),
            noticeLink: (messageId) => adapter.approvalLink(messageId),
            notifyOwner: (text) => adapter.sendOwnerNotice(context.bot.ownerUserId, text),
            approve: async (threadId, event) => {
              if (runtimeAppServer === undefined)
                throw new BridgeError("CONFLICT", "Owner override needs the built-in App Server.");
              await runtimeAppServer.approveGuardianDenied(threadId, event);
            },
            currentThreadId: () => runtimeRef?.currentThreadId,
            channelForTurn: (turnId) => runtimeRef?.channelForTurn(turnId),
            retry: async (channelId, text) => {
              const document = await registry.read();
              const bot = ownValue(document.bots, context.bot.name, "Bot");
              await adapter.injectTurn({ channelId, authorId: bot.botUserId, text });
            },
          },
        });
  const runtimeAppServerOptions: RuntimeAppServerOptions = {
    workspaceNormalizer,
    journal,
    approval,
    ...(guardian === undefined ? {} : { guardian }),
  };
  const customAppServer = options.createAppServer?.(runtimeAppServerOptions);
  if (customAppServer === undefined)
    runtimeAppServer = new RuntimeAppServer(workspaceNormalizer, journal, approval, guardian);
  const appServer = customAppServer ?? (runtimeAppServer as RuntimeAppServer);
  const deliveryLedger = new DeliveryLedger(
    join(context.paths.instanceDirectory(context.binding.id), "delivery-ledger.json"),
  );
  const runtime = new AgentRuntime({
    deliveryLifecycle: deliveryLedger,
    registry: createRuntimeRegistryPort(registry, context.binding.id, inbox),
    appServer,
    output: {
      diagnostic: createRuntimeLog(
        join(context.paths.instanceDirectory(context.binding.id), "runtime-lifecycle.jsonl"),
      ),
      sendText: (channelId, messageId, text, dispatch) =>
        adapter.sendText(channelId, messageId, text, dispatch),
      sendFile: (channelId, messageId, file, message, signal, dispatch) =>
        adapter.sendFile(channelId, messageId, file, message, signal, dispatch),
      report: (channelId, messageId, text) => adapter.report(channelId, messageId, text),
      announce: (channelId, text, signal, files) =>
        adapter.announce(channelId, text, signal, files),
      reportOrphanThread: async (threadId) => {
        process.stderr.write(`Unbound Codex thread requires repair: ${threadId}\n`);
      },
      reportRetainedThread: async (threadId) => {
        process.stderr.write(
          `Previous Codex thread retained (busy, background commands, or unsupported cleanup): ${threadId}\n`,
        );
      },
    },
    progress,
  });
  runtimeRef = runtime;
  const fallbackManager = createFallbackAgentManager({
    sharedManager,
    runtime,
    bindingId: context.binding.id,
    ownerUserId: context.bot.ownerUserId,
    requestShutdown: context.requestShutdown,
  });
  const manager =
    options.createManager?.({
      binding: context.binding,
      runtime,
      requestShutdown: context.requestShutdown,
      registry,
    }) ?? fallbackManager;
  adapter = new DiscordGatewayAdapter({
    botName: context.bot.name,
    persistInjected: async (input) => {
      const { deliveryId: _id, ...persisted } = input;
      await deliveryLedger.accept(persisted);
    },
    transport,
    registry,
    runtime,
    manager,
    approval:
      guardian === undefined
        ? approval
        : {
            handleInteraction: (interaction) =>
              guardian.handleInteraction(interaction) || approval.handleInteraction(interaction),
          },
    observation: progress,
    attachmentStore,
    onError: reportError,
    onIngress: createIngressLog(
      join(context.paths.instanceDirectory(context.binding.id), "ingress.jsonl"),
    ),
    ...(guardianConfig?.approvalChannelId === undefined
      ? {}
      : { approvalChannelId: guardianConfig.approvalChannelId }),
  });

  const injectConfig = await loadInjectConfig(
    injectConfigPath(context.paths.instanceDirectory(context.binding.id)),
  );
  const inject =
    injectConfig === undefined
      ? undefined
      : new InjectService({
          botName: context.bot.name,
          guard: new InjectGuard(),
          snapshot: async () => {
            const document = await registry.read();
            const bot = ownValue(document.bots, context.bot.name, "Bot");
            const policy = ownValue(document.access, context.bot.name, "Access policy");
            return { botUserId: bot.botUserId, channelIds: Object.keys(policy.groups) };
          },
          agent: {
            acceptingTurns: () => runtime.acceptingTurns,
            injectTurn: (turn) => adapter.injectTurn(turn),
            interrupt: () => runtime.interrupt(),
          },
          log: transport,
          config: injectConfig,
          onError: reportError,
        });
  let injectServer: InjectSocketServer | undefined;

  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      // Stop accepting inject connections now; in-flight requests finish while the rest
      // shuts down, so inject never makes stop slower.
      const injectClosing = injectServer?.close().catch(reportError);
      approval.cancelAll();
      guardian?.cancelAll();
      adapter.quiesce();
      let primary: unknown;
      try {
        await runtime.stop();
      } catch (error) {
        primary = error;
      }
      try {
        await progress.stop();
      } catch (error) {
        if (primary === undefined) primary = error;
      }
      try {
        await adapter.stop();
      } catch (error) {
        if (primary === undefined) primary = error;
      }
      await injectClosing;
      if (primary !== undefined) throw primary;
    })();
    return stopPromise;
  };
  return {
    start: async () => {
      try {
        await runtime.start();
        await adapter.start(context.token);
        const recovered = await deliveryLedger.recover();
        for (const id of recovered.uncertain)
          reportError(new Error(`Delivery ${id} requires reconciliation; not replayed.`));
        for (const input of recovered.pending) {
          if (
            injectConfig === undefined ||
            (input.announceChannelId !== undefined &&
              input.announceChannelId !== input.channelId &&
              !injectConfig.announceChannelIds?.includes(input.announceChannelId))
          ) {
            reportError(new Error("Recovered delivery blocked by current inject configuration."));
            continue;
          }
          await adapter.restoreInjected({
            channelId: input.channelId,
            messageId: input.messageId,
            authorId: input.authorId,
            text: input.text,
            ...(input.guildId === undefined ? {} : { guildId: input.guildId }),
            ...(input.announceChannelId === undefined
              ? {}
              : { announceChannelId: input.announceChannelId }),
            ...(input.freshThread === undefined ? {} : { freshThread: input.freshThread }),
          });
        }
        if (inject !== undefined) {
          injectServer = await startInjectSocketServer({
            socketPath: injectSocketPath(context.paths, context.binding.id),
            handle: (request) => inject.handle(request),
            onError: reportError,
          });
        }
      } catch (error) {
        await stop().catch(() => undefined);
        throw error;
      }
    },
    stop,
  };
}

export function createProductionRunner(
  instanceId: string,
  paths: ReturnType<typeof import("../config/paths.js").resolveStatePaths>,
): AgentRunner {
  const registry = new RegistryStore({ registryPath: paths.registryPath });
  return new AgentRunner({
    instanceId,
    paths,
    registry: {
      load: async (id) => bindingRecord(await registry.read(), id),
      markState: async (state) => await registry.markObservedState(instanceId, state),
    },
    keychain: createDefaultCredentialStore({ stateRoot: paths.root }),
    createComponent: (context) => createProductionAgentComponent(context),
  });
}
