import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { AppServerClient } from "../../src/app-server/client.js";
import type { ServerRequestParams, ServerRequestResult } from "../../src/app-server/protocol.js";
import type {
  CodexModelCatalogEntry,
  CodexSessionService,
  CodexTurnSettings,
  DiscordTurnSource,
} from "../../src/app-server/session.js";
import { ensureStateDirectories, resolveStatePaths } from "../../src/config/paths.js";
import type { DiscordGatewayTransport, DiscordMessageEvent } from "../../src/discord/adapter.js";
import {
  DiscordAttachmentStore,
  type DiscordAttachmentStorePort,
} from "../../src/discord/attachments.js";
import type {
  AgentBinding,
  AgentModelSettings,
  RegistryDocument,
  WorkspaceProfile,
} from "../../src/domain/schemas.js";
import type { AuthorizedOutboundFile } from "../../src/manager/workspaces.js";
import type {
  AgentRuntimeEvent,
  AgentRuntimeSendFileRequest,
  AgentRuntimeSendFileResult,
  AgentRuntimeSession,
} from "../../src/runtime/agent-runtime.js";
import {
  createFallbackAgentManager,
  createProductionAgentComponent,
  createRuntimeRegistryPort,
  createRuntimeSession,
  type ProductionAgentComponentOptions,
} from "../../src/runtime/production-agent.js";

const BINDING_ID = "11111111-1111-4111-8111-111111111111";
const THREAD_ID = "22222222-2222-4222-8222-222222222222";
const NEXT_THREAD_ID = "33333333-3333-4333-8333-333333333333";
const TURN_ONE = "44444444-4444-4444-8444-444444444441";
const TURN_TWO = "44444444-4444-4444-8444-444444444442";
const INBOX = "/tmp/codex-discord-inbox";

const workspace: WorkspaceProfile = {
  name: "main",
  cwd: "/repo",
  sandbox: "workspace-write",
  approvalPolicy: "on-request",
  runtimeWorkspaceRoots: ["/repo"],
};

const binding: AgentBinding = {
  id: BINDING_ID,
  name: "agent-one",
  botName: "bot-one",
  threadId: THREAD_ID,
  previousThreadIds: [],
  workspace: workspace.name,
  tmuxSession: "codex-discord-agent-one",
  desiredState: "running",
  observedState: "running",
  modelId: "sol-id",
  reasoningEffort: "high",
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
};

function document(currentBinding = binding): RegistryDocument {
  return {
    version: 1,
    bots: {
      "bot-one": {
        name: "bot-one",
        applicationId: "100000000000000001",
        botUserId: "100000000000000002",
        keychainAccount: "bot-one",
        ownerUserId: "100000000000000003",
        ownerConfirmedAt: "2026-07-28T00:00:00.000Z",
        state: "running",
      },
    },
    access: {
      "bot-one": {
        dmPolicy: "allowlist",
        allowFrom: ["100000000000000003"],
        groups: {},
        pendingPairings: {},
        mentionPatterns: [],
        ackReaction: "ok",
        replyToMode: "first",
        textChunkLimit: 2_000,
        chunkMode: "length",
      },
    },
    workspaces: { main: workspace },
    bindings: { [BINDING_ID]: currentBinding },
  };
}

function progressTransportMethods(): Pick<
  DiscordGatewayTransport,
  | "createProgressThread"
  | "editMessage"
  | "setProgressThreadState"
  | "inspectThread"
  | "inspectProgressCapabilities"
> {
  return {
    createProgressThread: vi.fn(async (channelId) => ({
      id: "200000000000000010",
      parentId: channelId,
      ownerId: "100000000000000002",
    })),
    editMessage: vi.fn(async (_channelId, messageId) => ({ id: messageId })),
    setProgressThreadState: vi.fn(async () => undefined),
    inspectThread: vi.fn(async (threadId) => ({ status: "not-found" as const, threadId })),
    inspectProgressCapabilities: vi.fn(async () => ({
      createPublicThreads: true,
      sendMessagesInThreads: true,
      manageThreads: true,
    })),
  };
}

