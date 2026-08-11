import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type {
  AuthorizedDiscordSendFileArguments,
  CodexModelCatalogEntry,
  CodexTurnSettings,
  DiscordTurnSource,
} from "../../src/app-server/session.js";
import { BridgeError } from "../../src/domain/errors.js";
import type { WorkspaceProfile } from "../../src/domain/schemas.js";
import type { AuthorizedOutboundFile } from "../../src/manager/workspaces.js";
import {
  AgentRuntime,
  type AgentRuntimeBinding,
  type AgentRuntimeClock,
  type AgentRuntimeDeliveryDirective,
  type AgentRuntimeEvent,
  type AgentRuntimeOutput,
  type AgentRuntimePorts,
  type AgentRuntimeSendFileRequest,
  type AgentRuntimeSendFileResult,
  type AgentRuntimeSession,
  AgentRuntimeSessionError,
} from "../../src/runtime/agent-runtime.js";
import type { DiscordDeliveryReceipt, TurnProgressPort } from "../../src/runtime/turn-progress.js";
import type { TurnInput } from "../../src/runtime/turn-queue.js";

const profile = {
  name: "workspace",
  cwd: "/repo",
  sandbox: "read-only",
  approvalPolicy: "never",
  runtimeWorkspaceRoots: ["/repo"],
} satisfies WorkspaceProfile;

const binding: AgentRuntimeBinding = {
  id: "11111111-1111-4111-8111-111111111111",
  threadId: "22222222-2222-4222-8222-222222222222",
  workspace: profile,
  inbox: "/tmp/inbox",
};

const modelCatalog: readonly CodexModelCatalogEntry[] = [
  {
    id: "sol-id",
    model: "sol-request",
    displayName: "Sol",
    hidden: false,
    isDefault: true,
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: ["low", "high"],
  },
  {
    id: "luna-id",
    model: "luna-request",
    displayName: "Luna",
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["medium", "high"],
  },
  {
    id: "mini-id",
    model: "mini-request",
    displayName: "Mini",
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["medium"],
  },
  {
    id: "hidden-id",
    model: "hidden-request",
    displayName: "Hidden",
    hidden: true,
    isDefault: false,
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["high"],
  },
];

const input: TurnInput = {
  channelId: "123",
  messageId: "456",
  authorId: "789",
  text: "hello",
};

function testReceipt(messageId = "900000000000000001"): DiscordDeliveryReceipt {
  return { channelId: input.channelId, messageId };
}

class FakeSession implements AgentRuntimeSession {
  readonly starts: string[] = [];
  readonly turnSettings: Array<CodexTurnSettings | undefined> = [];
  readonly resumes: string[] = [];
  readonly interrupts: Array<[string, string]> = [];
  readonly listeners = new Map<
    AgentRuntimeEvent["method"],
    Set<(event: AgentRuntimeEvent) => void>
  >();
  nextTurnId = "turn-1";
  startTurnResult: Promise<{ turnId: string }> | undefined;
  nextThreadId = "33333333-3333-4333-8333-333333333333";
  startTurnError: unknown;
  startCalls = 0;
  listModelCalls = 0;
  creationKey: string | undefined;
  catalog: readonly CodexModelCatalogEntry[] = modelCatalog;
  sendFileListener:
    | ((
        request: AgentRuntimeSendFileRequest,
      ) => Promise<AgentRuntimeSendFileResult> | AgentRuntimeSendFileResult)
    | undefined;
  readonly authorizeSendFile = vi.fn<
    (threadId: string, input: unknown) => Promise<AuthorizedDiscordSendFileArguments>
  >(async () => {
    throw new Error("File authorization is not configured for this test.");
  });
  readonly parseFileMarkers = vi.fn(
    async (
      _threadId: string,
      text: string,
    ): Promise<{
      visibleText: string;
      files: AuthorizedOutboundFile[];
    }> => ({ visibleText: text, files: [] }),
  );

  async listModels(): Promise<readonly CodexModelCatalogEntry[]> {
    this.listModelCalls += 1;
    return this.catalog;
  }

  async resume(threadId: string, _workspace: WorkspaceProfile, _inbox: string): Promise<void> {
    this.resumes.push(threadId);
  }

  async startTurn(
    threadId: string,
    text: string,
    _source?: DiscordTurnSource,
    settings?: CodexTurnSettings,
  ): Promise<{ turnId: string }> {
    this.startCalls += 1;
    if (this.startTurnError !== undefined) throw this.startTurnError;
    this.starts.push(`${threadId}:${text}`);
    this.turnSettings.push(settings);
    if (this.startTurnResult !== undefined) return this.startTurnResult;
    return { turnId: this.nextTurnId };
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    this.interrupts.push([threadId, turnId]);
  }

  async start(
    _workspace: WorkspaceProfile,
    _inbox: string,
    creationKey: string,
  ): Promise<{ threadId: string }> {
    this.creationKey = creationKey;
    return { threadId: this.nextThreadId };
  }

  onNotification(
    method: AgentRuntimeEvent["method"],
    listener: (event: AgentRuntimeEvent) => void,
  ): () => void {
    const set = this.listeners.get(method) ?? new Set();
    set.add(listener);
    this.listeners.set(method, set);
    return () => set.delete(listener);
  }

  onSendFileRequest(
    listener: (
      request: AgentRuntimeSendFileRequest,
    ) => Promise<AgentRuntimeSendFileResult> | AgentRuntimeSendFileResult,
  ): () => void {
    this.sendFileListener = listener;
    return () => {
      if (this.sendFileListener === listener) this.sendFileListener = undefined;
    };
  }

  async requestSendFile(request: AgentRuntimeSendFileRequest): Promise<AgentRuntimeSendFileResult> {
    return (
      (await this.sendFileListener?.(request)) ?? {
        success: false,
        contentItems: [{ type: "inputText", text: "File could not be sent." }],
      }
    );
  }

  emit(event: AgentRuntimeEvent): void {
    this.listeners.get(event.method)?.forEach((listener) => {
      listener(event);
    });
  }
}

function ports(session: FakeSession, output: AgentRuntimeOutput): AgentRuntimePorts {
  let currentBinding = binding;
  return {
    registry: {
      readBinding: async () => currentBinding,
      markState: vi.fn(async () => undefined),
      replaceThread: vi.fn(async (_id: string, threadId: string) => {
        currentBinding = { ...currentBinding, threadId };
        return currentBinding;
      }),
      updateModelSettings: vi.fn(async (_id, settings) => {
        const {
          modelId: _modelId,
          reasoningEffort: _reasoningEffort,
          ...unchanged
        } = currentBinding;
        currentBinding = { ...unchanged, ...settings };
        return currentBinding;
      }),
    },
    appServer: {
      start: async () => session,
      stop: async () => undefined,
    },
    output: {
      ...output,
      reportOrphanThread: output.reportOrphanThread ?? (async () => undefined),
    },
  };
}

function progressPort(): TurnProgressPort {
  return {
    queued: vi.fn(async () => undefined),
    running: vi.fn(async () => undefined),
    bindTurn: vi.fn(async () => undefined),
    event: vi.fn(async () => undefined),
    terminal: vi.fn(async () => undefined),
  };
}

function finalProgressPort() {
  const base = progressPort();
  let accepted = 0;
  let tail = Promise.resolve();
  const deliver = vi.fn(
    (
      _source: { channelId: string; messageId: string },
      operation: (directive: { replyToMessageId?: string }) => Promise<{
        channelId: string;
        messageId: string;
      }>,
    ) => {
      const pending = tail.then(async () => {
        const receipt = await operation(
          accepted === 0 ? { replyToMessageId: input.messageId } : {},
        );
        accepted += 1;
        return receipt;
      });
      tail = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    },
  );
  return {
    ...base,
    decorateFinalText: vi.fn((_source: { channelId: string; messageId: string }, text: string) =>
      text.length === 0 ? text : `${text}\n\nProgress: https://discord.test/thread`,
    ),
    deliver,
  };
}

const immediateClock: AgentRuntimeClock = {
  sleep: async () => undefined,
  now: () => 0,
};

function configurablePorts(
  session: FakeSession,
  output: AgentRuntimeOutput,
  initialBinding: AgentRuntimeBinding,
): {
  readonly ports: AgentRuntimePorts;
  readonly update: ReturnType<typeof vi.fn>;
  current(): AgentRuntimeBinding;
} {
  let current = initialBinding;
  const runtimePorts = ports(session, output);
  const update = vi.fn(async (_id: string, settings: Record<string, string | undefined>) => {
    const { modelId: _modelId, reasoningEffort: _reasoningEffort, ...unchanged } = current;
    current = { ...unchanged, ...settings };
    return current;
  });
  runtimePorts.registry.readBinding = async () => current;
  runtimePorts.registry.replaceThread = vi.fn(async (_id: string, threadId: string) => {
    current = { ...current, threadId };
    return current;
  });
  runtimePorts.registry.updateModelSettings = update;
  return { ports: runtimePorts, update, current: () => current };
}

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function outboundFile(
  canonicalPath: string,
): AuthorizedOutboundFile & { close: ReturnType<typeof vi.fn> } {
  return {
    canonicalPath,
    displayFilename: canonicalPath.split("/").at(-1) ?? "file",
    size: 5,
    isClosed: false,
    createReadStream: () => Readable.from(["hello"]),
    close: vi.fn(async () => undefined),
    async [Symbol.asyncDispose]() {
      await this.close();
    },
  };
}

