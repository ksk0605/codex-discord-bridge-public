import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { ChannelType, type Client, Collection, Events, PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
  type DiscordCommandEvent,
  DiscordGatewayAdapter,
  type DiscordGatewayTransport,
  DiscordJsGatewayTransport,
  type DiscordMessageEvent,
  type DiscordObservationIngress,
} from "../../src/discord/adapter.js";
import type {
  DiscordAttachmentBatchInput,
  DiscordAttachmentStorePort,
  DiscordMessageAttachment,
} from "../../src/discord/attachments.js";
import type { LocalDiscordAttachment } from "../../src/discord/format.js";
import { BridgeError } from "../../src/domain/errors.js";
import type {
  AccessPolicy,
  BotCredentialMetadata,
  RegistryDocument,
} from "../../src/domain/schemas.js";
import type { AuthorizedOutboundFile } from "../../src/manager/workspaces.js";
import type { ApprovalInteraction } from "../../src/runtime/approval-router.js";
import type { ModelSettingsStatus, ModelSummary } from "../../src/runtime/model-settings.js";
import type { TurnInput } from "../../src/runtime/turn-queue.js";

const OWNER = "100000000000000001";
const USER = "100000000000000002";
const BOT = "100000000000000003";
const DM = "200000000000000001";
const GUILD = "300000000000000001";
const CHANNEL = "200000000000000002";
const MESSAGE = "400000000000000001";
const PROGRESS_MESSAGE = "400000000000000003";
const CATEGORY = "200000000000000003";
const THREAD = "200000000000000004";
const ATTACHMENT = "400000000000000002";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function incomingAttachment(
  overrides: Partial<DiscordMessageAttachment> = {},
): DiscordMessageAttachment {
  return {
    id: ATTACHMENT,
    filename: "report.txt",
    size: 5,
    contentType: "text/plain",
    url: `https://cdn.discordapp.com/attachments/${DM}/${ATTACHMENT}/report.txt`,
    ...overrides,
  };
}

function localAttachment(overrides: Partial<LocalDiscordAttachment> = {}): LocalDiscordAttachment {
  return {
    id: ATTACHMENT,
    filename: "report.txt",
    size: 5,
    contentType: "text/plain",
    localPath: `/tmp/inbox/${MESSAGE}/${ATTACHMENT}-report.txt`,
    ...overrides,
  };
}

function bot(overrides: Partial<BotCredentialMetadata> = {}): BotCredentialMetadata {
  return {
    name: "bot-one",
    applicationId: "500000000000000001",
    botUserId: BOT,
    keychainAccount: "bot-one",
    ownerUserId: OWNER,
    ownerConfirmedAt: "2026-07-28T00:00:00.000Z",
    state: "running",
    ...overrides,
  };
}

function policy(overrides: Partial<AccessPolicy> = {}): AccessPolicy {
  return {
    dmPolicy: "allowlist",
    allowFrom: [OWNER, USER],
    groups: { [CHANNEL]: { requireMention: false, allowFrom: [] } },
    pendingPairings: {},
    mentionPatterns: [],
    ackReaction: "ok",
    replyToMode: "first",
    textChunkLimit: 2_000,
    chunkMode: "length",
    ...overrides,
  };
}

function document(access = policy(), credential = bot()): RegistryDocument {
  return {
    version: 1,
    bots: { "bot-one": credential },
    access: { "bot-one": access },
    workspaces: {},
    bindings: {},
  };
}

function message(overrides: Partial<DiscordMessageEvent> = {}): DiscordMessageEvent {
  return {
    id: MESSAGE,
    channelId: DM,
    location: "dm",
    authorId: USER,
    authorIsBot: false,
    authorIsSystem: false,
    content: "hello",
    mentionsBot: false,
    attachments: [],
    ...overrides,
  };
}

function modelStatus(
  overrides: Partial<NonNullable<ModelSettingsStatus["effective"]>> = {},
): ModelSettingsStatus {
  return {
    effective: {
      modelId: "sol-id",
      requestModel: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      hidden: false,
      modelSource: "catalog",
      reasoningEffort: "medium",
      reasoningSource: "model-default",
      supportedReasoningEfforts: ["low", "medium", "high"],
      ...overrides,
    },
  };
}

function modelSummaries(): readonly ModelSummary[] {
  return [
    {
      id: "sol-id",
      displayName: "GPT-5.6 Sol",
      isDefault: true,
      isCurrent: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: ["low", "medium", "high"],
    },
    {
      id: "mini-id",
      displayName: "GPT-5.6 Mini",
      isDefault: false,
      isCurrent: false,
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: ["low", "high"],
    },
  ];
}

class FakeTransport implements DiscordGatewayTransport {
  messageHandler: ((event: DiscordMessageEvent) => Promise<void>) | undefined;
  commandHandler: Parameters<DiscordGatewayTransport["onCommand"]>[0] | undefined;
  buttonHandler: Parameters<DiscordGatewayTransport["onButton"]>[0] | undefined;
  readonly sent: Array<{
    channelId: string;
    content: string;
    replyToMessageId?: string;
  }> = [];
  readonly direct: Array<{
    userId: string;
    content: string;
    buttons?: readonly { customId: string }[];
  }> = [];
  readonly typing: string[] = [];
  readonly files: Array<{
    channelId: string;
    file: AuthorizedOutboundFile;
    content?: string;
    replyToMessageId?: string;
    signal: AbortSignal;
  }> = [];
  loginToken: string | undefined;
  stopped = false;
  destroyCount = 0;

  onMessage(handler: (event: DiscordMessageEvent) => Promise<void>): () => void {
    this.messageHandler = handler;
    return () => {
      this.messageHandler = undefined;
    };
  }

  onCommand(handler: Parameters<DiscordGatewayTransport["onCommand"]>[0]): () => void {
    this.commandHandler = handler;
    return () => {
      this.commandHandler = undefined;
    };
  }

  onButton(handler: Parameters<DiscordGatewayTransport["onButton"]>[0]): () => void {
    this.buttonHandler = handler;
    return () => {
      this.buttonHandler = undefined;
    };
  }

  async login(token: string): Promise<void> {
    this.loginToken = token;
  }

  async destroy(): Promise<void> {
    this.destroyCount += 1;
    this.stopped = true;
  }

  async sendTyping(channelId: string): Promise<void> {
    this.typing.push(channelId);
  }

  async sendMessage(
    channelId: string,
    payload: { content: string; replyToMessageId?: string },
  ): Promise<{ id: string }> {
    this.sent.push({ channelId, ...payload });
    return { id: String(900000000000000000n + BigInt(this.sent.length)) };
  }

  async sendFile(
    channelId: string,
    payload: {
      file: AuthorizedOutboundFile;
      content?: string;
      replyToMessageId?: string;
      signal: AbortSignal;
    },
  ): Promise<{ id: string }> {
    this.files.push({ channelId, ...payload });
    return { id: String(910000000000000000n + BigInt(this.files.length)) };
  }