describe("production agent composition", () => {
  it("rejects a symlinked protected attachment staging directory without chmodding its target", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-discord-staging-link-"));
    const external = await mkdtemp(join(tmpdir(), "codex-discord-external-staging-"));
    try {
      const paths = resolveStatePaths(root);
      await ensureStateDirectories(paths);
      await mkdir(paths.instanceDirectory(BINDING_ID), { mode: 0o700, recursive: true });
      await mkdir(paths.instanceInboxDirectory(BINDING_ID), { mode: 0o700, recursive: true });
      await symlink(
        external,
        join(paths.instanceDirectory(BINDING_ID), "attachment-staging"),
        "dir",
      );
      const beforeMode = (await stat(external)).mode & 0o777;
      const current = document();
      const createAttachmentStore = vi.fn();

      await expect(
        createProductionAgentComponent(
          {
            binding,
            bot: current.bots["bot-one"] as NonNullable<(typeof current.bots)["bot-one"]>,
            workspace,
            token: "test-token",
            paths,
            requestShutdown: vi.fn(),
          },
          { createAttachmentStore },
        ),
      ).rejects.toMatchObject({ code: "CONFIGURATION" });

      expect(createAttachmentStore).not.toHaveBeenCalled();
      expect((await stat(external)).mode & 0o777).toBe(beforeMode);
    } finally {
      await Promise.all([
        rm(root, { force: true, recursive: true }),
        rm(external, { force: true, recursive: true }),
      ]);
    }
  });

  it("moves an authorized Discord attachment into the turn and sends a tool file to its source", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-discord-file-flow-"));
    try {
      const paths = resolveStatePaths(root);
      await ensureStateDirectories(paths);
      await mkdir(paths.instanceDirectory(BINDING_ID), { mode: 0o700, recursive: true });
      await mkdir(paths.instanceInboxDirectory(BINDING_ID), { mode: 0o700, recursive: true });
      await writeFile(paths.registryPath, `${JSON.stringify(document())}\n`, { mode: 0o600 });

      const channelOne = "200000000000000001";
      const channelTwo = "200000000000000002";
      const messageOne = "400000000000000001";
      const messageTwo = "400000000000000002";
      const attachmentId = "500000000000000001";
      const fetch = vi.fn(
        async () => new Response("hello", { status: 200, headers: { "content-length": "5" } }),
      );
      let messageHandler: ((event: DiscordMessageEvent) => Promise<void>) | undefined;
      const uploads: Array<{
        channelId: string;
        replyToMessageId?: string;
        file: AuthorizedOutboundFile;
      }> = [];
      const transport: DiscordGatewayTransport = {
        onMessage: vi.fn((handler) => {
          messageHandler = handler;
          return () => {
            messageHandler = undefined;
          };
        }),
        onCommand: vi.fn(() => vi.fn()),
        onButton: vi.fn(() => vi.fn()),
        login: vi.fn(async () => undefined),
        destroy: vi.fn(async () => undefined),
        sendTyping: vi.fn(async () => undefined),
        sendMessage: vi.fn(async () => ({ id: "600000000000000001" })),
        sendFile: vi.fn(async (channelId, payload) => {
          uploads.push({
            channelId,
            file: payload.file,
            ...(payload.replyToMessageId === undefined
              ? {}
              : { replyToMessageId: payload.replyToMessageId }),
          });
          return { id: "600000000000000002" };
        }),
        sendDirectMessage: vi.fn(async () => ({ id: "dm" })),
        ...progressTransportMethods(),
      };
      const listeners = new Map<
        AgentRuntimeEvent["method"],
        Set<(event: AgentRuntimeEvent) => void>
      >();
      let sendFileListener:
        | ((
            request: AgentRuntimeSendFileRequest,
          ) => Promise<AgentRuntimeSendFileResult> | AgentRuntimeSendFileResult)
        | undefined;
      let nextTurn = 0;
      const starts: Array<{ input: string; source: DiscordTurnSource; turnId: string }> = [];
      const returnedFile = {
        canonicalPath: join(root, "returned.txt"),
        displayFilename: "returned.txt",
        size: 5,
        isClosed: false,
        createReadStream: () => Readable.from(["hello"]),
        close: vi.fn(async () => undefined),
        async [Symbol.asyncDispose]() {
          await this.close();
        },
      } satisfies AuthorizedOutboundFile;
      const session: AgentRuntimeSession = {
        listModels: vi.fn(async () => [
          {
            id: "sol-id",
            model: "gpt-5.6-sol",
            displayName: "Sol",
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: "high",
            supportedReasoningEfforts: ["high"],
          },
        ]),
        resume: vi.fn(async () => undefined),
        startTurn: vi.fn(async (_threadId, turnInput, source) => {
          nextTurn += 1;
          const turnId = nextTurn === 1 ? TURN_ONE : TURN_TWO;
          starts.push({ input: turnInput, source, turnId });
          return { turnId };
        }),
        interrupt: vi.fn(async () => undefined),
        onNotification: (method, listener) => {
          const registered = listeners.get(method) ?? new Set();
          registered.add(listener);
          listeners.set(method, registered);
          return () => registered.delete(listener);
        },
        onSendFileRequest: (listener) => {
          sendFileListener = listener;
          return () => {
            if (sendFileListener === listener) sendFileListener = undefined;
          };
        },
        authorizeSendFile: vi.fn(async () => ({ file: returnedFile })),
      };
      const emit = (event: AgentRuntimeEvent): void => {
        listeners.get(event.method)?.forEach((listener) => {
          listener(event);
        });
      };
      const appServer = {
        start: vi.fn(async () => session),
        stop: vi.fn(async () => undefined),
      };
      const current = document();
      const component = await createProductionAgentComponent(
        {
          binding,
          bot: current.bots["bot-one"] as NonNullable<(typeof current.bots)["bot-one"]>,
          workspace,
          token: "test-token",
          paths,
          requestShutdown: vi.fn(),
        },
        {
          createTransport: () => transport,
          createAttachmentStore: (options) => new DiscordAttachmentStore({ ...options, fetch }),
          createAppServer: () => appServer,
          createManager: () => ({
            status: vi.fn(async () => ({})),
            spawn: vi.fn(async () => ({})),
            stop: vi.fn(async () => ({})),
            restart: vi.fn(async () => ({})),
          }),
        },
      );
      await component.start();
      if (messageHandler === undefined) throw new Error("message handler was not installed");

      const firstTurn = messageHandler({
        id: messageOne,
        channelId: channelOne,
        location: "dm",
        authorId: "100000000000000003",
        authorIsBot: false,
        authorIsSystem: false,
        content: "",
        mentionsBot: false,
        attachments: [
          {
            id: attachmentId,
            filename: "notes.txt",
            size: 5,
            contentType: "text/plain",
            url: `https://cdn.discordapp.com/attachments/${channelOne}/${attachmentId}/notes.txt`,
          },
        ],
      });
      await vi.waitFor(() => expect(starts).toHaveLength(1));
      expect(starts[0]?.input).toContain("UNTRUSTED DISCORD ATTACHMENTS");
      expect(starts[0]?.input).toContain(paths.instanceInboxDirectory(BINDING_ID));
      expect(fetch).toHaveBeenCalledOnce();
      emit({ method: "turn/completed", threadId: THREAD_ID, turnId: TURN_ONE });
      await firstTurn;

      await messageHandler({
        id: "400000000000000099",
        channelId: channelOne,
        location: "dm",
        authorId: "100000000000000099",
        authorIsBot: false,
        authorIsSystem: false,
        content: "unauthorized",
        mentionsBot: false,
        attachments: [
          {
            id: "500000000000000099",
            filename: "denied.txt",
            size: 5,
            url: `https://cdn.discordapp.com/attachments/${channelOne}/500000000000000099/denied.txt`,
          },
        ],
      });
      expect(fetch).toHaveBeenCalledOnce();

      const secondTurn = messageHandler({
        id: messageTwo,
        channelId: channelTwo,
        location: "dm",
        authorId: "100000000000000003",
        authorIsBot: false,
        authorIsSystem: false,
        content: "return the file",
        mentionsBot: false,
        attachments: [],
      });
      await vi.waitFor(() => expect(starts).toHaveLength(2));
      await Promise.resolve();
      if (sendFileListener === undefined) throw new Error("file listener was not installed");
      await expect(
        sendFileListener({
          arguments: { path: returnedFile.canonicalPath },
          callId: "call-one",
          threadId: THREAD_ID,
          turnId: TURN_TWO,
        }),
      ).resolves.toMatchObject({ success: true });
      expect(uploads).toEqual([
        { channelId: channelTwo, replyToMessageId: messageTwo, file: returnedFile },
      ]);
      emit({ method: "turn/completed", threadId: THREAD_ID, turnId: TURN_TWO });
      await secondTurn;
      expect(returnedFile.close).toHaveBeenCalledOnce();
      await component.stop();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("constructs the binding attachment store and stops ingress before runtime teardown", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-discord-production-agent-"));
    try {
      const paths = resolveStatePaths(root);
      await ensureStateDirectories(paths);
      await mkdir(paths.instanceDirectory(BINDING_ID), { mode: 0o700, recursive: true });
      await mkdir(paths.instanceInboxDirectory(BINDING_ID), { mode: 0o700, recursive: true });
      await writeFile(paths.registryPath, `${JSON.stringify(document())}\n`, { mode: 0o600 });

      const lifecycle: string[] = [];
      const attachmentStore: DiscordAttachmentStorePort = {
        initialize: vi.fn(async () => {
          lifecycle.push("store-initialize");
        }),
        persist: vi.fn(async () => []),
        stop: vi.fn(async () => {
          lifecycle.push("store-stop");
        }),
      };
      const transport: DiscordGatewayTransport = {
        onMessage: vi.fn(() => {
          lifecycle.push("listeners-installed");
          return vi.fn();
        }),
        onCommand: vi.fn(() => vi.fn()),
        onButton: vi.fn(() => vi.fn()),
        login: vi.fn(async () => {
          lifecycle.push("discord-login");
        }),
        destroy: vi.fn(async () => {
          lifecycle.push("discord-destroy");
        }),
        sendTyping: vi.fn(async () => undefined),
        sendMessage: vi.fn(async () => ({ id: "message" })),
        sendFile: vi.fn(async () => ({ id: "file" })),
        sendDirectMessage: vi.fn(async () => ({ id: "dm" })),
        ...progressTransportMethods(),
      };
      const resumedRoots: string[][] = [];
      const session: AgentRuntimeSession = {
        listModels: vi.fn(async () => [
          {
            id: "sol-id",
            model: "gpt-5.6-sol",
            displayName: "Sol",
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: "high",
            supportedReasoningEfforts: ["high"],
          },
        ]),
        resume: vi.fn(async (_threadId, profile) => {
          resumedRoots.push([...profile.runtimeWorkspaceRoots]);
        }),
        startTurn: vi.fn(async () => ({ turnId: "turn" })),
        interrupt: vi.fn(async () => undefined),
        onNotification: vi.fn(() => vi.fn()),
        onSendFileRequest: vi.fn(() => vi.fn()),
        authorizeSendFile: vi.fn(async () => {
          throw new Error("unused");
        }),
      };
      const appServer = {
        start: vi.fn(async () => {
          lifecycle.push("server-start");
          return session;
        }),
        stop: vi.fn(async () => {
          lifecycle.push("server-stop");
        }),
      };
      const createTransport = vi.fn(() => transport);
      const createAttachmentStore = vi.fn(() => attachmentStore);
      const createAppServer = vi.fn(() => appServer);
      const progressJournal = { kind: "progress-journal" };
      const progressController = {
        initializeAfterLogin: vi.fn(async () => {
          lifecycle.push("progress-initialize");
        }),
        begin: vi.fn(async () => ({
          durable: true,
          kind: "thread" as const,
          reused: false,
        })),
        preparing: vi.fn(async () => undefined),
        queued: vi.fn(async () => undefined),
        running: vi.fn(async () => undefined),
        bindTurn: vi.fn(async () => undefined),
        event: vi.fn(async () => undefined),
        decorateFinalText: vi.fn((_source, text: string) => text),
        deliver: vi.fn(async (_source, operation) => operation({})),
        terminal: vi.fn(async () => undefined),
        isProgressOnlyThread: vi.fn(async () => false),
        redirectProgressThreadInput: vi.fn(async () => undefined),
        quiesce: vi.fn(async () => undefined),
        stop: vi.fn(async () => {
          lifecycle.push("progress-stop");
        }),
      };
      const createProgressJournal = vi.fn(() => progressJournal);
      const createProgressController = vi.fn(() => progressController);
      const current = document();
      const componentOptions = {
        createTransport,
        createAttachmentStore,
        createAppServer,
        createProgressJournal,
        createProgressController,
        createManager: () => ({
          status: vi.fn(async () => ({})),
          spawn: vi.fn(async () => ({})),
          stop: vi.fn(async () => ({})),
          restart: vi.fn(async () => ({})),
        }),
      } as unknown as ProductionAgentComponentOptions;
      const component = await createProductionAgentComponent(
        {
          binding,
          bot: current.bots["bot-one"] as NonNullable<(typeof current.bots)["bot-one"]>,
          workspace,
          token: "test-token",
          paths,
          requestShutdown: vi.fn(),
        },
        componentOptions,
      );

      expect(createTransport).toHaveBeenCalledOnce();
      expect(createAttachmentStore).toHaveBeenCalledExactlyOnceWith({
        inboxDirectory: paths.instanceInboxDirectory(BINDING_ID),
        stagingDirectory: join(paths.instanceDirectory(BINDING_ID), "attachment-staging"),
      });
      expect(createAppServer).toHaveBeenCalledOnce();
      expect(createProgressJournal).toHaveBeenCalledExactlyOnceWith({
        filePath: join(paths.instanceDirectory(BINDING_ID), "progress-observations.json"),
      });
      expect(createProgressController).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          botUserId: "100000000000000002",
          journal: progressJournal,
          transport,
        }),
      );

      await component.start();
      expect(lifecycle.indexOf("store-initialize")).toBeLessThan(
        lifecycle.indexOf("discord-login"),
      );
      expect(resumedRoots.flat()).not.toContain(
        join(paths.instanceDirectory(BINDING_ID), "attachment-staging"),
      );

      await component.stop();
      expect(lifecycle).toEqual([
        "server-start",
        "store-initialize",
        "discord-login",
        "progress-initialize",
        "listeners-installed",
        "store-stop",
        "server-stop",
        "progress-stop",
        "discord-destroy",
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("unwinds the constructed Discord resources when runtime startup fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-discord-runtime-start-failure-"));
    try {
      const paths = resolveStatePaths(root);
      await ensureStateDirectories(paths);
      await mkdir(paths.instanceDirectory(BINDING_ID), { mode: 0o700, recursive: true });
      await mkdir(paths.instanceInboxDirectory(BINDING_ID), { mode: 0o700, recursive: true });
      await writeFile(paths.registryPath, `${JSON.stringify(document())}\n`, { mode: 0o600 });
      const attachmentStore: DiscordAttachmentStorePort = {
        initialize: vi.fn(async () => undefined),
        persist: vi.fn(async () => []),
        stop: vi.fn(async () => undefined),
      };
      const transport: DiscordGatewayTransport = {
        onMessage: vi.fn(() => vi.fn()),
        onCommand: vi.fn(() => vi.fn()),
        onButton: vi.fn(() => vi.fn()),
        login: vi.fn(async () => undefined),
        destroy: vi.fn(async () => undefined),
        sendTyping: vi.fn(async () => undefined),
        sendMessage: vi.fn(async () => ({ id: "message" })),
        sendFile: vi.fn(async () => ({ id: "file" })),
        sendDirectMessage: vi.fn(async () => ({ id: "dm" })),
        ...progressTransportMethods(),
      };
      const current = document();
      const component = await createProductionAgentComponent(
        {
          binding,
          bot: current.bots["bot-one"] as NonNullable<(typeof current.bots)["bot-one"]>,
          workspace,
          token: "test-token",
          paths,
          requestShutdown: vi.fn(),
        },
        {
          createTransport: () => transport,
          createAttachmentStore: () => attachmentStore,
          createAppServer: () => ({
            start: vi.fn(async () => {
              throw new Error("App Server start failed");
            }),
            stop: vi.fn(async () => undefined),
          }),
          createManager: () => ({
            status: vi.fn(async () => ({})),
            spawn: vi.fn(async () => ({})),
            stop: vi.fn(async () => ({})),
            restart: vi.fn(async () => ({})),
          }),
        },
      );

      await expect(component.start()).rejects.toThrow("Agent runtime startup failed");

      expect(attachmentStore.initialize).not.toHaveBeenCalled();
      expect(attachmentStore.stop).toHaveBeenCalledOnce();
      expect(transport.login).not.toHaveBeenCalled();
      expect(transport.destroy).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("routes only discord_send_file requests through one removable runtime listener", async () => {
    type DynamicHandler = (
      params: ServerRequestParams<"item/tool/call">,
    ) => Promise<ServerRequestResult<"item/tool/call">> | ServerRequestResult<"item/tool/call">;

    let handler: DynamicHandler | undefined;
    const removeHandler = vi.fn();
    const client = {
      onNotification: vi.fn(),
      handleRequest: vi.fn((_method: "item/tool/call", next: DynamicHandler) => {
        handler = next;
        return removeHandler;
      }),
    } as unknown as AppServerClient;
    const authorized = { file: {} as never };
    const authorizeSendFile = vi.fn(async () => authorized);
    const parseFileMarkers = vi.fn(async () => ({ visibleText: "", files: [] }));
    const session = {
      listModels: vi.fn(async () => []),
      startTurn: vi.fn(async () => ({ turnId: "turn-one" })),
      resume: vi.fn(async () => undefined),
      interrupt: vi.fn(async () => undefined),
      start: vi.fn(async () => ({ threadId: THREAD_ID })),
      authorizeSendFile,
      parseFileMarkers,
    } as unknown as CodexSessionService;

    const runtimeSession = createRuntimeSession(client, session);
    expect(client.handleRequest).toHaveBeenCalledOnce();
    const invoke = (params: ServerRequestParams<"item/tool/call">) => {
      if (handler === undefined) throw new Error("dynamic handler was not installed");
      return handler(params);
    };
    const request: ServerRequestParams<"item/tool/call"> = {
      arguments: { path: "/repo/result.txt" },
      callId: "call-one",
      threadId: THREAD_ID,
      tool: "discord_send_file",
      turnId: "turn-one",
    };
    const failed = {
      success: false,
      contentItems: [{ type: "inputText" as const, text: "File could not be sent." }],
    };

    await expect(runtimeSession.authorizeSendFile(THREAD_ID, request.arguments)).resolves.toBe(
      authorized,
    );
    await expect(
      runtimeSession.parseFileMarkers?.(THREAD_ID, "marker", {} as never),
    ).resolves.toEqual({ visibleText: "", files: [] });
    expect(authorizeSendFile).toHaveBeenCalledExactlyOnceWith(THREAD_ID, request.arguments);
    expect(parseFileMarkers).toHaveBeenCalledExactlyOnceWith(THREAD_ID, "marker");

    await expect(invoke({ ...request, tool: "unknown" })).resolves.toEqual(failed);
    await expect(invoke(request)).resolves.toEqual(failed);

    const listener = vi.fn(async () => ({
      success: true,
      contentItems: [{ type: "inputText" as const, text: "File sent." }],
    }));
    const unsubscribe = runtimeSession.onSendFileRequest(listener);
    await expect(invoke(request)).resolves.toMatchObject({ success: true });
    expect(listener).toHaveBeenCalledExactlyOnceWith({
      arguments: request.arguments,
      callId: request.callId,
      threadId: request.threadId,
      turnId: request.turnId,
    });

    unsubscribe();
    await expect(invoke(request)).resolves.toEqual(failed);
    expect(authorizeSendFile).toHaveBeenCalledOnce();
    runtimeSession.dispose?.();
    expect(removeHandler).toHaveBeenCalledOnce();
  });

  it("forwards model catalog loading and concrete turn settings to CodexSessionService", async () => {
    const catalog: readonly CodexModelCatalogEntry[] = [
      {
        id: "sol-id",
        model: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol",
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["medium", "high"],
      },
    ];
    const listModels = vi.fn(async () => catalog);
    const startTurn = vi.fn(async () => ({ turnId: "turn-one" }));
    const session = {
      listModels,
      startTurn,
      resume: vi.fn(async () => undefined),
      interrupt: vi.fn(async () => undefined),
      start: vi.fn(async () => ({ threadId: THREAD_ID })),
    } as unknown as CodexSessionService;
    const client = {
      onNotification: vi.fn(),
      handleRequest: vi.fn(() => vi.fn()),
    } as unknown as AppServerClient;
    const source: DiscordTurnSource = {
      channelId: "200000000000000001",
      messageId: "300000000000000001",
      authorId: "100000000000000003",
    };
    const settings: CodexTurnSettings = { model: "gpt-5.6-sol", effort: "high" };

    const runtimeSession = createRuntimeSession(client, session);

    await expect(runtimeSession.listModels()).resolves.toBe(catalog);
    await runtimeSession.startTurn(THREAD_ID, "hello", source, settings);

    expect(listModels).toHaveBeenCalledOnce();
    expect(startTurn).toHaveBeenCalledExactlyOnceWith(THREAD_ID, "hello", source, settings);
  });

  it("projects App Server progress notifications through runtime subscriptions", () => {
    const handlers = new Map<string, (params: never) => void>();
    const client = {
      onNotification: vi.fn((method: string, listener: (params: never) => void) => {
        handlers.set(method, listener);
        return vi.fn();
      }),
      handleRequest: vi.fn(() => vi.fn()),
    } as unknown as AppServerClient;
    const session = {
      listModels: vi.fn(async () => []),
      startTurn: vi.fn(async () => ({ turnId: "turn-one" })),
      resume: vi.fn(async () => undefined),
      interrupt: vi.fn(async () => undefined),
      start: vi.fn(async () => ({ threadId: THREAD_ID })),
    } as unknown as CodexSessionService;
    const runtimeSession = createRuntimeSession(client, session);
    const listener = vi.fn();

    runtimeSession.onNotification("turn/plan/updated", listener);
    handlers.get("turn/plan/updated")?.({
      threadId: THREAD_ID,
      turnId: "turn-one",
      explanation: null,
      plan: [{ step: "Run tests", status: "inProgress" }],
    } as never);

    expect(listener).toHaveBeenCalledExactlyOnceWith({
      method: "turn/plan/updated",
      threadId: THREAD_ID,
      turnId: "turn-one",
      progress: {
        type: "plan",
        steps: [{ step: "Run tests", status: "inProgress" }],
      },
    });
  });

  it("maps and persists binding model settings across thread replacement", async () => {
    let current = document();
    const registry = {
      read: vi.fn(async () => structuredClone(current)),
      markObservedState: vi.fn(async () => binding),
      replaceThread: vi.fn(async (_bindingId: string, threadId: string) => {
        const previous = current.bindings[BINDING_ID] as AgentBinding;
        const next = {
          ...previous,
          threadId,
          previousThreadIds: [...previous.previousThreadIds, previous.threadId],
        };
        current = document(next);
        return next;
      }),
      updateModelSettings: vi.fn(async (_bindingId: string, settings: AgentModelSettings) => {
        const previous = current.bindings[BINDING_ID] as AgentBinding;
        const { modelId: _modelId, reasoningEffort: _reasoningEffort, ...unchanged } = previous;
        const next = { ...unchanged, ...settings };
        current = document(next);
        return next;
      }),
    };
    const port = createRuntimeRegistryPort(registry, BINDING_ID, INBOX);

    await expect(port.readBinding()).resolves.toMatchObject({
      modelId: "sol-id",
      reasoningEffort: "high",
    });

    await expect(
      port.updateModelSettings(BINDING_ID, {
        modelId: "mini-id",
        reasoningEffort: "low",
      }),
    ).resolves.toMatchObject({ modelId: "mini-id", reasoningEffort: "low" });
    await expect(port.replaceThread(BINDING_ID, NEXT_THREAD_ID)).resolves.toMatchObject({
      threadId: NEXT_THREAD_ID,
      modelId: "mini-id",
      reasoningEffort: "low",
    });

    expect(registry.updateModelSettings).toHaveBeenCalledExactlyOnceWith(BINDING_ID, {
      modelId: "mini-id",
      reasoningEffort: "low",
    });
  });

  it("returns the committed model settings without a fallible post-commit read", async () => {
    let committed = false;
    const updated = { ...binding, modelId: "mini-id", reasoningEffort: "low" };
    const registry = {
      read: vi.fn(async () => {
        if (committed) throw new Error("post-commit read failed");
        return document();
      }),
      markObservedState: vi.fn(async () => binding),
      replaceThread: vi.fn(async () => binding),
      updateModelSettings: vi.fn(async () => {
        committed = true;
        return updated;
      }),
    };
    const port = createRuntimeRegistryPort(registry, BINDING_ID, INBOX);

    await expect(
      port.updateModelSettings(BINDING_ID, {
        modelId: "mini-id",
        reasoningEffort: "low",
      }),
    ).resolves.toMatchObject({ modelId: "mini-id", reasoningEffort: "low" });

    expect(registry.read).toHaveBeenCalledOnce();
    expect(registry.updateModelSettings).toHaveBeenCalledOnce();
  });

  it("includes configuration-safe model status in fallback manager status", async () => {
    const sharedManager = {
      status: vi.fn(async () => ({ observedState: "running" })),
      spawnForOwner: vi.fn(async () => binding),
    };
    const runtime = {
      state: "running" as const,
      queue: { depth: vi.fn(() => 2) },
      modelStatus: vi.fn(() => ({
        configuredModelId: "retired-id",
        configurationError: "The configured Codex model is no longer available.",
      })),
    };
    const manager = createFallbackAgentManager({
      sharedManager,
      runtime,
      bindingId: BINDING_ID,
      ownerUserId: "100000000000000003",
      requestShutdown: vi.fn(),
    });

    await expect(manager.status()).resolves.toEqual({
      persisted: { observedState: "running" },
      runtimeState: "running",
      queueDepth: 2,
      model: {
        configuredModelId: "retired-id",
        configurationError: "The configured Codex model is no longer available.",
      },
    });
  });
});