describe("AgentRuntime", () => {
  it("marks a queued source running before turn/start resolves and binds only its returned turn", async () => {
    const session = new FakeSession();
    const start = deferred<{ turnId: string }>();
    session.startTurnResult = start.promise;
    const progress = progressPort();
    const output = { sendText: vi.fn(async () => [testReceipt()]) } satisfies AgentRuntimeOutput;
    const runtime = new AgentRuntime(
      { ...ports(session, output), progress },
      {
        clock: immediateClock,
      },
    );
    await runtime.start();

    const turn = runtime.enqueue(input);
    await vi.waitFor(() => expect(progress.running).toHaveBeenCalledOnce());
    expect(progress.running).toHaveBeenCalledWith({
      channelId: input.channelId,
      messageId: input.messageId,
    });
    expect(progress.bindTurn).not.toHaveBeenCalled();

    start.resolve({ turnId: "turn-1" });
    await vi.waitFor(() => expect(progress.bindTurn).toHaveBeenCalledOnce());
    expect(progress.bindTurn).toHaveBeenCalledWith(
      { channelId: input.channelId, messageId: input.messageId },
      "turn-1",
    );
    session.emit({ method: "turn/completed", threadId: binding.threadId, turnId: "turn-1" });
    await turn;
  });

  it("routes commentary to progress while retaining only final-compatible agent text", async () => {
    const session = new FakeSession();
    const progress = progressPort();
    const output = {
      sendText: vi.fn(async (_channelId: string, _messageId: string, _text: string) => [
        testReceipt(),
      ]),
    } satisfies AgentRuntimeOutput;
    const runtime = new AgentRuntime(
      { ...ports(session, output), progress },
      {
        clock: immediateClock,
      },
    );
    await runtime.start();
    const turn = runtime.enqueue(input);
    await vi.waitFor(() => expect(session.starts).toHaveLength(1));

    session.emit({
      method: "item/started",
      threadId: binding.threadId,
      turnId: "turn-1",
      itemId: "commentary-1",
      kind: "agentMessage",
      phase: "commentary",
    });
    session.emit({
      method: "item/agentMessage/delta",
      threadId: binding.threadId,
      turnId: "turn-1",
      itemId: "commentary-1",
      delta: "Inspecting the runtime.",
    });
    session.emit({
      method: "item/completed",
      threadId: binding.threadId,
      turnId: "turn-1",
      itemId: "commentary-1",
      kind: "agentMessage",
      phase: "commentary",
      text: "Inspection complete.",
    });
    session.emit({
      method: "item/started",
      threadId: binding.threadId,
      turnId: "turn-1",
      itemId: "final-1",
      kind: "agentMessage",
      phase: "final_answer",
    });
    session.emit({
      method: "item/agentMessage/delta",
      threadId: binding.threadId,
      turnId: "turn-1",
      itemId: "final-1",
      delta: "draft",
    });
    session.emit({
      method: "item/completed",
      threadId: binding.threadId,
      turnId: "turn-1",
      itemId: "final-1",
      kind: "agentMessage",
      phase: "final_answer",
      text: "Final answer.",
    });
    session.emit({ method: "turn/completed", threadId: binding.threadId, turnId: "turn-1" });
    await turn;

    expect(progress.event).toHaveBeenCalledWith(
      { channelId: input.channelId, messageId: input.messageId },
      { type: "commentary", text: "Inspecting the runtime." },
    );
    const delivered = output.sendText.mock.calls.flatMap((call) => call[2]).join("");
    expect(delivered).toBe("Final answer.");
    expect(delivered).not.toContain("Inspection");
  });

  it("buffers start-time notifications and drains them after the authoritative turn ID", async () => {
    const session = new FakeSession();
    const start = deferred<{ turnId: string }>();
    session.startTurnResult = start.promise;
    const progress = progressPort();
    const output = { sendText: vi.fn(async () => [testReceipt()]) } satisfies AgentRuntimeOutput;
    const runtime = new AgentRuntime(
      { ...ports(session, output), progress },
      {
        clock: immediateClock,
      },
    );
    await runtime.start();
    const turn = runtime.enqueue(input);
    await vi.waitFor(() => expect(session.starts).toHaveLength(1));

    session.emit({
      method: "item/started",
      threadId: binding.threadId,
      turnId: "turn-early",
      itemId: "final-1",
      kind: "agentMessage",
      phase: "final_answer",
    });
    session.emit({
      method: "item/reasoning/summaryTextDelta",
      threadId: binding.threadId,
      turnId: "turn-early",
      itemId: "reasoning-1",
      progress: { type: "reasoning", text: "Checking early events." },
    });
    session.emit({
      method: "item/completed",
      threadId: binding.threadId,
      turnId: "turn-early",
      itemId: "final-1",
      kind: "agentMessage",
      phase: "final_answer",
      text: "Early final answer.",
    });
    session.emit({
      method: "turn/completed",
      threadId: binding.threadId,
      turnId: "turn-early",
    });

    expect(progress.event).not.toHaveBeenCalled();
    expect(output.sendText).not.toHaveBeenCalled();
    start.resolve({ turnId: "turn-early" });
    await turn;

    expect(progress.event).toHaveBeenCalledWith(
      { channelId: input.channelId, messageId: input.messageId },
      { type: "reasoning", text: "Checking early events." },
    );
    expect(output.sendText).toHaveBeenCalledExactlyOnceWith(
      input.channelId,
      input.messageId,
      "Early final answer.",
    );
  });

  it("holds an early file tool request until its turn start is authoritative", async () => {
    const session = new FakeSession();
    const start = deferred<{ turnId: string }>();
    session.startTurnResult = start.promise;
    const file = outboundFile("/repo/early.txt");
    session.authorizeSendFile.mockResolvedValue({ file });
    const output = {
      sendText: vi.fn(async () => [testReceipt()]),
      sendFile: vi.fn(async () => testReceipt()),
    } satisfies AgentRuntimeOutput;
    const runtime = new AgentRuntime(ports(session, output), { clock: immediateClock });
    await runtime.start();
    const turn = runtime.enqueue(input);
    await vi.waitFor(() => expect(session.starts).toHaveLength(1));

    let settled = false;
    const tool = session
      .requestSendFile({
        threadId: binding.threadId,
        turnId: "turn-early",
        callId: "call-early",
        arguments: { path: file.canonicalPath },
      })
      .finally(() => {
        settled = true;
      });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(session.authorizeSendFile).not.toHaveBeenCalled();

    start.resolve({ turnId: "turn-early" });
    await expect(tool).resolves.toMatchObject({ success: true });
    expect(session.authorizeSendFile).toHaveBeenCalledOnce();
    session.emit({
      method: "turn/completed",
      threadId: binding.threadId,
      turnId: "turn-early",
    });
    await turn;
  });

  it("delivers a file then decorated final text through one receipt chain before terminal", async () => {
    const session = new FakeSession();
    const file = outboundFile("/repo/result.txt");
    session.authorizeSendFile.mockResolvedValue({ file });
    const progress = finalProgressPort();
    const directives: Array<{ kind: "file" | "text"; replyToMessageId?: string }> = [];
    const output: AgentRuntimeOutput = {
      sendFile: vi.fn(async (_channelId, _messageId, _file, _message, _signal, dispatch) => {
        if (dispatch === undefined) throw new Error("missing delivery dispatch");
        return dispatch(async (directive: AgentRuntimeDeliveryDirective) => {
          directives.push({ kind: "file", ...directive });
          return { channelId: input.channelId, messageId: "9001" };
        });
      }),
      sendText: vi.fn(async (_channelId, _messageId, _text, dispatch) => {
        if (dispatch === undefined) throw new Error("missing delivery dispatch");
        return [
          await dispatch(async (directive: AgentRuntimeDeliveryDirective) => {
            directives.push({ kind: "text", ...directive });
            return { channelId: input.channelId, messageId: "9002" };
          }),
        ];
      }),
    };
    const runtime = new AgentRuntime(
      { ...ports(session, output), progress },
      {
        clock: immediateClock,
      },
    );
    await runtime.start();
    const turn = runtime.enqueue(input);
    await vi.waitFor(() => expect(session.starts).toHaveLength(1));

    await expect(
      session.requestSendFile({
        threadId: binding.threadId,
        turnId: "turn-1",
        callId: "call-file",
        arguments: { path: file.canonicalPath },
      }),
    ).resolves.toMatchObject({ success: true });
    session.emit({
      method: "item/started",
      threadId: binding.threadId,
      turnId: "turn-1",
      itemId: "final",
      kind: "agentMessage",
      phase: "final_answer",
    });
    session.emit({
      method: "item/completed",
      threadId: binding.threadId,
      turnId: "turn-1",
      itemId: "final",
      kind: "agentMessage",
      phase: "final_answer",
      text: "Answer.",
    });
    session.emit({ method: "turn/completed", threadId: binding.threadId, turnId: "turn-1" });
    await turn;

    expect(directives).toEqual([
      { kind: "file", replyToMessageId: input.messageId },
      { kind: "text" },
    ]);
    expect(output.sendText).toHaveBeenCalledWith(
      input.channelId,
      input.messageId,
      "Answer.\n\nProgress: https://discord.test/thread",
      expect.any(Function),
    );
    expect(progress.terminal).toHaveBeenCalledExactlyOnceWith(
      { channelId: input.channelId, messageId: input.messageId },
      { status: "completed", type: "terminal" },
    );
  });

  it("uses a marker-only file as the first reply without fabricating final text", async () => {
    const session = new FakeSession();
    const marker = outboundFile("/repo/marker.txt");
    session.parseFileMarkers.mockResolvedValue({ visibleText: "", files: [marker] });
    const progress = finalProgressPort();
    const directives: Array<{ replyToMessageId?: string }> = [];
    const output: AgentRuntimeOutput = {
      sendText: vi.fn(async () => [testReceipt()]),
      sendFile: vi.fn(async (_channelId, _messageId, _file, _message, _signal, dispatch) => {
        if (dispatch === undefined) throw new Error("missing delivery dispatch");
        return dispatch(async (directive: AgentRuntimeDeliveryDirective) => {
          directives.push(directive);
          return testReceipt();
        });
      }),
    };
    const runtime = new AgentRuntime(
      { ...ports(session, output), progress },
      {
        clock: immediateClock,
      },
    );
    await runtime.start();
    const turn = runtime.enqueue(input);
    await vi.waitFor(() => expect(session.starts).toHaveLength(1));
    session.emit({
      method: "item/started",
      threadId: binding.threadId,
      turnId: "turn-1",
      itemId: "final",
      kind: "agentMessage",
    });
    session.emit({
      method: "item/completed",
      threadId: binding.threadId,
      turnId: "turn-1",
      itemId: "final",
      kind: "agentMessage",
      text: "[[discord_file:/repo/marker.txt]]",
    });
    session.emit({ method: "turn/completed", threadId: binding.threadId, turnId: "turn-1" });
    await turn;

    expect(output.sendText).not.toHaveBeenCalled();
    expect(output.sendFile).toHaveBeenCalledOnce();
    expect(directives).toEqual([{ replyToMessageId: input.messageId }]);
    expect(progress.terminal).toHaveBeenCalledWith(
      { channelId: input.channelId, messageId: input.messageId },
      { status: "completed", type: "terminal" },
    );
  });

  it("emits a failed terminal only after final receipt delivery fails", async () => {
    const session = new FakeSession();
    const progress = finalProgressPort();
    const sendGate = deferred<void>();
    const output: AgentRuntimeOutput = {
      sendText: vi.fn(async (_channelId, _messageId, _text, dispatch) => {
        if (dispatch === undefined) throw new Error("missing delivery dispatch");
        await dispatch(async () => {
          await sendGate.promise;
          throw new BridgeError("RUNTIME", "receipt uncertain");
        });
        return [];
      }),
    };
    const runtime = new AgentRuntime(
      { ...ports(session, output), progress },
      {
        clock: immediateClock,
      },
    );
    await runtime.start();
    const turn = runtime.enqueue(input);
    await vi.waitFor(() => expect(session.starts).toHaveLength(1));
    session.emit({
      method: "item/started",
      threadId: binding.threadId,
      turnId: "turn-1",
      itemId: "final",
      kind: "agentMessage",
    });
    session.emit({
      method: "item/completed",
      threadId: binding.threadId,
      turnId: "turn-1",
      itemId: "final",
      kind: "agentMessage",
      text: "Answer.",
    });
    session.emit({ method: "turn/completed", threadId: binding.threadId, turnId: "turn-1" });
    await vi.waitFor(() => expect(output.sendText).toHaveBeenCalledOnce());
    expect(progress.terminal).not.toHaveBeenCalled();

    sendGate.resolve();
    await expect(turn).rejects.toMatchObject({ code: "RUNTIME" });
    expect(progress.terminal).toHaveBeenCalledExactlyOnceWith(
      { channelId: input.channelId, messageId: input.messageId },
      {
        message: "Discord final delivery failed.",
        status: "failed",
        type: "terminal",
      },
    );
  });

  it("closes interrupted progress once when interrupt or stop ends an active turn", async () => {
    for (const action of ["interrupt", "stop"] as const) {
      const session = new FakeSession();
      const progress = finalProgressPort();
      const output = {
        sendText: vi.fn(async () => [testReceipt()]),
      } satisfies AgentRuntimeOutput;
      const runtime = new AgentRuntime(
        { ...ports(session, output), progress },
        {
          clock: immediateClock,
          stopTimeoutMs: 10,
        },
      );
      await runtime.start();
      const turn = runtime.enqueue(input);
      void turn.catch(() => undefined);
      await vi.waitFor(() => expect(session.starts).toHaveLength(1));

      if (action === "interrupt") {
        await runtime.interrupt();
        session.emit({
          method: "turn/completed",
          threadId: binding.threadId,
          turnId: "turn-1",
        });
        await turn;
        await runtime.stop();
      } else {
        await runtime.stop();
        await expect(turn).rejects.toMatchObject({ code: "TIMEOUT" });
      }

      expect(progress.terminal).toHaveBeenCalledExactlyOnceWith(
        { channelId: input.channelId, messageId: input.messageId },
        { status: "interrupted", type: "terminal" },
      );
    }
  });

  it("fails mismatched and terminal-late start-time file tool requests", async () => {
    const session = new FakeSession();
    const start = deferred<{ turnId: string }>();
    session.startTurnResult = start.promise;
    const output = {
      sendText: vi.fn(async () => [testReceipt()]),
      sendFile: vi.fn(async () => testReceipt()),
    } satisfies AgentRuntimeOutput;
    const runtime = new AgentRuntime(ports(session, output), { clock: immediateClock });
    await runtime.start();
    const turn = runtime.enqueue(input);
    await vi.waitFor(() => expect(session.starts).toHaveLength(1));

    const mismatched = session.requestSendFile({
      threadId: binding.threadId,
      turnId: "different-turn",
      callId: "call-mismatched",
      arguments: { path: "/repo/mismatched.txt" },
    });
    session.emit({
      method: "turn/completed",
      threadId: binding.threadId,
      turnId: "turn-1",
    });
    await expect(
      session.requestSendFile({
        threadId: binding.threadId,
        turnId: "turn-1",
        callId: "call-late",
        arguments: { path: "/repo/late.txt" },
      }),
    ).resolves.toMatchObject({ success: false });

    start.resolve({ turnId: "turn-1" });
    await expect(mismatched).resolves.toMatchObject({ success: false });
    await turn;
    expect(session.authorizeSendFile).not.toHaveBeenCalled();
  });

  it("fails a bounded start barrier without recovering the App Server session", async () => {
    const session = new FakeSession();
    const start = deferred<{ turnId: string }>();
    session.startTurnResult = start.promise;
    const output = { sendText: vi.fn(async () => [testReceipt()]) } satisfies AgentRuntimeOutput;
    const runtimePorts = ports(session, output);
    runtimePorts.appServer.stop = vi.fn(async () => undefined);
    const runtime = new AgentRuntime(runtimePorts, {
      clock: immediateClock,
      maxPendingStartEntries: 1,
    });
    await runtime.start();
    const turn = runtime.enqueue(input);
    await vi.waitFor(() => expect(session.starts).toHaveLength(1));

    session.emit({
      method: "item/started",
      threadId: binding.threadId,
      turnId: "turn-1",
      itemId: "one",
      kind: "agentMessage",
    });
    session.emit({
      method: "item/started",
      threadId: binding.threadId,
      turnId: "turn-1",
      itemId: "two",
      kind: "agentMessage",
    });

    await expect(turn).rejects.toMatchObject({ code: "RUNTIME" });
    expect(runtimePorts.appServer.stop).not.toHaveBeenCalled();
    start.resolve({ turnId: "turn-1" });
  });

  it("times out and cancels a pending start barrier with bounded cleanup", async () => {
    const timedSession = new FakeSession();
    timedSession.startTurnResult = new Promise(() => undefined);
    const timedRuntime = new AgentRuntime(
      ports(timedSession, { sendText: vi.fn(async () => [testReceipt()]) }),
      { clock: immediateClock, pendingStartTimeoutMs: 10 },
    );
    await timedRuntime.start();
    const timedTurn = timedRuntime.enqueue(input);
    await expect(timedTurn).rejects.toMatchObject({ code: "TIMEOUT" });

    const stoppedSession = new FakeSession();
    stoppedSession.startTurnResult = new Promise(() => undefined);
    const stoppedProgress = finalProgressPort();
    const stoppedRuntime = new AgentRuntime(
      {
        ...ports(stoppedSession, { sendText: vi.fn(async () => [testReceipt()]) }),
        progress: stoppedProgress,
      },
      { clock: immediateClock, pendingStartTimeoutMs: 1_000 },
    );
    await stoppedRuntime.start();
    const stoppedTurn = stoppedRuntime.enqueue(input);
    await vi.waitFor(() => expect(stoppedSession.starts).toHaveLength(1));
    await stoppedRuntime.stop();
    await expect(stoppedTurn).rejects.toMatchObject({ code: "CONFLICT" });
    expect(stoppedRuntime.state).toBe("stopped");
    expect(stoppedProgress.terminal).toHaveBeenCalledExactlyOnceWith(
      { channelId: input.channelId, messageId: input.messageId },
      { status: "interrupted", type: "terminal" },
    );
  });

  it("attributes only matching-thread warnings inside the active start generation", async () => {
    const session = new FakeSession();
    const start = deferred<{ turnId: string }>();
    session.startTurnResult = start.promise;
    const progress = progressPort();
    const output = { sendText: vi.fn(async () => [testReceipt()]) } satisfies AgentRuntimeOutput;
    const runtime = new AgentRuntime(
      { ...ports(session, output), progress },
      {
        clock: immediateClock,
      },
    );
    await runtime.start();
    const turn = runtime.enqueue(input);
    await vi.waitFor(() => expect(session.starts).toHaveLength(1));

    session.emit({
      method: "warning",
      progress: { type: "warning", message: "missing" },
    });
    session.emit({
      method: "warning",
      threadId: null,
      progress: { type: "warning", message: "null" },
    });
    session.emit({
      method: "warning",
      threadId: "different-thread",
      progress: { type: "warning", message: "mismatched" },
    });
    session.emit({
      method: "warning",
      threadId: binding.threadId,
      progress: { type: "warning", message: "matching" },
    });
    expect(progress.event).not.toHaveBeenCalled();

    start.resolve({ turnId: "turn-1" });
    await vi.waitFor(() => expect(progress.event).toHaveBeenCalledOnce());
    expect(progress.event).toHaveBeenCalledWith(
      { channelId: input.channelId, messageId: input.messageId },
      { type: "warning", message: "matching" },
    );
    session.emit({ method: "turn/completed", threadId: binding.threadId, turnId: "turn-1" });
    session.emit({
      method: "warning",
      threadId: binding.threadId,
      progress: { type: "warning", message: "late" },
    });
    await turn;
    expect(progress.event).toHaveBeenCalledOnce();
  });

  it("does not leak a late warning into the next source on the same session", async () => {
    const session = new FakeSession();
    const progress = progressPort();
    const output = { sendText: vi.fn(async () => [testReceipt()]) } satisfies AgentRuntimeOutput;
    const runtime = new AgentRuntime(
      { ...ports(session, output), progress },
      {
        clock: immediateClock,
      },
    );
    await runtime.start();

    const first = runtime.enqueue(input);
    await vi.waitFor(() => expect(session.starts).toHaveLength(1));
    session.emit({ method: "turn/completed", threadId: binding.threadId, turnId: "turn-1" });
    await first;

    const nextStart = deferred<{ turnId: string }>();
    session.startTurnResult = nextStart.promise;
    const secondInput = { ...input, messageId: "457", text: "second" };
    const second = runtime.enqueue(secondInput);
    await vi.waitFor(() => expect(session.starts).toHaveLength(2));
    session.emit({
      method: "warning",
      threadId: binding.threadId,
      progress: { type: "warning", message: "late previous warning" },
    });
    session.emit({
      method: "turn/started",
      threadId: binding.threadId,
      turnId: "turn-2",
    });
    session.emit({
      method: "warning",
      threadId: binding.threadId,
      progress: { type: "warning", message: "current warning" },
    });
    nextStart.resolve({ turnId: "turn-2" });
    await vi.waitFor(() => expect(progress.event).toHaveBeenCalledOnce());

    expect(progress.event).toHaveBeenCalledWith(
      { channelId: secondInput.channelId, messageId: secondInput.messageId },
      { type: "warning", message: "current warning" },
    );
    session.emit({ method: "turn/completed", threadId: binding.threadId, turnId: "turn-2" });
    await second;
  });

  it("discards failed-generation progress and tools before one recovered turn completes", async () => {
    const first = new FakeSession();
    const failedStart = deferred<{ turnId: string }>();
    first.startTurnResult = failedStart.promise;
    const recovered = new FakeSession();
    recovered.nextTurnId = "turn-recovered";
    const progress = progressPort();
    const output = {
      sendText: vi.fn(async () => [testReceipt()]),
      sendFile: vi.fn(async () => testReceipt()),
    } satisfies AgentRuntimeOutput;
    const server = {
      start: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(recovered),
      stop: vi.fn(async () => undefined),
    };
    const runtime = new AgentRuntime(
      { ...ports(first, output), appServer: server, progress },
      { clock: immediateClock, recoveryBaseDelayMs: 1 },
    );
    await runtime.start();
    const turn = runtime.enqueue(input);
    await vi.waitFor(() => expect(first.starts).toHaveLength(1));

    first.emit({
      method: "item/reasoning/summaryTextDelta",
      threadId: binding.threadId,
      turnId: "turn-failed",
      itemId: "reasoning-old",
      progress: { type: "reasoning", text: "old generation" },
    });
    first.emit({
      method: "warning",
      threadId: binding.threadId,
      progress: { type: "warning", message: "old warning" },
    });
    const oldTool = first.requestSendFile({
      threadId: binding.threadId,
      turnId: "turn-failed",
      callId: "call-old",
      arguments: { path: "/repo/old.txt" },
    });
    failedStart.reject(new BridgeError("RUNTIME", "transport failed"));

    await expect(oldTool).resolves.toMatchObject({ success: false });
    await vi.waitFor(() => expect(recovered.starts).toHaveLength(1));
    expect(progress.event).not.toHaveBeenCalled();
    recovered.emit({
      method: "warning",
      threadId: binding.threadId,
      progress: { type: "warning", message: "recovered warning" },
    });
    recovered.emit({
      method: "item/started",
      threadId: binding.threadId,
      turnId: "turn-recovered",
      itemId: "final-new",
      kind: "agentMessage",
      phase: "final_answer",
    });
    recovered.emit({
      method: "item/completed",
      threadId: binding.threadId,
      turnId: "turn-recovered",
      itemId: "final-new",
      kind: "agentMessage",
      phase: "final_answer",
      text: "Recovered answer.",
    });
    recovered.emit({
      method: "turn/completed",
      threadId: binding.threadId,
      turnId: "turn-recovered",
    });
    await turn;

    expect(output.sendText).toHaveBeenCalledExactlyOnceWith(
      input.channelId,
      input.messageId,
      "Recovered answer.",
    );
    expect(progress.event).toHaveBeenCalledExactlyOnceWith(
      { channelId: input.channelId, messageId: input.messageId },
      { type: "warning", message: "recovered warning" },
    );
    expect(progress.terminal).toHaveBeenCalledExactlyOnceWith(
      { channelId: input.channelId, messageId: input.messageId },
      { status: "completed", type: "terminal" },
    );
  });

  it("includes persisted Discord attachment paths in the App Server turn input", async () => {
    const session = new FakeSession();
    const output = { sendText: vi.fn(async () => [testReceipt()]) } satisfies AgentRuntimeOutput;
    const runtime = new AgentRuntime(ports(session, output), { clock: immediateClock });
    await runtime.start();
    const turn = runtime.enqueue({
      ...input,
      text: "",
      attachments: [
        {
          id: "123456789012345678",
          filename: "notes.txt",
          size: 5,
          contentType: "text/plain",
          localPath: "/tmp/inbox/batch/123456789012345678-notes.txt",
        },
      ],
    });
    await vi.waitFor(() => expect(session.starts).toHaveLength(1));

    expect(session.starts[0]).toContain("UNTRUSTED DISCORD ATTACHMENTS");
    expect(session.starts[0]).toContain("/tmp/inbox/batch/123456789012345678-notes.txt");
    session.emit({ method: "turn/completed", threadId: binding.threadId, turnId: "turn-1" });
    await turn;
  });

  it("accepts file tools only for the exact active thread and turn", async () => {
    const session = new FakeSession();
    const file = outboundFile("/repo/result.txt");
    session.authorizeSendFile.mockResolvedValue({ file, message: "result" });
    const output = {
      sendText: vi.fn(async () => [testReceipt()]),
      sendFile: vi.fn(
        async (
          _channelId: string,
          _messageId: string,
          _file: AuthorizedOutboundFile,
          _message?: string,
          _signal?: AbortSignal,
        ) => testReceipt(),
      ),
    } satisfies AgentRuntimeOutput;
    const runtime = new AgentRuntime(ports(session, output), { clock: immediateClock });
    await runtime.start();
    const request: AgentRuntimeSendFileRequest = {
      arguments: { path: file.canonicalPath, message: "result" },
      callId: "call-one",
      threadId: binding.threadId,
      turnId: "turn-1",
    };

    await expect(session.requestSendFile(request)).resolves.toMatchObject({ success: false });
    const turn = runtime.enqueue(input);
    await vi.waitFor(() => expect(session.starts).toHaveLength(1));
    await Promise.resolve();
    await expect(
      session.requestSendFile({ ...request, threadId: "wrong-thread" }),
    ).resolves.toMatchObject({ success: false });
    await expect(
      session.requestSendFile({ ...request, callId: "wrong-turn-call", turnId: "wrong-turn" }),
    ).resolves.toMatchObject({ success: false });
    await expect(session.requestSendFile(request)).resolves.toMatchObject({ success: true });

    expect(session.authorizeSendFile).toHaveBeenCalledExactlyOnceWith(
      binding.threadId,
      request.arguments,
    );
    expect(output.sendFile).toHaveBeenCalledExactlyOnceWith(
      input.channelId,
      input.messageId,
      file,
      "result",
      expect.any(AbortSignal),
    );
    session.emit({ method: "turn/completed", threadId: binding.threadId, turnId: "turn-1" });
    await expect(session.requestSendFile({ ...request, callId: "late" })).resolves.toMatchObject({
      success: false,
    });
    await turn;
    expect(file.close).toHaveBeenCalledOnce();
  });

  it("skips marker files already sent by the dynamic tool", async () => {
    const session = new FakeSession();
    const dynamicFile = outboundFile("/repo/result.txt");
    const duplicateMarker = outboundFile("/repo/result.txt");
    const markerFile = outboundFile("/repo/other.txt");
    session.authorizeSendFile.mockResolvedValue({ file: dynamicFile });
    session.parseFileMarkers.mockResolvedValue({
      visibleText: "done",
      files: [duplicateMarker, markerFile],
    });
    const output = {
      sendText: vi.fn(async () => [testReceipt()]),
      sendFile: vi.fn(
        async (
          _channelId: string,
          _messageId: string,
          _file: AuthorizedOutboundFile,
          _message?: string,
          _signal?: AbortSignal,
        ) => testReceipt(),
      ),
    } satisfies AgentRuntimeOutput;
    const runtime = new AgentRuntime(ports(session, output), { clock: immediateClock });
    await runtime.start();
    const turn = runtime.enqueue(input);
    await vi.waitFor(() => expect(session.starts).toHaveLength(1));
    await Promise.resolve();
    await session.requestSendFile({
      arguments: { path: dynamicFile.canonicalPath },
      callId: "call-one",
      threadId: binding.threadId,
      turnId: "turn-1",
    });
    session.emit({ method: "turn/completed", threadId: binding.threadId, turnId: "turn-1" });
    await turn;

    expect(output.sendFile).toHaveBeenCalledTimes(2);
    expect(output.sendFile.mock.calls[1]?.[2]).toBe(markerFile);
    expect(duplicateMarker.close).toHaveBeenCalledOnce();
    expect(markerFile.close).toHaveBeenCalledOnce();
  });

  it("rejects every new marker upload when the aggregate turn limit is exceeded", async () => {
    const session = new FakeSession();
    const dynamicFile = outboundFile("/repo/dynamic.txt");
    const markerFiles = Array.from({ length: 10 }, (_value, index) =>
      outboundFile(`/repo/marker-${String(index)}.txt`),
    );
    session.authorizeSendFile.mockResolvedValue({ file: dynamicFile });
    session.parseFileMarkers.mockResolvedValue({ visibleText: "done", files: markerFiles });
    const output = {
      sendText: vi.fn(async () => [testReceipt()]),
      sendFile: vi.fn(async () => testReceipt()),
    } satisfies AgentRuntimeOutput;
    const runtime = new AgentRuntime(ports(session, output), { clock: immediateClock });
    await runtime.start();
    const turn = runtime.enqueue(input);
    await vi.waitFor(() => expect(session.starts).toHaveLength(1));
    await Promise.resolve();
    await session.requestSendFile({
      arguments: { path: dynamicFile.canonicalPath },
      callId: "call-one",
      threadId: binding.threadId,
      turnId: "turn-1",
    });

    session.emit({ method: "turn/completed", threadId: binding.threadId, turnId: "turn-1" });
    await expect(turn).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    expect(output.sendFile).toHaveBeenCalledOnce();
    expect(output.sendText).not.toHaveBeenCalled();
    markerFiles.forEach((file) => {
      expect(file.close).toHaveBeenCalledOnce();
    });
  });

  it("closes files and stops when a dynamic upload ignores cancellation", async () => {
    const session = new FakeSession();
    const file = outboundFile("/repo/stuck.txt");
    const lifecycle: string[] = [];
    file.close.mockImplementation(async () => {
      lifecycle.push("file-close");
    });
    session.authorizeSendFile.mockResolvedValue({ file });
    let uploadSignal: AbortSignal | undefined;
    const output: AgentRuntimeOutput = {
      sendText: vi.fn(async () => [testReceipt()]),
      sendFile: vi.fn(async (_channelId, _messageId, _file, _message, signal) => {
        uploadSignal = signal;
        return new Promise<DiscordDeliveryReceipt>(() => {});
      }),
    };
    const basePorts = ports(session, output);
    const runtimePorts: AgentRuntimePorts = {
      ...basePorts,
      appServer: {
        start: vi.fn(async () => session),
        stop: vi.fn(async () => {
          lifecycle.push("server-stop");
        }),
      },
    };
    const runtime = new AgentRuntime(runtimePorts, {
      clock: immediateClock,
      stopTimeoutMs: 1,
    });
    await runtime.start();
    const turn = runtime.enqueue(input);
    void turn.catch(() => undefined);
    await vi.waitFor(() => expect(session.starts).toHaveLength(1));
    await Promise.resolve();
    const request = session.requestSendFile({
      arguments: { path: file.canonicalPath },
      callId: "call-one",
      threadId: binding.threadId,
      turnId: "turn-1",
    });
    await vi.waitFor(() => expect(output.sendFile).toHaveBeenCalledOnce());

    await runtime.stop();

    expect(uploadSignal?.aborted).toBe(true);
    expect(file.close).toHaveBeenCalledOnce();
    expect(lifecycle).toEqual(["file-close", "server-stop"]);
    expect(runtime.state).toBe("stopped");
    await runtime.start();
    expect(runtime.state).toBe("running");
    await runtime.stop();
    void request;
  });

  it("rejects late file calls and settles a signal-aware upload during interrupt", async () => {
    const session = new FakeSession();
    const file = outboundFile("/repo/interrupt.txt");
    session.authorizeSendFile.mockResolvedValue({ file });
    const output: AgentRuntimeOutput = {
      sendText: vi.fn(async () => [testReceipt()]),
      sendFile: vi.fn(async (_channelId, _messageId, _file, _message, signal) => {
        return new Promise<DiscordDeliveryReceipt>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }),
    };
    const runtime = new AgentRuntime(ports(session, output), {
      clock: immediateClock,
      stopTimeoutMs: 10,
    });
    await runtime.start();
    const turn = runtime.enqueue(input);
    await vi.waitFor(() => expect(session.starts).toHaveLength(1));
    await Promise.resolve();
    const request = session.requestSendFile({
      arguments: { path: file.canonicalPath },
      callId: "call-one",
      threadId: binding.threadId,
      turnId: "turn-1",
    });
    await vi.waitFor(() => expect(output.sendFile).toHaveBeenCalledOnce());

    await runtime.interrupt();

    await expect(request).resolves.toMatchObject({ success: false });
    await expect(
      session.requestSendFile({
        arguments: { path: "/repo/late.txt" },
        callId: "late-call",
        threadId: binding.threadId,
        turnId: "turn-1",
      }),
    ).resolves.toMatchObject({ success: false });
    expect(session.authorizeSendFile).toHaveBeenCalledOnce();
    expect(file.close).toHaveBeenCalledOnce();
    session.emit({ method: "turn/completed", threadId: binding.threadId, turnId: "turn-1" });
    await turn;
  });

  it("aborts and closes a marker file when its upload never settles during stop", async () => {
    const session = new FakeSession();
    const markerFile = outboundFile("/repo/stuck-marker.txt");
    session.parseFileMarkers.mockResolvedValue({ visibleText: "done", files: [markerFile] });
    let uploadSignal: AbortSignal | undefined;
    const output: AgentRuntimeOutput = {
      sendText: vi.fn(async () => [testReceipt()]),
      sendFile: vi.fn(async (_channelId, _messageId, _file, _message, signal) => {
        uploadSignal = signal;
        return new Promise<DiscordDeliveryReceipt>(() => {});
      }),
    };
    const runtime = new AgentRuntime(ports(session, output), {
      clock: immediateClock,
      stopTimeoutMs: 1,
    });
    await runtime.start();
    const turn = runtime.enqueue(input);
    void turn.catch(() => undefined);
    await vi.waitFor(() => expect(session.starts).toHaveLength(1));
    session.emit({ method: "turn/completed", threadId: binding.threadId, turnId: "turn-1" });
    await vi.waitFor(() => expect(output.sendFile).toHaveBeenCalledOnce());

    await runtime.stop();

    expect(uploadSignal?.aborted).toBe(true);
    expect(markerFile.close).toHaveBeenCalledOnce();
    expect(runtime.state).toBe("stopped");
  });

  it("resumes the exact registry-bound thread during startup", async () => {
    const session = new FakeSession();
    const output = { sendText: vi.fn(async () => [testReceipt()]) } satisfies AgentRuntimeOutput;
    const runtime = new AgentRuntime(ports(session, output), { clock: immediateClock });

    await runtime.start();

    expect(session.resumes).toEqual([binding.threadId]);
    expect(session.listModelCalls).toBe(1);
    expect(runtime.listModels()).toEqual([
      {
        id: "sol-id",
        displayName: "Sol",
        isDefault: true,
        isCurrent: true,
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: ["low", "high"],
      },
      {
        id: "luna-id",
        displayName: "Luna",
        isDefault: false,
        isCurrent: false,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["medium", "high"],
      },
      {
        id: "mini-id",
        displayName: "Mini",
        isDefault: false,
        isCurrent: false,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["medium"],
      },
    ]);
    expect(runtime.state).toBe("running");
  });

  it("formats, correlates, and delivers only the completed originating turn", async () => {
    const session = new FakeSession();
    const output = { sendText: vi.fn(async () => [testReceipt()]) } satisfies AgentRuntimeOutput;
    const runtime = new AgentRuntime(ports(session, output), { clock: immediateClock });
    await runtime.start();
    const queued = runtime.enqueue(input);
    await vi.waitFor(() => expect(session.starts).toHaveLength(1));
    expect(session.turnSettings).toEqual([{ model: "sol-request", effort: "low" }]);
    session.emit({
      method: "item/started",
      threadId: binding.threadId,
      turnId: "other",
      itemId: "x",
      kind: "agentMessage",
    });
    session.emit({
      method: "item/started",
      threadId: binding.threadId,
      turnId: "turn-1",
      itemId: "item-1",
      kind: "agentMessage",
    });
    session.emit({
      method: "item/agentMessage/delta",
      threadId: binding.threadId,
      turnId: "other",
      itemId: "x",
      delta: "ignore",
    });
    session.emit({
      method: "item/agentMessage/delta",
      threadId: binding.threadId,
      turnId: "turn-1",
      itemId: "item-1",
      delta: "hello",
    });
    session.emit({
      method: "item/completed",
      threadId: binding.threadId,
      turnId: "turn-1",
      itemId: "item-1",
      kind: "agentMessage",
      text: "hello world",
    });
    session.emit({ method: "turn/completed", threadId: binding.threadId, turnId: "turn-1" });
    await queued;

    expect(output.sendText).toHaveBeenCalledWith(
      "123",
      "456",
      expect.stringContaining("hello world"),
    );
  });

  it("resolves binding and workspace model settings into every turn", async () => {
    const output = { sendText: vi.fn(async () => [testReceipt()]) } satisfies AgentRuntimeOutput;

    for (const [configuredBinding, expected] of [
      [
        { ...binding, modelId: "luna-id", reasoningEffort: "high" },
        { model: "luna-request", effort: "high" },
      ],
      [
        { ...binding, workspace: { ...profile, model: "luna-request" } },
        { model: "luna-request", effort: "medium" },
      ],
    ] as const) {
      const session = new FakeSession();
      const harness = configurablePorts(session, output, configuredBinding);
      const runtime = new AgentRuntime(harness.ports, { clock: immediateClock });
      await runtime.start();
      const turn = runtime.enqueue(input);
      await vi.waitFor(() => expect(session.starts).toHaveLength(1));
      expect(session.turnSettings).toEqual([expected]);
      session.emit({
        method: "turn/completed",
        threadId: configuredBinding.threadId,
        turnId: "turn-1",
      });
      await turn;
      await runtime.stop();
    }
  });

  it("starts with stale settings, exposes the error, and blocks only user turns", async () => {
    const session = new FakeSession();
    const output = { sendText: vi.fn(async () => [testReceipt()]) } satisfies AgentRuntimeOutput;
    const harness = configurablePorts(session, output, {
      ...binding,
      modelId: "missing-id",
      reasoningEffort: "ultra",
    });
    const runtime = new AgentRuntime(harness.ports, { clock: immediateClock });

    await runtime.start();

    expect(runtime.state).toBe("running");
    expect(runtime.modelStatus()).toMatchObject({
      configuredModelId: "missing-id",
      configuredReasoningEffort: "ultra",
      configurationError: expect.any(String),
    });
    await expect(runtime.enqueue(input)).rejects.toMatchObject({ code: "CONFIGURATION" });
    expect(session.starts).toHaveLength(0);

    await expect(runtime.setReasoningEffort({ kind: "default" })).resolves.toMatchObject({
      configuredModelId: "missing-id",
      configurationError: expect.any(String),
    });
    await expect(runtime.setModel({ kind: "default" })).resolves.toMatchObject({
      effective: { modelId: "sol-id", reasoningEffort: "low" },
    });
    expect(harness.current()).not.toHaveProperty("modelId");
    expect(harness.current()).not.toHaveProperty("reasoningEffort");
  });

  it("replaces stale effort and preserves or clears it atomically across model changes", async () => {
    const session = new FakeSession();
    const output = { sendText: vi.fn(async () => [testReceipt()]) } satisfies AgentRuntimeOutput;
    const harness = configurablePorts(session, output, {
      ...binding,
      modelId: "sol-id",
      reasoningEffort: "ultra",
    });
    const runtime = new AgentRuntime(harness.ports, { clock: immediateClock });
    await runtime.start();

    await expect(
      runtime.setReasoningEffort({ kind: "effort", value: "high" }),
    ).resolves.toMatchObject({ effective: { modelId: "sol-id", reasoningEffort: "high" } });
    await expect(runtime.setModel({ kind: "model", id: "luna-id" })).resolves.toMatchObject({
      effective: { modelId: "luna-id", reasoningEffort: "high" },
    });
    await expect(runtime.setModel({ kind: "model", id: "mini-id" })).resolves.toMatchObject({
      effective: {
        modelId: "mini-id",
        reasoningEffort: "medium",
        reasoningSource: "model-default",
      },
    });
    expect(harness.current()).toMatchObject({ modelId: "mini-id" });
    expect(harness.current()).not.toHaveProperty("reasoningEffort");
    expect(harness.update).toHaveBeenLastCalledWith(binding.id, { modelId: "mini-id" });
  });

  it("rejects an unsupported requested effort as invalid input without persistence", async () => {
    const session = new FakeSession();
    const output = { sendText: vi.fn(async () => [testReceipt()]) } satisfies AgentRuntimeOutput;
    const harness = configurablePorts(session, output, binding);
    const runtime = new AgentRuntime(harness.ports, { clock: immediateClock });
    await runtime.start();

    await expect(
      runtime.setReasoningEffort({ kind: "effort", value: "ultra" }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(harness.update).not.toHaveBeenCalled();
  });

  it("rejects controls while turns exist and synchronously gates enqueues during controls", async () => {
    const activeSession = new FakeSession();
    const output = { sendText: vi.fn(async () => [testReceipt()]) } satisfies AgentRuntimeOutput;
    const activeHarness = configurablePorts(activeSession, output, binding);
    const activeRuntime = new AgentRuntime(activeHarness.ports, { clock: immediateClock });
    await activeRuntime.start();
    const activeTurn = activeRuntime.enqueue(input);
    await vi.waitFor(() => expect(activeSession.starts).toHaveLength(1));
    await expect(activeRuntime.setModel({ kind: "model", id: "luna-id" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    activeSession.emit({
      method: "turn/completed",
      threadId: binding.threadId,
      turnId: "turn-1",
    });
    await activeTurn;

    const session = new FakeSession();
    const harness = configurablePorts(session, output, binding);
    const entered = deferred();
    const release = deferred();
    let updateCalls = 0;
    harness.ports.registry.updateModelSettings = vi.fn(async (id, settings) => {
      updateCalls += 1;
      if (updateCalls === 1) {
        entered.resolve();
        await release.promise;
      }
      return harness.update(id, settings);
    });
    const runtime = new AgentRuntime(harness.ports, { clock: immediateClock });
    await runtime.start();

    const modelChange = runtime.setModel({ kind: "model", id: "luna-id" });
    const effortChange = runtime.setReasoningEffort({ kind: "effort", value: "high" });
    expect(() => runtime.enqueue(input)).toThrow(expect.objectContaining({ code: "CONFLICT" }));
    await entered.promise;
    release.resolve();
    await expect(Promise.all([modelChange, effortChange])).resolves.toHaveLength(2);
    expect(harness.update.mock.calls).toEqual([
      [binding.id, { modelId: "luna-id" }],
      [binding.id, { modelId: "luna-id", reasoningEffort: "high" }],
    ]);

    const accepted = runtime.enqueue(input);
    await vi.waitFor(() => expect(session.starts).toHaveLength(1));
    expect(session.turnSettings).toEqual([{ model: "luna-request", effort: "high" }]);
    session.emit({ method: "turn/completed", threadId: binding.threadId, turnId: "turn-1" });
    await accepted;
  });

  it("keeps in-memory settings unchanged when registry persistence fails", async () => {
    const session = new FakeSession();
    const output = { sendText: vi.fn(async () => [testReceipt()]) } satisfies AgentRuntimeOutput;
    const harness = configurablePorts(session, output, binding);
    harness.ports.registry.updateModelSettings = async () => {
      throw new BridgeError("RUNTIME", "registry failed");
    };
    const runtime = new AgentRuntime(harness.ports, { clock: immediateClock });
    await runtime.start();

    await expect(runtime.setModel({ kind: "model", id: "luna-id" })).rejects.toMatchObject({
      code: "RUNTIME",
    });
    expect(runtime.modelStatus()).toMatchObject({
      effective: { modelId: "sol-id", reasoningEffort: "low" },
    });
    const turn = runtime.enqueue(input);
    await vi.waitFor(() => expect(session.starts).toHaveLength(1));
    session.emit({ method: "turn/completed", threadId: binding.threadId, turnId: "turn-1" });
    await turn;
  });

  it("interrupts the exact active turn without disturbing queued FIFO work", async () => {
    const session = new FakeSession();
    const output = { sendText: vi.fn(async () => [testReceipt()]) } satisfies AgentRuntimeOutput;
    const runtime = new AgentRuntime(ports(session, output), { clock: immediateClock });
    await runtime.start();
    const first = runtime.enqueue(input);
    const second = runtime.enqueue({ ...input, messageId: "999", text: "second" });
    await vi.waitFor(() => expect(session.starts).toHaveLength(1));
    await runtime.interrupt();
    expect(session.interrupts).toEqual([[binding.threadId, "turn-1"]]);
    session.emit({ method: "turn/completed", threadId: binding.threadId, turnId: "turn-1" });
    await first;
    await vi.waitFor(() => expect(session.starts).toHaveLength(2));
    expect(session.starts[1]).toContain("second");
    session.emit({ method: "turn/completed", threadId: binding.threadId, turnId: "turn-1" });
    await second;
  });

  it("fails startup on exact-thread resume errors without creating a fallback thread", async () => {
    const session = new FakeSession();
    session.resume = async () => {
      throw new BridgeError("NOT_FOUND", "bound thread missing");
    };
    const output = { sendText: vi.fn(async () => [testReceipt()]) } satisfies AgentRuntimeOutput;
    const server = { start: vi.fn(async () => session), stop: vi.fn(async () => undefined) };
    const runtime = new AgentRuntime(
      { ...ports(session, output), appServer: server },
      { clock: immediateClock },
    );

    await expect(runtime.start()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(session.starts).toEqual([]);
    expect(server.start).toHaveBeenCalledOnce();
    expect(runtime.state).toBe("failed");
  });

  it("fails startup clearly when the App Server session has no model catalog port", async () => {
    const session = new FakeSession();
    (session as unknown as { listModels?: unknown }).listModels = undefined;
    const output = { sendText: vi.fn(async () => [testReceipt()]) } satisfies AgentRuntimeOutput;
    const server = { start: vi.fn(async () => session), stop: vi.fn(async () => undefined) };
    const runtime = new AgentRuntime(
      { ...ports(session, output), appServer: server },
      { clock: immediateClock },
    );

    await expect(runtime.start()).rejects.toMatchObject({ code: "CONFIGURATION" });
    expect(server.stop).toHaveBeenCalledOnce();
  });

  it("fails controls clearly when the registry model settings port is unavailable", async () => {
    const session = new FakeSession();
    const output = { sendText: vi.fn(async () => [testReceipt()]) } satisfies AgentRuntimeOutput;
    const runtimePorts = ports(session, output);
    (runtimePorts.registry as unknown as { updateModelSettings?: unknown }).updateModelSettings =
      undefined;
    const runtime = new AgentRuntime(runtimePorts, { clock: immediateClock });
    await runtime.start();

    await expect(runtime.setModel({ kind: "model", id: "luna-id" })).rejects.toMatchObject({
      code: "CONFIGURATION",
    });
  });

  it("closes retained outbound files exactly once when Discord upload fails", async () => {
    const session = new FakeSession();
    let closes = 0;
    const file = {
      canonicalPath: "/repo/out.txt",
      displayFilename: "out.txt",
      size: 3,
      isClosed: false,
      createReadStream: () => {
        throw new Error("unused");
      },
      close: async () => {
        closes += 1;
      },
      [Symbol.asyncDispose]: async () => {
        closes += 1;
      },
    };
    const secondFile = {
      ...file,
      canonicalPath: "/repo/second.txt",
      displayFilename: "second.txt",
    };
    const output: AgentRuntimeOutput = {
      sendText: vi.fn(async () => [testReceipt()]),
      sendFile: vi.fn(async () => {
        throw new Error("discord unavailable");
      }),
    };
    const runtime = new AgentRuntime(ports(session, output), { clock: immediateClock });
    await runtime.start();
    const turn = runtime.enqueue(input);
    await vi.waitFor(() => expect(session.starts).toHaveLength(1));
    session.emit({
      method: "item/started",
      threadId: binding.threadId,
      turnId: "turn-1",
      itemId: "item-1",
      kind: "agentMessage",
    });
    session.emit({
      method: "item/completed",
      threadId: binding.threadId,
      turnId: "turn-1",
      itemId: "item-1",
      kind: "agentMessage",
      files: [file, file, secondFile],
    });
    session.emit({ method: "turn/completed", threadId: binding.threadId, turnId: "turn-1" });
    await expect(turn).rejects.toThrow("discord unavailable");
    expect(closes).toBe(2);
  });

  it("closes retained files when text delivery fails", async () => {
    const session = new FakeSession();
    let closes = 0;
    const file = {
      canonicalPath: "/repo/out.txt",
      displayFilename: "out.txt",
      size: 3,
      isClosed: false,
      createReadStream: () => {
        throw new Error("unused");
      },
      close: async () => {
        closes += 1;
      },
      [Symbol.asyncDispose]: async () => {
        closes += 1;
      },
    };
    const output: AgentRuntimeOutput = {
      sendText: vi.fn(async () => {
        throw new Error("text unavailable");
      }),
    };
    const runtime = new AgentRuntime(ports(session, output), { clock: immediateClock });
    await runtime.start();
    const turn = runtime.enqueue(input);
    await vi.waitFor(() => expect(session.starts).toHaveLength(1));
    session.emit({
      method: "item/started",
      threadId: binding.threadId,
      turnId: "turn-1",
      itemId: "item-1",
      kind: "agentMessage",
    });
    session.emit({
      method: "item/completed",
      threadId: binding.threadId,
      turnId: "turn-1",
      itemId: "item-1",
      kind: "agentMessage",
      text: "text",
      files: [file],
    });
    session.emit({ method: "turn/completed", threadId: binding.threadId, turnId: "turn-1" });
    await expect(turn).rejects.toThrow("text unavailable");
    expect(closes).toBe(1);
  });

  it("correlates started agent items, uses authoritative item text, preserves order, and bounds total output", async () => {
    const session = new FakeSession();
    const output = { sendText: vi.fn(async () => [testReceipt()]) } satisfies AgentRuntimeOutput;
    const runtime = new AgentRuntime(ports(session, output), {
      clock: immediateClock,
      maxBufferCharacters: 20,
    });
    await runtime.start();
    const turn = runtime.enqueue(input);
    await vi.waitFor(() => expect(session.starts).toHaveLength(1));
    session.emit({
      method: "item/agentMessage/delta",
      threadId: binding.threadId,
      turnId: "turn-1",
      itemId: "unstarted",
      delta: "ignored",
    });
    session.emit({
      method: "item/started",
      threadId: binding.threadId,
      turnId: "turn-1",
      itemId: "item-1",
      kind: "agentMessage",
    });
    session.emit({
      method: "item/started",
      threadId: binding.threadId,
      turnId: "turn-1",
      itemId: "item-2",
      kind: "agentMessage",
    });
    session.emit({
      method: "item/agentMessage/delta",
      threadId: binding.threadId,
      turnId: "turn-1",
      itemId: "item-1",
      delta: "draft",
    });
    session.emit({
      method: "item/completed",
      threadId: binding.threadId,
      turnId: "turn-1",
      itemId: "item-1",
      kind: "agentMessage",
      text: "one",
    });
    session.emit({
      method: "item/agentMessage/delta",
      threadId: binding.threadId,
      turnId: "turn-1",
      itemId: "item-2",
      delta: "two",
    });
    session.emit({
      method: "item/completed",
      threadId: binding.threadId,
      turnId: "turn-1",
      itemId: "item-2",
      kind: "agentMessage",
      text: "two-final",
    });
    session.emit({
      method: "item/agentMessage/delta",
      threadId: binding.threadId,
      turnId: "turn-1",
      itemId: "item-3",
      delta: "ignored",
    });
    session.emit({ method: "turn/completed", threadId: binding.threadId, turnId: "turn-1" });
    await turn;

    const delivered = (output.sendText.mock.calls as unknown as Array<[string, string, string]>)
      .map((call) => call[2])
      .join("");
    expect(delivered).toContain("one");
    expect(delivered).toContain("two-final");
    expect(delivered).not.toContain("draft");
    expect(delivered).not.toContain("ignored");
    expect(delivered.indexOf("one")).toBeLessThan(delivered.indexOf("two-final"));
    expect(delivered.length).toBeLessThanOrEqual(20);
  });

  it("delivers and settles a completed turn exactly once", async () => {
    const session = new FakeSession();
    const output = { sendText: vi.fn(async () => [testReceipt()]) } satisfies AgentRuntimeOutput;
    const runtime = new AgentRuntime(ports(session, output), { clock: immediateClock });
    await runtime.start();
    const turn = runtime.enqueue(input);
    await vi.waitFor(() => expect(session.starts).toHaveLength(1));
    session.emit({
      method: "item/started",
      threadId: binding.threadId,
      turnId: "turn-1",
      itemId: "item-1",
      kind: "agentMessage",
    });
    session.emit({
      method: "item/completed",
      threadId: binding.threadId,
      turnId: "turn-1",
      itemId: "item-1",
      kind: "agentMessage",
      text: "once",
    });
    session.emit({ method: "turn/completed", threadId: binding.threadId, turnId: "turn-1" });
    session.emit({ method: "turn/completed", threadId: binding.threadId, turnId: "turn-1" });
    await turn;
    await Promise.resolve();
    expect(output.sendText).toHaveBeenCalledOnce();
  });

  it("recovers one transport failure by restarting and resuming the same bound thread", async () => {
    const first = new FakeSession();
    first.startTurnError = new BridgeError("RUNTIME", "transport failed");
    const recovered = new FakeSession();
    const output = { sendText: vi.fn(async () => [testReceipt()]) } satisfies AgentRuntimeOutput;
    const server = {
      start: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(recovered),
      stop: vi.fn(async () => undefined),
    };
    const runtime = new AgentRuntime(
      { ...ports(first, output), appServer: server },
      { clock: immediateClock, recoveryBaseDelayMs: 1 },
    );
    await runtime.start();
    const turn = runtime.enqueue(input);
    await vi.waitFor(() => expect(recovered.starts).toHaveLength(1));
    expect(server.stop).toHaveBeenCalledOnce();
    expect(first.listModelCalls).toBe(1);
    expect(recovered.listModelCalls).toBe(1);
    expect(recovered.resumes).toEqual([binding.threadId]);
    expect(recovered.turnSettings).toEqual([{ model: "sol-request", effort: "low" }]);
    recovered.emit({ method: "turn/completed", threadId: binding.threadId, turnId: "turn-1" });
    await turn;
  });

  it("bounds recovery attempts and fails when the registry binding changes", async () => {
    const session = new FakeSession();
    session.startTurnError = new BridgeError("RUNTIME", "transport failed");
    const changed = { ...binding, threadId: "44444444-4444-4444-8444-444444444444" };
    let reads = 0;
    const output = { sendText: vi.fn(async () => [testReceipt()]) } satisfies AgentRuntimeOutput;
    const base = ports(session, output);
    base.registry.readBinding = async () => (reads++ === 0 ? binding : changed);
    const server = { start: vi.fn(async () => session), stop: vi.fn(async () => undefined) };
    const runtime = new AgentRuntime(
      { ...base, appServer: server },
      { clock: immediateClock, maxRecoveryAttempts: 4 },
    );
    await runtime.start();
    await expect(runtime.enqueue(input)).rejects.toMatchObject({ code: "RUNTIME" });
    expect(runtime.state).toBe("failed");
    expect(server.start).toHaveBeenCalledOnce();
  });

  it("fails recovery when the workspace model changes behind the active runtime", async () => {
    const first = new FakeSession();
    first.startTurnError = new BridgeError("RUNTIME", "transport failed");
    const recovered = new FakeSession();
    const changed = {
      ...binding,
      workspace: { ...binding.workspace, model: "luna-request" },
    };
    let reads = 0;
    const output = { sendText: vi.fn(async () => [testReceipt()]) } satisfies AgentRuntimeOutput;
    const base = ports(first, output);
    base.registry.readBinding = async () => (reads++ === 0 ? binding : changed);
    const server = {
      start: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(recovered),
      stop: vi.fn(async () => undefined),
    };
    const runtime = new AgentRuntime(
      { ...base, appServer: server },
      { clock: immediateClock, maxRecoveryAttempts: 1 },
    );
    await runtime.start();

    await expect(runtime.enqueue(input)).rejects.toMatchObject({ code: "RUNTIME" });
    expect(runtime.state).toBe("failed");
    expect(server.start).toHaveBeenCalledOnce();
    expect(recovered.starts).toHaveLength(0);
  });

  it("stops with bounded cleanup and rejects the active turn after timeout", async () => {
    const session = new FakeSession();
    const output = { sendText: vi.fn(async () => [testReceipt()]) } satisfies AgentRuntimeOutput;
    const runtime = new AgentRuntime(ports(session, output), {
      clock: immediateClock,
      stopTimeoutMs: 1,
    });
    await runtime.start();
    const active = runtime.enqueue(input);
    await vi.waitFor(() => expect(session.starts).toHaveLength(1));
    await runtime.stop();
    await expect(active).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(runtime.state).toBe("stopped");
  });

  it("refuses unconfirmed replacement with active or queued work", async () => {
    const session = new FakeSession();
    const output = { sendText: vi.fn(async () => [testReceipt()]) } satisfies AgentRuntimeOutput;
    const runtime = new AgentRuntime(ports(session, output), { clock: immediateClock });
    await runtime.start();
    runtime.enqueue(input);
    await vi.waitFor(() => expect(session.starts).toHaveLength(1));
    await expect(runtime.newSession(false, "creation-key")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(session.creationKey).toBeUndefined();
  });

  it("confirm replacement interrupts, discards pending visibly, and uses the durable key", async () => {
    const session = new FakeSession();
    const progress = finalProgressPort();
    const output = {
      sendText: vi.fn(async () => [testReceipt()]),
      report: vi.fn(async () => undefined),
    } satisfies AgentRuntimeOutput;
    const runtime = new AgentRuntime(
      { ...ports(session, output), progress },
      {
        clock: immediateClock,
      },
    );
    await runtime.start();
    const active = runtime.enqueue(input);
    const pending = runtime.enqueue({ ...input, messageId: "999" });
    await vi.waitFor(() => expect(session.starts).toHaveLength(1));
    const replacement = runtime.newSession(true, "creation-key");
    session.emit({ method: "turn/completed", threadId: binding.threadId, turnId: "turn-1" });
    await expect(active).resolves.toBeUndefined();
    await expect(pending).rejects.toMatchObject({ reason: "session replaced" });
    await expect(replacement).resolves.toMatchObject({ threadId: session.nextThreadId });
    expect(session.interrupts).toEqual([[binding.threadId, "turn-1"]]);
    expect(session.creationKey).toBe("creation-key");
    expect(progress.terminal).toHaveBeenCalledWith(
      { channelId: input.channelId, messageId: "999" },
      { status: "interrupted", type: "terminal" },
    );
  });

  it("keeps agent model settings when replacing the Codex thread", async () => {
    const session = new FakeSession();
    const output = { sendText: vi.fn(async () => [testReceipt()]) } satisfies AgentRuntimeOutput;
    const harness = configurablePorts(session, output, binding);
    const runtime = new AgentRuntime(harness.ports, { clock: immediateClock });
    await runtime.start();
    await runtime.setModel({ kind: "model", id: "luna-id" });

    await expect(runtime.newSession(true, "creation-key")).resolves.toEqual({
      threadId: session.nextThreadId,
    });
    expect(runtime.modelStatus()).toMatchObject({
      effective: { modelId: "luna-id", reasoningEffort: "medium" },
    });
    const turn = runtime.enqueue(input);
    await vi.waitFor(() => expect(session.starts).toHaveLength(1));
    expect(session.turnSettings).toEqual([{ model: "luna-request", effort: "medium" }]);
    session.emit({
      method: "turn/completed",
      threadId: session.nextThreadId,
      turnId: "turn-1",
    });
    await turn;
  });

  it("does not create a replacement when the active turn misses the confirmation timeout", async () => {
    const session = new FakeSession();
    const output = { sendText: vi.fn(async () => [testReceipt()]) } satisfies AgentRuntimeOutput;
    const runtime = new AgentRuntime(ports(session, output), {
      clock: immediateClock,
      stopTimeoutMs: 1,
    });
    await runtime.start();
    const active = runtime.enqueue(input);
    await vi.waitFor(() => expect(session.starts).toHaveLength(1));
    await expect(runtime.newSession(true, "creation-key")).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    expect(session.creationKey).toBeUndefined();
    expect(session.interrupts).toEqual([[binding.threadId, "turn-1"]]);
    session.emit({ method: "turn/completed", threadId: binding.threadId, turnId: "turn-1" });
    await expect(active).resolves.toBeUndefined();
    const afterTimeout = runtime.enqueue({ ...input, messageId: "999" });
    await vi.waitFor(() => expect(session.starts).toHaveLength(2));
    session.emit({ method: "turn/completed", threadId: binding.threadId, turnId: "turn-1" });
    await expect(afterTimeout).resolves.toBeUndefined();
  });

  it("unpauses and preserves the old binding when creation or registry commit fails", async () => {
    const session = new FakeSession();
    session.start = async () => {
      throw new BridgeError("RUNTIME", "create failed");
    };
    const output = { sendText: vi.fn(async () => [testReceipt()]) } satisfies AgentRuntimeOutput;
    const runtime = new AgentRuntime(ports(session, output), { clock: immediateClock });
    await runtime.start();
    await expect(runtime.newSession(true, "creation-key")).rejects.toMatchObject({
      code: "RUNTIME",
    });
    expect(() => runtime.enqueue(input)).not.toThrow();

    const committedFailure = new FakeSession();
    const replacementPorts = ports(committedFailure, output);
    replacementPorts.registry.replaceThread = async () => {
      throw new BridgeError("RUNTIME", "registry failed");
    };
    const runtime2 = new AgentRuntime(replacementPorts, { clock: immediateClock });
    await runtime2.start();
    await expect(runtime2.newSession(true, "creation-key")).rejects.toBeInstanceOf(
      AgentRuntimeSessionError,
    );
    expect(() => runtime2.enqueue(input)).not.toThrow();
  });

  it("keeps the committed binding and recovers the new thread when post-commit resume fails", async () => {
    const session = new FakeSession();
    const recovered = new FakeSession();
    const nextBinding = { ...binding, threadId: session.nextThreadId };
    const originalResume = session.resume.bind(session);
    session.resume = async (threadId, workspace, inbox) => {
      if (threadId === nextBinding.threadId) throw new BridgeError("RUNTIME", "resume failed");
      await originalResume(threadId, workspace, inbox);
    };
    const output = { sendText: vi.fn(async () => [testReceipt()]) } satisfies AgentRuntimeOutput;
    const base = ports(session, output);
    base.registry.readBinding = vi.fn(async () =>
      session.resumes.length === 0 ? binding : nextBinding,
    );
    base.registry.replaceThread = vi.fn(async () => nextBinding);
    const server = {
      start: vi.fn().mockResolvedValueOnce(session).mockResolvedValueOnce(recovered),
      stop: vi.fn(async () => undefined),
    };
    const runtime = new AgentRuntime({ ...base, appServer: server }, { clock: immediateClock });
    await runtime.start();
    await expect(runtime.newSession(true, "creation-key")).resolves.toEqual({
      threadId: nextBinding.threadId,
    });
    expect(runtime.state).toBe("running");
    expect(recovered.resumes).toEqual([nextBinding.threadId]);
    const turn = runtime.enqueue(input);
    await vi.waitFor(() => expect(recovered.starts).toHaveLength(1));
    recovered.emit({
      method: "item/started",
      threadId: nextBinding.threadId,
      turnId: "turn-1",
      itemId: "item-1",
      kind: "agentMessage",
    });
    recovered.emit({
      method: "item/completed",
      threadId: nextBinding.threadId,
      turnId: "turn-1",
      itemId: "item-1",
      kind: "agentMessage",
      text: "recovered",
    });
    recovered.emit({ method: "turn/completed", threadId: nextBinding.threadId, turnId: "turn-1" });
    await turn;
  });

  it("reports orphan threads with the exact ID without masking the typed error", async () => {
    const session = new FakeSession();
    const orphan = vi.fn(async () => {
      throw new Error("report failed");
    });
    const output = {
      sendText: vi.fn(async () => [testReceipt()]),
      reportOrphanThread: orphan,
    } satisfies AgentRuntimeOutput;
    const runtimePorts = ports(session, output);
    runtimePorts.registry.replaceThread = async () => {
      throw new BridgeError("RUNTIME", "registry failed");
    };
    const runtime = new AgentRuntime(runtimePorts, { clock: immediateClock });
    await runtime.start();
    await expect(runtime.newSession(true, "creation-key")).rejects.toMatchObject({
      name: "AgentRuntimeSessionError",
      orphanThreadId: session.nextThreadId,
    });
    expect(orphan).toHaveBeenCalledWith(session.nextThreadId);
  });

  it("cleans up a started server when startup resume or state marking fails", async () => {
    const session = new FakeSession();
    session.resume = async () => {
      throw new BridgeError("NOT_FOUND", "missing");
    };
    const output = { sendText: vi.fn(async () => [testReceipt()]) } satisfies AgentRuntimeOutput;
    const server = { start: vi.fn(async () => session), stop: vi.fn(async () => undefined) };
    const runtime = new AgentRuntime(
      { ...ports(session, output), appServer: server },
      { clock: immediateClock },
    );
    await expect(runtime.start()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(server.stop).toHaveBeenCalledOnce();

    const second = new FakeSession();
    const secondServer = { start: vi.fn(async () => second), stop: vi.fn(async () => undefined) };
    const secondPorts = ports(second, output);
    secondPorts.registry.markState = vi.fn(async (state) => {
      if (state === "running") throw new Error("state failed");
    });
    const runtime2 = new AgentRuntime(
      { ...secondPorts, appServer: secondServer },
      { clock: immediateClock },
    );
    await expect(runtime2.start()).rejects.toMatchObject({ code: "RUNTIME" });
    expect(secondServer.stop).toHaveBeenCalledOnce();
  });

  it("still interrupts and stops when pending-turn reporting fails", async () => {
    const session = new FakeSession();
    const output = {
      sendText: vi.fn(async () => [testReceipt()]),
      report: vi.fn(async () => {
        throw new Error("report failed");
      }),
    } satisfies AgentRuntimeOutput;
    const server = { start: vi.fn(async () => session), stop: vi.fn(async () => undefined) };
    const runtime = new AgentRuntime(
      { ...ports(session, output), appServer: server },
      { clock: immediateClock },
    );
    await runtime.start();
    const active = runtime.enqueue(input);
    const pending = runtime.enqueue({ ...input, messageId: "999" });
    await vi.waitFor(() => expect(session.starts).toHaveLength(1));
    await runtime.stop();
    await expect(pending).rejects.toMatchObject({ reason: "runtime stopped" });
    await expect(active).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(session.interrupts).toEqual([[binding.threadId, "turn-1"]]);
    expect(server.stop).toHaveBeenCalledOnce();
  });

  it("cleans up completely when interrupt rejects during stop and throws only after cleanup", async () => {
    const session = new FakeSession();
    session.interrupt = async () => {
      throw new Error("interrupt transport failed");
    };
    const output = {
      sendText: vi.fn(async () => [testReceipt()]),
      report: vi.fn(async () => undefined),
    } satisfies AgentRuntimeOutput;
    const server = { start: vi.fn(async () => session), stop: vi.fn(async () => undefined) };
    const runtime = new AgentRuntime(
      { ...ports(session, output), appServer: server },
      { clock: immediateClock },
    );
    await runtime.start();
    const active = runtime.enqueue(input);
    const pending = runtime.enqueue({ ...input, messageId: "999" });
    const activeOutcome = active.catch((error) => error);
    const pendingOutcome = pending.catch((error) => error);
    await vi.waitFor(() => expect(session.starts).toHaveLength(1));

    await expect(runtime.stop()).rejects.toMatchObject({ code: "RUNTIME" });
    await expect(pendingOutcome).resolves.toMatchObject({ reason: "runtime stopped" });
    await expect(activeOutcome).resolves.toMatchObject({ code: "RUNTIME" });
    expect(server.stop).toHaveBeenCalledOnce();
    expect(runtime.state).toBe("stopped");
    expect([...session.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  });

  it("stops the server when the queue idle wait fails after reporting", async () => {
    const session = new FakeSession();
    const output = {
      sendText: vi.fn(async () => [testReceipt()]),
      report: vi.fn(async () => {
        throw new Error("report failed");
      }),
    } satisfies AgentRuntimeOutput;
    const server = { start: vi.fn(async () => session), stop: vi.fn(async () => undefined) };
    const runtime = new AgentRuntime(
      { ...ports(session, output), appServer: server },
      {
        clock: {
          now: () => {
            throw new Error("clock failed");
          },
          sleep: async () => undefined,
        },
      },
    );
    await runtime.start();
    const active = runtime.enqueue(input);
    const pending = runtime.enqueue({ ...input, messageId: "999" });
    const activeOutcome = active.catch((error) => error);
    const pendingOutcome = pending.catch((error) => error);
    await vi.waitFor(() => expect(session.starts).toHaveLength(1));

    await expect(runtime.stop()).rejects.toMatchObject({ code: "RUNTIME" });
    await expect(pendingOutcome).resolves.toMatchObject({ reason: "runtime stopped" });
    await expect(activeOutcome).resolves.toMatchObject({ code: "RUNTIME" });
    expect(server.stop).toHaveBeenCalledOnce();
    expect(runtime.state).toBe("stopped");
  });

  it("rejects a registry replacement that returns a different thread", async () => {
    const session = new FakeSession();
    const orphan = vi.fn(async () => undefined);
    const output = {
      sendText: vi.fn(async () => [testReceipt()]),
      reportOrphanThread: orphan,
    } satisfies AgentRuntimeOutput;
    const runtimePorts = ports(session, output);
    runtimePorts.registry.replaceThread = async () => ({
      ...binding,
      threadId: "44444444-4444-4444-8444-444444444444",
    });
    const runtime = new AgentRuntime(runtimePorts, { clock: immediateClock });
    await runtime.start();
    await expect(runtime.newSession(true, "creation-key")).rejects.toMatchObject({
      orphanThreadId: session.nextThreadId,
    });
    expect(orphan).toHaveBeenCalledWith(session.nextThreadId);
  });
});