  async sendDirectMessage(
    userId: string,
    payload: { content: string; buttons?: readonly { customId: string }[] },
  ): Promise<{ id: string }> {
    this.direct.push({ userId, ...payload });
    return { id: "900000000000000099" };
  }

  async createProgressThread(
    channelId: string,
    _sourceMessageId: string,
  ): Promise<{ id: string; parentId: string; ownerId: string }> {
    return { id: THREAD, parentId: channelId, ownerId: BOT };
  }

  async editMessage(
    _channelId: string,
    messageId: string,
    _payload: { content: string },
  ): Promise<{ id: string }> {
    return { id: messageId };
  }

  async setProgressThreadState(): Promise<void> {}

  async inspectThread(threadId: string): Promise<{ status: "not-found"; threadId: string }> {
    return { status: "not-found", threadId };
  }

  async inspectProgressCapabilities(): Promise<{
    createPublicThreads: boolean;
    sendMessagesInThreads: boolean;
    manageThreads: boolean;
  }> {
    return {
      createPublicThreads: true,
      sendMessagesInThreads: true,
      manageThreads: true,
    };
  }
}

function authorizedFile(
  stream: Readable = Readable.from(["hello"]),
): AuthorizedOutboundFile & { close: ReturnType<typeof vi.fn> } {
  return {
    canonicalPath: "/private/project/secret-report.txt",
    displayFilename: "report.txt",
    size: 5,
    isClosed: false,
    createReadStream: vi.fn(() => stream),
    close: vi.fn(async () => undefined),
    async [Symbol.asyncDispose]() {
      await this.close();
    },
  };
}

function fixture(
  initial = document(),
  attachmentStoreOverride?: Partial<DiscordAttachmentStorePort>,
  observationOverride?: Partial<DiscordObservationIngress>,
) {
  let current = initial;
  const transport = new FakeTransport();
  const turns: TurnInput[] = [];
  const runtime = {
    state: "running",
    queue: { depth: vi.fn(() => 0) },
    enqueue: vi.fn(async (input: TurnInput) => {
      turns.push(input);
    }),
    interrupt: vi.fn(async () => undefined),
    newSession: vi.fn(async () => ({ threadId: "60000000-0000-4000-8000-000000000001" })),
    modelStatus: vi.fn(() => modelStatus()),
    listModels: vi.fn(() => modelSummaries()),
    setModel: vi.fn(async () => modelStatus({ modelSource: "binding" })),
    setReasoningEffort: vi.fn(async () =>
      modelStatus({ reasoningEffort: "high", reasoningSource: "binding" }),
    ),
  };
  const registry = {
    read: vi.fn(async () => structuredClone(current)),
    updateAccess: vi.fn(async (_name: string, _revision: string, next: AccessPolicy) => {
      current = document(next, current.bots["bot-one"] ?? bot());
      return next;
    }),
    confirmOwner: vi.fn(async () => undefined),
  };
  const manager = {
    status: vi.fn(async () => ({ state: "running" })),
    spawn: vi.fn(async () => ({ binding: "new-agent" })),
    stop: vi.fn(async () => ({ state: "stopped" })),
    restart: vi.fn(async () => ({ state: "restarting" })),
  };
  const approval = { handleInteraction: vi.fn((_input: ApprovalInteraction) => true) };
  const attachmentStore = {
    initialize: vi.fn(async () => undefined),
    persist: vi.fn(async (_input: DiscordAttachmentBatchInput) => []),
    stop: vi.fn(async () => undefined),
    ...attachmentStoreOverride,
  };
  const observation: DiscordObservationIngress = {
    begin: vi.fn(async () => ({
      durable: true,
      kind: "inPlace" as const,
      reused: false,
    })),
    isProgressOnlyThread: vi.fn(async () => false),
    preparing: vi.fn(async () => undefined),
    queued: vi.fn(async () => undefined),
    redirectProgressThreadInput: vi.fn(async () => undefined),
    terminal: vi.fn(async () => undefined),
    ...observationOverride,
  };
  const intervals: Array<() => void> = [];
  const cleared: unknown[] = [];
  const adapter = new DiscordGatewayAdapter({
    botName: "bot-one",
    transport,
    registry,
    runtime,
    manager,
    approval,
    attachmentStore,
    observation,
    createPairingCode: () => "PAIR-ONE",
    now: () => Date.parse("2026-07-28T01:00:00.000Z"),
    timers: {
      setInterval: (callback) => {
        intervals.push(callback);
        return callback;
      },
      clearInterval: (handle) => {
        cleared.push(handle);
      },
    },
  });
  return {
    adapter,
    transport,
    runtime,
    registry,
    manager,
    approval,
    attachmentStore,
    observation,
    turns,
    intervals,
    cleared,
    setDocument: (next: RegistryDocument) => {
      current = next;
    },
  };
}

async function runCommand(
  context: ReturnType<typeof fixture>,
  subcommand: string,
  options: Partial<DiscordCommandEvent> = {},
): Promise<{ event: DiscordCommandEvent; responses: string[] }> {
  const responses: string[] = [];
  const event: DiscordCommandEvent = {
    id: "700000000000000001",
    channelId: DM,
    location: "dm",
    userId: OWNER,
    subcommand,
    acknowledge: vi.fn(async () => undefined),
    respond: vi.fn(async (text: string) => {
      responses.push(text);
    }),
    ...options,
  };
  await context.adapter.handleCommand(event);
  return { event, responses };
}

describe("DiscordGatewayAdapter", () => {
  it("logs in, registers listeners, and destroys the Gateway transport", async () => {
    const { adapter, attachmentStore, transport } = fixture();

    await adapter.start("discord-token");
    expect(attachmentStore.initialize).toHaveBeenCalledOnce();
    expect(transport.loginToken).toBe("discord-token");
    expect(transport.messageHandler).toBeTypeOf("function");

    await adapter.stop();
    await adapter.stop();
    expect(transport.stopped).toBe(true);
    expect(transport.destroyCount).toBe(1);
    expect(transport.messageHandler).toBeUndefined();
    expect(attachmentStore.stop).toHaveBeenCalledOnce();
  });

  it("initializes progress after login and before installing Gateway listeners", async () => {
    const lifecycle: string[] = [];
    const observationOverride = {
      initializeAfterLogin: vi.fn(async () => {
        lifecycle.push("progress-initialize");
      }),
    } as unknown as Partial<DiscordObservationIngress>;
    const context = fixture(
      undefined,
      {
        initialize: vi.fn(async () => {
          lifecycle.push("attachments-initialize");
        }),
      },
      observationOverride,
    );
    context.transport.login = vi.fn(async () => {
      lifecycle.push("discord-login");
    });
    context.transport.onMessage = vi.fn((handler) => {
      lifecycle.push("listeners-installed");
      context.transport.messageHandler = handler;
      return () => {
        context.transport.messageHandler = undefined;
      };
    });

    await context.adapter.start("discord-token");

    expect(lifecycle).toEqual([
      "attachments-initialize",
      "discord-login",
      "progress-initialize",
      "listeners-installed",
    ]);
  });

  it("fails progress initialization before opening Gateway input", async () => {
    const context = fixture(undefined, undefined, {
      initializeAfterLogin: vi.fn(async () => {
        throw new BridgeError("RUNTIME", "progress journal corrupt");
      }),
    });

    await expect(context.adapter.start("discord-token")).rejects.toThrow(
      "progress journal corrupt",
    );

    expect(context.transport.loginToken).toBe("discord-token");
    expect(context.transport.messageHandler).toBeUndefined();
    expect(context.transport.commandHandler).toBeUndefined();
    expect(context.transport.buttonHandler).toBeUndefined();
    await context.adapter.stop();
    expect(context.transport.destroyCount).toBe(1);
  });

  it("does not install listeners or log in when stop races attachment initialization", async () => {
    const initialization = deferred<void>();
    const context = fixture(undefined, {
      initialize: vi.fn(async () => initialization.promise),
    });
    const starting = context.adapter.start("discord-token");
    await vi.waitFor(() => expect(context.attachmentStore.initialize).toHaveBeenCalledOnce());

    const stopping = context.adapter.stop();
    initialization.resolve();

    await expect(starting).rejects.toMatchObject({ code: "CONFLICT" });
    await stopping;
    expect(context.transport.loginToken).toBeUndefined();
    expect(context.transport.messageHandler).toBeUndefined();
    expect(context.attachmentStore.stop).toHaveBeenCalledOnce();
    expect(context.transport.destroyCount).toBe(1);
  });

  it("waits for an in-progress login before destroying the transport", async () => {
    const loginStarted = deferred<void>();
    const releaseLogin = deferred<void>();
    const lifecycle: string[] = [];
    const context = fixture();
    context.transport.login = vi.fn(async (token: string) => {
      loginStarted.resolve();
      await releaseLogin.promise;
      context.transport.loginToken = token;
      lifecycle.push("login-complete");
    });
    context.transport.destroy = vi.fn(async () => {
      lifecycle.push("destroy");
      context.transport.destroyCount += 1;
      context.transport.stopped = true;
    });
    const starting = context.adapter.start("discord-token");
    await loginStarted.promise;

    let stopped = false;
    const stopping = context.adapter.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(context.transport.destroyCount).toBe(0);
    releaseLogin.resolve();

    await expect(starting).rejects.toMatchObject({ code: "CONFLICT" });
    await stopping;
    expect(lifecycle).toEqual(["login-complete", "destroy"]);
    expect(context.transport.destroyCount).toBe(1);
  });

  it("ignores automated senders and re-reads access policy for every message", async () => {
    const context = fixture();
    await context.adapter.handleMessage(message({ authorIsBot: true }));
    expect(context.runtime.enqueue).not.toHaveBeenCalled();

    await context.adapter.handleMessage(message());
    expect(context.runtime.enqueue).toHaveBeenCalledOnce();

    context.setDocument(document(policy({ dmPolicy: "disabled", allowFrom: [OWNER] })));
    await context.adapter.handleMessage(message({ id: "400000000000000002" }));
    expect(context.runtime.enqueue).toHaveBeenCalledOnce();
    expect(context.registry.read).toHaveBeenCalledTimes(3);
  });

  it("orders authorization, progress rejection, observation, attachments, enqueue, and completion", async () => {
    const order: string[] = [];
    const attachmentCompletion = deferred<readonly LocalDiscordAttachment[]>();
    const turnCompletion = deferred<void>();
    const context = fixture(
      document(),
      {
        persist: vi.fn(async () => {
          order.push("attachments");
          return attachmentCompletion.promise;
        }),
      },
      {
        isProgressOnlyThread: vi.fn(async () => {
          order.push("progress-check");
          return false;
        }),
        begin: vi.fn(async () => {
          order.push("begin");
          return { durable: true, kind: "thread" as const, reused: false };
        }),
        preparing: vi.fn(async () => {
          order.push("preparing");
        }),
        queued: vi.fn(async () => {
          order.push("queued");
        }),
      },
    );
    context.registry.read.mockImplementation(async () => {
      order.push("access");
      return document();
    });
    context.runtime.enqueue.mockImplementation(() => {
      order.push("enqueue");
      return turnCompletion.promise;
    });

    const handling = context.adapter.handleMessage(
      message({ attachments: [incomingAttachment()] }),
    );
    await vi.waitFor(() =>
      expect(order).toEqual(["access", "progress-check", "begin", "preparing", "attachments"]),
    );
    attachmentCompletion.resolve([localAttachment()]);
    await vi.waitFor(() =>
      expect(order).toEqual([
        "access",
        "progress-check",
        "begin",
        "preparing",
        "attachments",
        "queued",
        "enqueue",
      ]),
    );

    let completed = false;
    void handling.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    turnCompletion.resolve();
    await handling;
    expect(completed).toBe(true);
  });

  it("creates no observation for dropped, pairing, or empty messages", async () => {
    const dropped = fixture();
    await dropped.adapter.handleMessage(message({ authorIsBot: true }));
    await dropped.adapter.handleMessage(message({ authorIsSystem: true }));
    expect(dropped.observation.begin).not.toHaveBeenCalled();
    expect(dropped.observation.isProgressOnlyThread).not.toHaveBeenCalled();

    const pairing = fixture(document(policy({ dmPolicy: "pairing", allowFrom: [OWNER] })));
    await pairing.adapter.handleMessage(message());
    expect(pairing.observation.begin).not.toHaveBeenCalled();

    const unauthorized = fixture(document(policy({ allowFrom: [OWNER], dmPolicy: "disabled" })));
    await unauthorized.adapter.handleMessage(message());
    expect(unauthorized.observation.begin).not.toHaveBeenCalled();

    const empty = fixture();
    await empty.adapter.handleMessage(message({ content: "", attachments: [] }));
    expect(empty.observation.begin).not.toHaveBeenCalled();
  });

  it("drops a journal-redelivered source before attachments or runtime enqueue", async () => {
    const context = fixture(document(), undefined, {
      begin: vi.fn(async () => ({
        durable: true,
        kind: "thread" as const,
        reused: true,
      })),
    });

    await context.adapter.handleMessage(message({ attachments: [incomingAttachment()] }));

    expect(context.observation.preparing).not.toHaveBeenCalled();
    expect(context.attachmentStore.persist).not.toHaveBeenCalled();
    expect(context.runtime.enqueue).not.toHaveBeenCalled();
  });

  it("degrades an observation begin exception without entering the ingress error path", async () => {
    const context = fixture(undefined, undefined, {
      begin: vi.fn(async () => {
        throw new BridgeError("RUNTIME", "progress unavailable");
      }),
    });

    await context.adapter.handleMessage(message());

    expect(context.runtime.enqueue).toHaveBeenCalledOnce();
    expect(context.transport.sent).toEqual([]);
  });

  it("closes one failed observation when attachments or enqueue handoff fail", async () => {
    const attachmentFailure = fixture(document(), {
      persist: vi.fn(async () => {
        throw new BridgeError("RUNTIME", "attachment failed");
      }),
    });
    await attachmentFailure.adapter.handleMessage(message({ attachments: [incomingAttachment()] }));
    expect(attachmentFailure.observation.terminal).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ messageId: MESSAGE }),
      { message: "Discord ingress failed before enqueue.", status: "failed", type: "terminal" },
    );

    const enqueueFailure = fixture();
    enqueueFailure.runtime.enqueue.mockImplementationOnce(() => {
      throw new BridgeError("CONFLICT", "queue full");
    });
    await enqueueFailure.adapter.handleMessage(message());
    expect(enqueueFailure.observation.terminal).toHaveBeenCalledOnce();
    expect(enqueueFailure.observation.queued).toHaveBeenCalledOnce();
  });

  it("closes a prepared observation if adapter quiesce wins before enqueue", async () => {
    const attachments = deferred<readonly LocalDiscordAttachment[]>();
    const context = fixture(document(), {
      persist: vi.fn(async () => attachments.promise),
    });
    await context.adapter.start("token");
    const handling = context.transport.messageHandler?.(
      message({ attachments: [incomingAttachment()] }),
    );
    await vi.waitFor(() => expect(context.attachmentStore.persist).toHaveBeenCalledOnce());

    context.adapter.quiesce();
    attachments.resolve([localAttachment()]);
    await handling;

    expect(context.runtime.enqueue).not.toHaveBeenCalled();
    expect(context.observation.terminal).toHaveBeenCalledOnce();
    await context.adapter.stop();
  });

  it("redirects journal-proven progress threads without attachments or enqueue", async () => {
    const threadAccess = document(
      policy({
        groups: {
          [CATEGORY]: { requireMention: false, allowFrom: [] },
        },
      }),
    );
    const progressThread = fixture(threadAccess, undefined, {
      isProgressOnlyThread: vi.fn(async () => true),
    });
    await progressThread.adapter.handleMessage(
      message({
        channelId: CHANNEL,
        guildId: GUILD,
        location: "thread",
        parentChannelId: CATEGORY,
        threadOwnerId: BOT,
        attachments: [incomingAttachment()],
      }),
    );

    expect(progressThread.observation.redirectProgressThreadInput).toHaveBeenCalledOnce();
    expect(progressThread.observation.begin).not.toHaveBeenCalled();
    expect(progressThread.attachmentStore.persist).not.toHaveBeenCalled();
    expect(progressThread.runtime.enqueue).not.toHaveBeenCalled();

    const ordinaryThread = fixture(threadAccess, undefined, {
      isProgressOnlyThread: vi.fn(async () => false),
    });
    await ordinaryThread.adapter.handleMessage(
      message({
        channelId: CHANNEL,
        guildId: GUILD,
        location: "thread",
        parentChannelId: CATEGORY,
        threadOwnerId: BOT,
      }),
    );
    expect(ordinaryThread.observation.begin).toHaveBeenCalledOnce();
    expect(ordinaryThread.runtime.enqueue).toHaveBeenCalledOnce();
  });

  it("queues exact Discord source IDs and always clears the typing interval", async () => {
    const context = fixture(
      document(
        policy({
          groups: {
            "200000000000000003": { requireMention: false, allowFrom: [] },
          },
        }),
      ),
    );
    context.runtime.enqueue.mockRejectedValueOnce(new Error("turn failed"));

    await context.adapter.handleMessage(
      message({
        id: "400000000000000004",
        channelId: CHANNEL,
        guildId: GUILD,
        parentChannelId: "200000000000000003",
        location: "thread",
        authorId: OWNER,
        content: "do the work",
      }),
    );

    expect(context.runtime.enqueue).toHaveBeenCalledWith({
      channelId: CHANNEL,
      messageId: "400000000000000004",
      authorId: OWNER,
      guildId: GUILD,
      parentChannelId: "200000000000000003",
      text: "do the work",
    });
    expect(context.transport.typing).toEqual([CHANNEL]);
    expect(context.cleared).toHaveLength(1);
    expect(context.transport.sent.at(-1)?.content).toContain("요청을 처리하지 못했습니다");
  });

  it("downloads authorized attachments and accepts attachment-only messages", async () => {
    const stored = [localAttachment()];
    const context = fixture(document(), {
      persist: vi.fn(async () => stored),
    });

    await context.adapter.handleMessage(
      message({ content: "", attachments: [incomingAttachment()] }),
    );

    expect(context.attachmentStore.persist).toHaveBeenCalledExactlyOnceWith({
      channelId: DM,
      messageId: MESSAGE,
      attachments: [incomingAttachment()],
    });
    expect(context.runtime.enqueue).toHaveBeenCalledExactlyOnceWith({
      channelId: DM,
      messageId: MESSAGE,
      authorId: USER,
      text: "",
      attachments: stored,
    });
  });

  it("never downloads attachments for dropped or pairing messages", async () => {
    const dropped = fixture();
    await dropped.adapter.handleMessage(
      message({ authorIsBot: true, attachments: [incomingAttachment()] }),
    );
    expect(dropped.attachmentStore.persist).not.toHaveBeenCalled();

    const pairing = fixture(document(policy({ dmPolicy: "pairing", allowFrom: [OWNER] })));
    await pairing.adapter.handleMessage(message({ attachments: [incomingAttachment()] }));
    expect(pairing.attachmentStore.persist).not.toHaveBeenCalled();
    expect(pairing.runtime.enqueue).not.toHaveBeenCalled();
  });

  it("reports attachment persistence failure without enqueueing a partial turn", async () => {
    const context = fixture(document(), {
      persist: vi.fn(async () => {
        throw new BridgeError("RUNTIME", "download failed");
      }),
    });

    await context.adapter.handleMessage(message({ attachments: [incomingAttachment()] }));

    expect(context.runtime.enqueue).not.toHaveBeenCalled();
    expect(context.transport.sent.at(-1)?.content).toContain("요청을 처리하지 못했습니다");
  });

  it("commits prepared turns in gateway arrival order", async () => {
    const firstStored = deferred<readonly LocalDiscordAttachment[]>();
    const secondStored = deferred<readonly LocalDiscordAttachment[]>();
    const context = fixture(document(), {
      persist: vi.fn((input: DiscordAttachmentBatchInput) =>
        input.messageId === MESSAGE ? firstStored.promise : secondStored.promise,
      ),
    });
    await context.adapter.start("token");
    const firstHandler = context.transport.messageHandler?.(
      message({ id: MESSAGE, attachments: [incomingAttachment()] }),
    );
    const secondMessage = "400000000000000009";
    const secondHandler = context.transport.messageHandler?.(
      message({ id: secondMessage, attachments: [incomingAttachment()] }),
    );
    await vi.waitFor(() => expect(context.attachmentStore.persist).toHaveBeenCalledTimes(2));

    secondStored.resolve([localAttachment({ localPath: "/tmp/inbox/second/report.txt" })]);
    await Promise.resolve();
    expect(context.runtime.enqueue).not.toHaveBeenCalled();
    firstStored.resolve([localAttachment()]);
    await Promise.all([firstHandler, secondHandler]);

    expect(context.runtime.enqueue.mock.calls.map(([turn]) => turn.messageId)).toEqual([
      MESSAGE,
      secondMessage,
    ]);
    await context.adapter.stop();
  });

  it("quiesces gateway work before waiting for active turn handlers", async () => {
    const turn = deferred<void>();
    const context = fixture();
    context.runtime.enqueue.mockImplementationOnce(async () => turn.promise);
    await context.adapter.start("token");
    const handling = context.transport.messageHandler?.(message());
    await vi.waitFor(() => expect(context.runtime.enqueue).toHaveBeenCalledOnce());

    context.adapter.quiesce();

    expect(context.transport.messageHandler).toBeUndefined();
    expect(context.attachmentStore.stop).toHaveBeenCalledOnce();
    expect(context.transport.stopped).toBe(false);
    const stopping = context.adapter.stop();
    await Promise.resolve();
    expect(context.transport.stopped).toBe(false);
    turn.resolve();
    await Promise.all([handling, stopping]);
    expect(context.transport.stopped).toBe(true);
  });

  it("sends chunked output only to the originating channel and message", async () => {
    const context = fixture(document(policy({ textChunkLimit: 5, replyToMode: "first" })));

    await expect(context.adapter.sendText(CHANNEL, MESSAGE, "abcdefghij")).resolves.toEqual([
      { channelId: CHANNEL, messageId: "900000000000000001" },
      { channelId: CHANNEL, messageId: "900000000000000002" },
    ]);

    expect(context.transport.sent).toEqual([
      { channelId: CHANNEL, content: "abcde", replyToMessageId: MESSAGE },
      { channelId: CHANNEL, content: "fghij" },
    ]);
  });

  it("delivers prose and rendered table messages in order with one initial reply", async () => {
    const context = fixture(document(policy({ textChunkLimit: 80, replyToMode: "first" })));
    const input = [
      "Before",
      "",
      "| Name | Status |",
      "| --- | --- |",
      "| API | Ready |",
      "",
      "After",
    ].join("\n");
    const table = ["```", "Name  Status", "----  ------", "API   Ready", "```"].join("\n");

    await expect(context.adapter.sendText(CHANNEL, MESSAGE, input)).resolves.toEqual([
      { channelId: CHANNEL, messageId: "900000000000000001" },
      { channelId: CHANNEL, messageId: "900000000000000002" },
      { channelId: CHANNEL, messageId: "900000000000000003" },
    ]);

    expect(context.transport.sent).toEqual([
      { channelId: CHANNEL, content: "Before", replyToMessageId: MESSAGE },
      { channelId: CHANNEL, content: table },
      { channelId: CHANNEL, content: "After" },
    ]);
    expect(context.transport.sent.every(({ content }) => content.length <= 80)).toBe(true);
  });

  it("returns receipts and forces only the controller-selected first reply when policy is off", async () => {
    const context = fixture(document(policy({ textChunkLimit: 5, replyToMode: "off" })));
    let first = true;
    const dispatch = vi.fn(
      async (
        operation: (directive: { replyToMessageId?: string }) => Promise<{
          channelId: string;
          messageId: string;
        }>,
      ) => {
        const directive = first ? { replyToMessageId: MESSAGE } : {};
        first = false;
        return operation(directive);
      },
    );

    await expect(
      context.adapter.sendText(CHANNEL, MESSAGE, "abcdefghij", dispatch),
    ).resolves.toEqual([
      { channelId: CHANNEL, messageId: "900000000000000001" },
      { channelId: CHANNEL, messageId: "900000000000000002" },
    ]);

    expect(context.transport.sent).toEqual([
      { channelId: CHANNEL, content: "abcde", replyToMessageId: MESSAGE },
      { channelId: CHANNEL, content: "fghij" },
    ]);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("sends an authorized retained file through the originating message policy", async () => {
    const context = fixture();
    const file = authorizedFile();
    const controller = new AbortController();

    await context.adapter.sendFile(CHANNEL, MESSAGE, file, "attached", controller.signal);

    expect(context.transport.files).toEqual([
      {
        channelId: CHANNEL,
        file,
        content: "attached",
        replyToMessageId: MESSAGE,
        signal: controller.signal,
      },
    ]);
    expect(file.close).not.toHaveBeenCalled();
  });

  it("omits file replies when policy disables replies and rejects oversized content", async () => {
    const context = fixture(document(policy({ replyToMode: "off" })));
    const file = authorizedFile();

    await context.adapter.sendFile(CHANNEL, MESSAGE, file, undefined, new AbortController().signal);
    expect(context.transport.files[0]).not.toHaveProperty("replyToMessageId");
    await expect(
      context.adapter.sendFile(
        CHANNEL,
        MESSAGE,
        file,
        "x".repeat(2_001),
        new AbortController().signal,
      ),
    ).rejects.toThrow(BridgeError);
    expect(context.transport.files).toHaveLength(1);
  });

  it("returns a file receipt and honors a controller-forced reply when policy is off", async () => {
    const context = fixture(document(policy({ replyToMode: "off" })));
    const file = authorizedFile();
    const dispatch = vi.fn(
      async (
        operation: (directive: { replyToMessageId?: string }) => Promise<{
          channelId: string;
          messageId: string;
        }>,
      ) => operation({ replyToMessageId: MESSAGE }),
    );

    await expect(
      context.adapter.sendFile(
        CHANNEL,
        MESSAGE,
        file,
        undefined,
        new AbortController().signal,
        dispatch,
      ),
    ).resolves.toEqual({
      channelId: CHANNEL,
      messageId: "910000000000000001",
    });
    expect(context.transport.files[0]).toMatchObject({
      channelId: CHANNEL,
      replyToMessageId: MESSAGE,
    });
  });

  it("confirms the configured owner on the first owner DM before queueing", async () => {
    const context = fixture(document(policy(), bot({ ownerConfirmedAt: undefined })));

    await context.adapter.handleMessage(message({ authorId: OWNER }));

    expect(context.registry.confirmOwner).toHaveBeenCalledWith("bot-one", OWNER);
    expect(context.runtime.enqueue).toHaveBeenCalledOnce();
  });

  it("persists and replies with a pairing code without queueing the original DM", async () => {
    const context = fixture(document(policy({ dmPolicy: "pairing", allowFrom: [OWNER] })));

    await context.adapter.handleMessage(message());

    expect(context.registry.updateAccess).toHaveBeenCalledOnce();
    expect(context.transport.sent[0]).toMatchObject({ channelId: DM, replyToMessageId: MESSAGE });
    expect(context.transport.sent[0]?.content).toContain("PAIR-ONE");
    expect(context.runtime.enqueue).not.toHaveBeenCalled();
  });

  it("dispatches owner-only commands through runtime and manager ports", async () => {
    const context = fixture();
    const responses: string[] = [];
    const event = {
      id: "700000000000000001",
      channelId: DM,
      location: "dm" as const,
      userId: OWNER,
      subcommand: "spawn" as const,
      bot: "bot-two",
      workspace: "main",
      acknowledge: vi.fn(async () => undefined),
      respond: vi.fn(async (text: string) => {
        responses.push(text);
      }),
    };

    await context.adapter.handleCommand(event);

    expect(context.manager.spawn).toHaveBeenCalledWith("bot-two", "main");
    expect(event.acknowledge).toHaveBeenCalledOnce();
    expect(responses.join(" ")).toContain("new-agent");
  });

  it("keeps model controls owner-only and limited to allowed guild channels", async () => {
    const context = fixture();

    const unauthorized = await runCommand(context, "model", {
      userId: USER,
      name: "mini-id",
    });
    const wrongChannel = await runCommand(context, "reasoning", {
      channelId: CATEGORY,
      location: "guild",
      guildId: GUILD,
      effort: "high",
    });

    expect(unauthorized.responses).toEqual(["이 명령을 실행할 권한이 없습니다."]);
    expect(wrongChannel.responses).toEqual(["이 명령을 실행할 권한이 없습니다."]);
    expect(context.runtime.setModel).not.toHaveBeenCalled();
    expect(context.runtime.setReasoningEffort).not.toHaveBeenCalled();
  });

  it("routes model and reasoning changes, including default resets", async () => {
    const context = fixture();

    await runCommand(context, "model", { name: "mini-id" });
    await runCommand(context, "model", { name: "default" });
    await runCommand(context, "reasoning", { effort: "high" });
    await runCommand(context, "reasoning", { effort: "default" });

    expect(context.runtime.setModel).toHaveBeenNthCalledWith(1, {
      kind: "model",
      id: "mini-id",
    });
    expect(context.runtime.setModel).toHaveBeenNthCalledWith(2, { kind: "default" });
    expect(context.runtime.setReasoningEffort).toHaveBeenNthCalledWith(1, {
      kind: "effort",
      value: "high",
    });
    expect(context.runtime.setReasoningEffort).toHaveBeenNthCalledWith(2, {
      kind: "default",
    });
  });

  it("rejects oversized and control-character settings before runtime mutation", async () => {
    const context = fixture();

    const oversized = await runCommand(context, "model", { name: "가".repeat(256) });
    const controlled = await runCommand(context, "reasoning", { effort: "high\n" });

    expect(oversized.responses).toEqual(["명령을 처리하지 못했습니다."]);
    expect(controlled.responses).toEqual(["명령을 처리하지 못했습니다."]);
    expect(context.runtime.setModel).not.toHaveBeenCalled();
    expect(context.runtime.setReasoningEffort).not.toHaveBeenCalled();
  });

  it("formats status with effective model, effort, inheritance source, and hidden marker", async () => {
    const context = fixture();
    context.runtime.modelStatus.mockReturnValue(
      modelStatus({ hidden: true, modelSource: "binding", reasoningSource: "binding" }),
    );

    const { responses } = await runCommand(context, "status");

    expect(context.manager.status).toHaveBeenCalledOnce();
    expect(responses[0]).toContain("Model: GPT-5.6 Sol (sol-id) (hidden) [explicit]");
    expect(responses[0]).toContain("Reasoning: medium [explicit]");
    expect(responses[0]).toContain("Runtime: running");
  });

  it("lists visible models with current, default, and effort metadata", async () => {
    const context = fixture();

    const { responses } = await runCommand(context, "models");

    expect(responses[0]).toContain("GPT-5.6 Sol (sol-id) [current, default]");
    expect(responses[0]).toContain("Default effort: medium");
    expect(responses[0]).toContain("Supported efforts: low, medium, high");
    expect(responses[0]).toContain("GPT-5.6 Mini (mini-id)");
  });

  it("marks a persisted hidden model in status without adding it to visible models", async () => {
    const context = fixture();
    context.runtime.modelStatus.mockReturnValue(
      modelStatus({
        modelId: "hidden-id",
        displayName: "Hidden Model",
        hidden: true,
        modelSource: "binding",
      }),
    );

    const status = await runCommand(context, "status");
    const models = await runCommand(context, "models");

    expect(status.responses[0]).toContain("Hidden Model (hidden-id) (hidden)");
    expect(models.responses[0]).not.toContain("hidden-id");
  });

  it("bounds model output and reports the number of omitted models", async () => {
    const context = fixture();
    const summaries = Array.from(
      { length: 20 },
      (_, index): ModelSummary => ({
        id: `model-${index}`,
        displayName: `${"M".repeat(500)}-${index}`,
        isDefault: index === 0,
        isCurrent: index === 0,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["low", "medium", "high"],
      }),
    );
    context.runtime.listModels.mockReturnValue(summaries);

    const { responses } = await runCommand(context, "models");

    expect(responses[0]?.length).toBeLessThanOrEqual(1_900);
    expect(responses[0]).toMatch(/\.\.\. \d+ models omitted$/u);
    expect(responses[0]).not.toContain("[TRUNCATED]");
  });

  it("maps idle conflicts to a fixed response and keeps other command errors generic", async () => {
    const context = fixture();
    context.runtime.setModel.mockRejectedValueOnce(
      new BridgeError("CONFLICT", "Internal queue details must stay private."),
    );
    context.runtime.setReasoningEffort.mockRejectedValueOnce(
      new BridgeError("INVALID_ARGUMENT", "Unsupported secret effort value."),
    );

    const conflict = await runCommand(context, "model", { name: "mini-id" });
    const invalid = await runCommand(context, "reasoning", { effort: "ultra" });

    expect(conflict.responses).toEqual([
      "활성 또는 대기 중인 턴이 있습니다. 큐가 비면 다시 시도해 주세요.",
    ]);
    expect(invalid.responses).toEqual(["명령을 처리하지 못했습니다."]);
    expect(invalid.responses.join(" ")).not.toContain("Unsupported secret effort value");
  });

  it("validates approval buttons against latest owner policy and exact message", async () => {
    const context = fixture();
    const noticeMessage = await context.adapter.sendApproval({
      ownerId: OWNER,
      requestId: 12,
      method: "item/commandExecution/requestApproval",
      threadId: "thread",
      turnId: "turn",
      itemId: "item",
      command: "npm test",
      actions: ["allow", "deny"],
    });
    const customId = context.transport.direct[0]?.buttons?.[0]?.customId.replace(/:allow$/u, "");
    expect(customId).toBeDefined();
    const respond = vi.fn(async () => undefined);

    await context.adapter.handleButton({
      customId: `${customId}:allow`,
      messageId: noticeMessage,
      channelId: DM,
      location: "dm",
      userId: OWNER,
      respond,
    });

    expect(context.approval.handleInteraction).toHaveBeenCalledWith({
      requestId: 12,
      messageId: noticeMessage,
      userId: OWNER,
      action: "allow",
    });
    expect(respond).toHaveBeenCalled();
  });
});

describe("DiscordJsGatewayTransport", () => {
  it("creates a message-started progress thread from the exact source message", async () => {
    const startThread = vi.fn(async () => ({
      id: THREAD,
      parentId: CHANNEL,
      ownerId: BOT,
      name: "untrusted",
    }));
    const fetchMessage = vi.fn(async () => ({ id: MESSAGE, startThread }));
    const client = {
      user: { id: BOT },
      channels: {
        fetch: vi.fn(async () => ({
          id: CHANNEL,
          type: ChannelType.GuildText,
          messages: { fetch: fetchMessage },
        })),
      },
    } as unknown as Client;
    const transport = new DiscordJsGatewayTransport(client);

    await expect(
      transport.createProgressThread(CHANNEL, MESSAGE, { autoArchiveDuration: 60 }),
    ).resolves.toEqual({
      id: THREAD,
      parentId: CHANNEL,
      ownerId: BOT,
    });

    expect(fetchMessage).toHaveBeenCalledExactlyOnceWith(MESSAGE);
    expect(startThread).toHaveBeenCalledExactlyOnceWith({
      name: `Codex progress ${MESSAGE.slice(-8)}`,
      autoArchiveDuration: 60,
      reason: "Codex progress observation",
    });
  });

  it("reports progress permissions independently", async () => {
    const has = vi.fn((permission: bigint) => permission !== PermissionFlagsBits.ManageThreads);
    const client = {
      user: { id: BOT },
      channels: {
        fetch: vi.fn(async () => ({
          id: CHANNEL,
          type: ChannelType.GuildText,
          isTextBased: () => true,
          isDMBased: () => false,
          permissionsFor: vi.fn(() => ({ has })),
        })),
      },
    } as unknown as Client;
    const transport = new DiscordJsGatewayTransport(client);

    await expect(transport.inspectProgressCapabilities(CHANNEL)).resolves.toEqual({
      createPublicThreads: true,
      sendMessagesInThreads: true,
      manageThreads: false,
    });
    expect(has.mock.calls.map(([permission]) => permission)).toEqual([
      PermissionFlagsBits.CreatePublicThreads,
      PermissionFlagsBits.SendMessagesInThreads,
      PermissionFlagsBits.ManageThreads,
    ]);
  });

  it("sends and edits progress messages with mentions disabled", async () => {
    const send = vi.fn(async () => ({
      id: PROGRESS_MESSAGE,
      content: "must not escape the receipt",
    }));
    const edit = vi.fn(async () => ({
      id: PROGRESS_MESSAGE,
      content: "must not escape the receipt",
    }));
    const fetchMessage = vi.fn(async () => ({
      id: PROGRESS_MESSAGE,
      author: { id: BOT },
      editable: true,
      edit,
    }));
    const client = {
      user: { id: BOT },
      channels: {
        fetch: vi.fn(async () => ({
          isSendable: () => true,
          send,
          messages: { fetch: fetchMessage },
        })),
      },
    } as unknown as Client;
    const transport = new DiscordJsGatewayTransport(client);
    const allowedMentions = {
      parse: [],
      users: [],
      roles: [],
      repliedUser: false,
    };

    await expect(transport.sendMessage(THREAD, { content: "@everyone queued" })).resolves.toEqual({
      id: PROGRESS_MESSAGE,
    });
    await expect(
      transport.editMessage(THREAD, PROGRESS_MESSAGE, { content: "@here running" }),
    ).resolves.toEqual({ id: PROGRESS_MESSAGE });

    expect(send).toHaveBeenCalledExactlyOnceWith({
      content: "@everyone queued",
      components: [],
      allowedMentions,
    });
    expect(fetchMessage).toHaveBeenCalledExactlyOnceWith(PROGRESS_MESSAGE);
    expect(edit).toHaveBeenCalledExactlyOnceWith({
      content: "@here running",
      allowedMentions,
    });
  });

  it("does not expose Discord error details when progress message delivery fails", async () => {
    const client = {
      channels: {
        fetch: vi.fn(async () => ({
          isSendable: () => true,
          send: vi.fn(async () => {
            throw new Error("secret transport detail");
          }),
        })),
      },
    } as unknown as Client;
    const transport = new DiscordJsGatewayTransport(client);

    await expect(
      transport.sendMessage(THREAD, { content: "sensitive progress content" }),
    ).rejects.toMatchObject({
      code: "RUNTIME",
      message: "Discord message send failed.",
    });
  });

  it("inspects and updates only bot-owned Discord threads", async () => {
    const setArchived = vi.fn(async () => undefined);
    const setLocked = vi.fn(async () => undefined);
    const thread = {
      id: THREAD,
      parentId: CHANNEL,
      ownerId: BOT,
      archived: false,
      locked: false,
      isThread: () => true,
      setArchived,
      setLocked,
    };
    const client = {
      user: { id: BOT },
      channels: { fetch: vi.fn(async () => thread) },
    } as unknown as Client;
    const transport = new DiscordJsGatewayTransport(client);

    await expect(transport.inspectThread(THREAD)).resolves.toEqual({
      status: "found",
      id: THREAD,
      parentId: CHANNEL,
      ownerId: BOT,
      archived: false,
      locked: false,
    });
    await expect(
      transport.setProgressThreadState(THREAD, { archived: true, locked: true }),
    ).resolves.toBeUndefined();

    expect(setLocked).toHaveBeenCalledExactlyOnceWith(true, "Codex progress observation");
    expect(setArchived).toHaveBeenCalledExactlyOnceWith(true, "Codex progress observation");

    thread.ownerId = USER;
    await expect(
      transport.setProgressThreadState(THREAD, { archived: false, locked: false }),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "Discord progress thread is not owned by this bot.",
    });
    expect(setLocked).toHaveBeenCalledOnce();
    expect(setArchived).toHaveBeenCalledOnce();
  });

  it("treats only Discord's authoritative unknown-channel response as not found", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce({ code: 10_003 })
      .mockRejectedValueOnce({ code: 50_013, message: "secret permission detail" })
      .mockRejectedValueOnce({ status: 429, message: "secret rate-limit detail" })
      .mockRejectedValueOnce(new Error("secret transport detail"));
    const client = { channels: { fetch } } as unknown as Client;
    const transport = new DiscordJsGatewayTransport(client);

    await expect(transport.inspectThread(THREAD)).resolves.toEqual({
      status: "not-found",
      threadId: THREAD,
    });
    await expect(transport.inspectThread(THREAD)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "Discord denied access to the progress thread.",
    });
    await expect(transport.inspectThread(THREAD)).rejects.toMatchObject({
      code: "RUNTIME",
      message: "Discord rate-limited progress thread inspection.",
    });
    await expect(transport.inspectThread(THREAD)).rejects.toMatchObject({
      code: "RUNTIME",
      message: "Discord progress thread inspection failed.",
    });
  });

  it("uploads the retained stream by display filename without reopening its path", async () => {
    const send = vi.fn(async () => ({ id: "920000000000000001" }));
    const client = {
      channels: {
        fetch: vi.fn(async () => ({ isSendable: () => true, send })),
      },
    } as unknown as Client;
    const transport = new DiscordJsGatewayTransport(client);
    const file = authorizedFile();
    const controller = new AbortController();

    await expect(
      transport.sendFile(CHANNEL, {
        file,
        content: "attached",
        replyToMessageId: MESSAGE,
        signal: controller.signal,
      }),
    ).resolves.toEqual({ id: "920000000000000001" });

    expect(file.createReadStream).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      content: "attached",
      files: [{ attachment: expect.any(Readable), name: "report.txt" }],
      reply: { messageReference: MESSAGE, failIfNotExists: false },
    });
    expect(JSON.stringify(send.mock.calls)).not.toContain(file.canonicalPath);
    expect(file.close).not.toHaveBeenCalled();
  });

  it("rejects an already aborted upload and destroys a stream aborted in flight", async () => {
    const waitingStream = new PassThrough();
    const send = vi.fn(
      async (payload: { files: Array<{ attachment: Readable }> }) =>
        new Promise<{ id: string }>((_resolve, reject) => {
          payload.files[0]?.attachment.once("error", reject);
        }),
    );
    const client = {
      channels: {
        fetch: vi.fn(async () => ({ isSendable: () => true, send })),
      },
    } as unknown as Client;
    const transport = new DiscordJsGatewayTransport(client);
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();

    await expect(
      transport.sendFile(CHANNEL, {
        file: authorizedFile(),
        signal: alreadyAborted.signal,
      }),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();

    const active = new AbortController();
    const uploading = transport.sendFile(CHANNEL, {
      file: authorizedFile(waitingStream),
      signal: active.signal,
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    active.abort();
    await expect(uploading).rejects.toThrow();
    expect(waitingStream.destroyed).toBe(true);
  });

  it("parses only the model option for the model subcommand", async () => {
    const emitter = Object.assign(new EventEmitter(), { user: { id: BOT } });
    const transport = new DiscordJsGatewayTransport(emitter as unknown as Client);
    const handler = vi.fn(async (_event: DiscordCommandEvent) => undefined);
    const getString = vi.fn((name: string) => {
      if (name !== "name") throw new Error(`Unexpected string option: ${name}`);
      return "mini-id";
    });
    transport.onCommand(handler);

    emitter.emit(Events.InteractionCreate, {
      id: "700000000000000001",
      commandName: "codex",
      channelId: DM,
      channel: {},
      guildId: null,
      user: { id: OWNER },
      options: {
        getSubcommand: () => "model",
        getBoolean: () => {
          throw new Error("Unexpected boolean option");
        },
        getString,
      },
      isChatInputCommand: () => true,
      deferred: false,
      replied: false,
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      reply: vi.fn(async () => undefined),
    });

    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    expect(getString).toHaveBeenCalledExactlyOnceWith("name");
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        subcommand: "model",
        name: "mini-id",
      }),
    );
  });

  it("does not misclassify a categorized text channel as a thread", async () => {
    const emitter = Object.assign(new EventEmitter(), { user: { id: BOT } });
    const transport = new DiscordJsGatewayTransport(emitter as unknown as Client);
    const handler = vi.fn(async (_event: DiscordMessageEvent) => undefined);
    transport.onMessage(handler);

    emitter.emit(Events.MessageCreate, {
      id: MESSAGE,
      channelId: CHANNEL,
      guildId: GUILD,
      channel: { parentId: CATEGORY, isThread: () => false },
      author: { id: OWNER, bot: false, system: false },
      content: "hello",
      mentions: { users: { has: () => false } },
      attachments: new Collection([
        [
          ATTACHMENT,
          {
            id: ATTACHMENT,
            name: "report.txt",
            size: 5,
            contentType: "text/plain",
            url: `https://cdn.discordapp.com/attachments/${CHANNEL}/${ATTACHMENT}/report.txt`,
          },
        ],
      ]),
    });

    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    expect(handler).toHaveBeenCalledWith({
      id: MESSAGE,
      channelId: CHANNEL,
      location: "guild",
      authorId: OWNER,
      authorIsBot: false,
      authorIsSystem: false,
      content: "hello",
      mentionsBot: false,
      guildId: GUILD,
      attachments: [
        {
          id: ATTACHMENT,
          filename: "report.txt",
          size: 5,
          contentType: "text/plain",
          url: `https://cdn.discordapp.com/attachments/${CHANNEL}/${ATTACHMENT}/report.txt`,
        },
      ],
    });
  });

  it("uses the parent channel policy for an actual thread", async () => {
    const emitter = Object.assign(new EventEmitter(), { user: { id: BOT } });
    const transport = new DiscordJsGatewayTransport(emitter as unknown as Client);
    const handler = vi.fn(async (_event: DiscordMessageEvent) => undefined);
    transport.onMessage(handler);

    emitter.emit(Events.MessageCreate, {
      id: MESSAGE,
      channelId: CHANNEL,
      guildId: GUILD,
      channel: { parentId: CATEGORY, ownerId: BOT, isThread: () => true },
      author: { id: OWNER, bot: false, system: false },
      content: "hello",
      mentions: { users: { has: () => false } },
      attachments: new Collection(),
    });

    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: CHANNEL,
        location: "thread",
        parentChannelId: CATEGORY,
        threadOwnerId: BOT,
      }),
    );
  });
});
