import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppServerRequestError } from "../../src/app-server/client.js";
import {
  CodexSessionService,
  type CodexSessionServiceOptions,
  DEFAULT_DISCORD_FILE_MARKER_LIMITS,
  DISCORD_FILE_FALLBACK_INSTRUCTIONS,
  DISCORD_SEND_FILE_DYNAMIC_TOOL,
  DISCORD_SEND_FILE_INPUT_SCHEMA,
  DiscordSendFileArgumentsSchema,
  PERSISTED_INTERACTIVE_THREAD_SOURCE_KINDS,
  parseDiscordFileMarkers,
  parseDiscordSendFileArguments,
  projectCodexSessionEvent,
  type SessionAppServerClient,
  validateDiscordSendFileArguments,
} from "../../src/app-server/session.js";
import {
  AtomicThreadCreationJournal,
  type ThreadCreationJournal,
} from "../../src/app-server/thread-creation-journal.js";
import { BridgeError } from "../../src/domain/errors.js";
import type { WorkspaceProfile } from "../../src/domain/schemas.js";
import {
  type AuthorizedOutboundFile,
  type BridgePathMetadata,
  type NormalizedWorkspace,
  type OutboundFileSystem,
  WorkspaceNormalizer,
} from "../../src/manager/workspaces.js";

type RequestHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>;
const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const OPERATION_ID = "55555555-5555-4555-8555-555555555555";
const CREATION_KEY_TWO = "66666666-6666-4666-8666-666666666666";
const THREAD_ONE = "019535d0-9f4a-7cc3-98c4-1d8efc0c1234";
const THREAD_TWO = "019535d0-a04b-7a31-8e74-42a612b5c678";
const THREAD_THREE = "019535d0-a14c-7f22-a6c3-72df9109abcd";
const STARTED_AT = "2026-07-27T08:00:00.000Z";
const TURN_SETTINGS = { model: "gpt-5.6-sol-request", effort: "high" } as const;

let temporaryDirectory: string;
let projectDirectory: string;
let inboxDirectory: string;
let bridgePaths: BridgePathMetadata;
let normalizer: WorkspaceNormalizer;
let journal: AtomicThreadCreationJournal;

function profile(overrides: Partial<WorkspaceProfile> = {}): WorkspaceProfile {
  return {
    name: "test-workspace",
    cwd: projectDirectory,
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    runtimeWorkspaceRoots: [projectDirectory],
    developerInstructions: "Follow local instructions.",
    model: "gpt-5",
    serviceTier: "default",
    ...overrides,
  };
}

function wireModel(
  overrides: Partial<{
    id: string;
    model: string;
    displayName: string;
    description: string;
    hidden: boolean;
    isDefault: boolean;
    defaultReasoningEffort: string;
    supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
  }> = {},
) {
  return {
    id: "gpt-5.6-sol-id",
    model: "gpt-5.6-sol-request",
    displayName: "GPT-5.6 Sol",
    description: "Frontier agentic coding model",
    hidden: false,
    isDefault: true,
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Fast" },
      { reasoningEffort: "high", description: "Deeper" },
    ],
    ...overrides,
  };
}

function clientWith(handler: RequestHandler): {
  client: SessionAppServerClient;
  request: ReturnType<typeof vi.fn<RequestHandler>>;
} {
  const request = vi.fn<RequestHandler>(handler);
  return { client: { request } as unknown as SessionAppServerClient, request };
}

function sessionService(
  client: SessionAppServerClient,
  overrides: Partial<
    Omit<CodexSessionServiceOptions, "client" | "threadCreationJournal" | "workspaceNormalizer">
  > & { threadCreationJournal?: ThreadCreationJournal } = {},
): CodexSessionService {
  const { threadCreationJournal = journal, ...options } = overrides;
  return new CodexSessionService({
    client,
    workspaceNormalizer: normalizer,
    threadCreationJournal,
    now: () => new Date(STARTED_AT),
    ...options,
  });
}

function journalWith(overrides: Partial<ThreadCreationJournal>): ThreadCreationJournal {
  return {
    acknowledge: journal.acknowledge.bind(journal),
    begin: journal.begin.bind(journal),
    confirm: journal.confirm.bind(journal),
    get: journal.get.bind(journal),
    list: journal.list.bind(journal),
    markAmbiguous: journal.markAmbiguous.bind(journal),
    markNotSent: journal.markNotSent.bind(journal),
    ...overrides,
  };
}

function expectBridgeCode(code: string) {
  return expect.objectContaining({ code });
}

async function normalizedWorkspace(): Promise<NormalizedWorkspace> {
  return normalizer.normalize(profile(), inboxDirectory);
}

async function readAuthorizedFile(file: AuthorizedOutboundFile): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of file.createReadStream()) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function trackedOutboundFileSystem(): {
  readonly fileSystem: OutboundFileSystem;
  readonly realpathCalls: string[];
  readonly opened: () => number;
  readonly closed: () => number;
} {
  const realpathCalls: string[] = [];
  let opened = 0;
  let closed = 0;
  return {
    fileSystem: {
      lstat,
      open: async (path, flags) => {
        const handle = await open(path, flags);
        opened += 1;
        return {
          fd: handle.fd,
          close: async () => {
            closed += 1;
            await handle.close();
          },
          createReadStream: handle.createReadStream.bind(handle),
          stat: handle.stat.bind(handle),
        };
      },
      realpath: async (path) => {
        realpathCalls.push(path);
        return realpath(path);
      },
      stat,
    },
    closed: () => closed,
    opened: () => opened,
    realpathCalls,
  };
}

const finalAssistantSource = {
  kind: "app-server",
  role: "assistant",
  final: true,
} as const;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "codex-discord-session-"));
  projectDirectory = join(temporaryDirectory, "project");
  const stateRoot = join(temporaryDirectory, "bridge-state");
  inboxDirectory = join(stateRoot, "inbox", INSTANCE_ID);
  bridgePaths = {
    root: stateRoot,
    registryPath: join(stateRoot, "registry.json"),
    logsDirectory: join(stateRoot, "logs"),
    instancesDirectory: join(stateRoot, "instances"),
    inboxDirectory: join(stateRoot, "inbox"),
    managerStatePaths: [join(stateRoot, "manager.json")],
  };
  await Promise.all([
    mkdir(projectDirectory, { recursive: true }),
    mkdir(inboxDirectory, { recursive: true }),
    mkdir(bridgePaths.logsDirectory, { recursive: true }),
    mkdir(bridgePaths.instancesDirectory, { recursive: true }),
  ]);
  normalizer = new WorkspaceNormalizer({ bridgePaths });
  journal = new AtomicThreadCreationJournal({
    filePath: join(stateRoot, "thread-creations.json"),
  });
});

afterEach(async () => {
  await rm(temporaryDirectory, { force: true, recursive: true });
});

describe("Codex App Server runtime event projection", () => {
  it("preserves agent-message identity and only known phases", () => {
    const base = {
      threadId: THREAD_ONE,
      turnId: "turn-1",
      startedAtMs: 1,
    };

    expect(
      projectCodexSessionEvent("item/started", {
        ...base,
        item: { id: "item-1", type: "agentMessage", text: "", phase: "commentary" },
      }),
    ).toEqual({
      method: "item/started",
      threadId: THREAD_ONE,
      turnId: "turn-1",
      itemId: "item-1",
      kind: "agentMessage",
      phase: "commentary",
    });
    expect(
      projectCodexSessionEvent("item/started", {
        ...base,
        item: { id: "item-2", type: "agentMessage", text: "", phase: "future" },
      }),
    ).toEqual({
      method: "item/started",
      threadId: THREAD_ONE,
      turnId: "turn-1",
      itemId: "item-2",
      kind: "agentMessage",
    });
  });

  it("projects bounded plan, reasoning summary, warning, and activity metadata", () => {
    expect(
      projectCodexSessionEvent("turn/plan/updated", {
        threadId: THREAD_ONE,
        turnId: "turn-1",
        explanation: "ignored",
        plan: [
          { step: "Inspect protocol", status: "completed" },
          { step: "Route progress", status: "inProgress" },
        ],
      }),
    ).toMatchObject({
      method: "turn/plan/updated",
      progress: {
        type: "plan",
        steps: [
          { step: "Inspect protocol", status: "completed" },
          { step: "Route progress", status: "inProgress" },
        ],
      },
    });
    expect(
      projectCodexSessionEvent("item/reasoning/summaryTextDelta", {
        threadId: THREAD_ONE,
        turnId: "turn-1",
        itemId: "reasoning-1",
        summaryIndex: 0,
        delta: "Checking the runtime boundary.",
      }),
    ).toMatchObject({
      method: "item/reasoning/summaryTextDelta",
      itemId: "reasoning-1",
      progress: { type: "reasoning", text: "Checking the runtime boundary." },
    });
    expect(
      projectCodexSessionEvent("warning", {
        threadId: THREAD_ONE,
        message: "Context is almost full.",
      }),
    ).toEqual({
      method: "warning",
      threadId: THREAD_ONE,
      progress: { type: "warning", message: "Context is almost full." },
    });
    expect(
      projectCodexSessionEvent("item/completed", {
        threadId: THREAD_ONE,
        turnId: "turn-1",
        completedAtMs: 2,
        item: {
          id: "command-1",
          type: "commandExecution",
          command: "npm test -- --token secret-value",
          cwd: "/repo",
          status: "failed",
        },
      }),
    ).toMatchObject({
      itemId: "command-1",
      progress: {
        type: "activity",
        activity: { kind: "command", executable: "npm" },
        status: "failed",
      },
    });
    expect(
      JSON.stringify(
        projectCodexSessionEvent("item/started", {
          threadId: THREAD_ONE,
          turnId: "turn-1",
          startedAtMs: 1,
          item: {
            id: "command-2",
            type: "commandExecution",
            command: "TOKEN=secret-value npm test",
            cwd: "/repo",
            status: "inProgress",
          },
        }),
      ),
    ).not.toContain("secret-value");
  });

  it("does not project raw diff, command output, or reasoning-part envelopes", () => {
    expect(
      projectCodexSessionEvent("turn/diff/updated", {
        threadId: THREAD_ONE,
        turnId: "turn-1",
        diff: "secret raw diff",
      }),
    ).toBeUndefined();
    expect(
      projectCodexSessionEvent("item/commandExecution/outputDelta", {
        threadId: THREAD_ONE,
        turnId: "turn-1",
        itemId: "command-1",
        delta: "secret command output",
      }),
    ).toBeUndefined();
    expect(
      projectCodexSessionEvent("item/reasoning/summaryPartAdded", {
        threadId: THREAD_ONE,
        turnId: "turn-1",
        itemId: "reasoning-1",
        summaryIndex: 0,
      }),
    ).toBeUndefined();
  });
});

describe("CodexSessionService thread operations", () => {
  it("passes identical normalized core parameters to start and resume", async () => {
    const { client, request } = clientWith(async (method, params) => {
      if (method === "thread/start") return { thread: { id: THREAD_ONE } };
      if (method === "thread/inject_items") return {};
      if (method === "thread/resume") return { thread: { id: params.threadId } };
      throw new Error(`Unexpected method ${method}`);
    });
    const sessions = sessionService(client);

    await sessions.start(profile(), inboxDirectory, OPERATION_ID);
    await sessions.resume(THREAD_TWO, profile(), inboxDirectory);

    const startCall = request.mock.calls.find(([method]) => method === "thread/start");
    const resumeCall = request.mock.calls.find(([method]) => method === "thread/resume");
    if (startCall === undefined || resumeCall === undefined) {
      throw new Error("Expected thread start and resume calls.");
    }
    const startParams = startCall[1];
    const resumeParams = resumeCall[1];
    const {
      dynamicTools: _dynamicTools,
      ephemeral: _ephemeral,
      developerInstructions: startInstructions,
      ...startCore
    } = startParams;
    const {
      threadId: _threadId,
      developerInstructions: resumeInstructions,
      ...resumeCore
    } = resumeParams;

    expect(resumeCore).toEqual(startCore);
    expect(startInstructions).toBe(
      `Follow local instructions.\n\n${DISCORD_FILE_FALLBACK_INSTRUCTIONS}`,
    );
    expect(resumeInstructions).toBe(
      `Follow local instructions.\n\n${DISCORD_FILE_FALLBACK_INSTRUCTIONS}`,
    );
    expect(startCore).toEqual({
      cwd: await realpath(projectDirectory),
      runtimeWorkspaceRoots: [await realpath(projectDirectory), await realpath(inboxDirectory)],
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      model: "gpt-5",
      serviceTier: "default",
    });
  });

  it("creates exactly one persisted thread and returns its nonempty ID", async () => {
    const { client, request } = clientWith(async () => ({
      thread: { id: THREAD_ONE, harmless: true },
      harmless: true,
    }));
    const sessions = sessionService(client);

    await expect(sessions.start(profile(), inboxDirectory, OPERATION_ID)).resolves.toEqual({
      threadId: THREAD_ONE,
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith(
      "thread/start",
      expect.objectContaining({ ephemeral: false }),
    );
    await expect(journal.list()).resolves.toEqual([
      {
        operationId: OPERATION_ID,
        cwd: await realpath(projectDirectory),
        startedAt: STARTED_AT,
        status: "confirmed",
        threadId: THREAD_ONE,
      },
    ]);
  });

  it("materializes a new thread before returning it to another App Server process", async () => {
    const { client, request } = clientWith(async (method) => {
      if (method === "thread/start") return { thread: { id: THREAD_ONE } };
      if (method === "thread/inject_items") return {};
      throw new Error(`Unexpected method ${method}`);
    });
    const sessions = sessionService(client);

    await sessions.start(profile(), inboxDirectory, OPERATION_ID);

    expect(request.mock.calls[1]).toEqual([
      "thread/inject_items",
      {
        threadId: THREAD_ONE,
        items: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Codex Discord Bridge session initialized." }],
          },
        ],
      },
    ]);
  });

  it("marks the creation ambiguous when thread materialization fails", async () => {
    const { client, request } = clientWith(async (method) => {
      if (method === "thread/start") return { thread: { id: THREAD_ONE } };
      throw new AppServerRequestError(
        "RUNTIME",
        "Codex App Server rejected thread materialization.",
        "remote-rejected",
      );
    });
    const sessions = sessionService(client);

    await expect(sessions.start(profile(), inboxDirectory, OPERATION_ID)).rejects.toMatchObject({
      code: "CONFLICT",
      operationId: OPERATION_ID,
      threadId: THREAD_ONE,
      remediation: expect.stringContaining("do not retry"),
    });
    await expect(sessions.start(profile(), inboxDirectory, OPERATION_ID)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start",
      "thread/inject_items",
    ]);
    await expect(journal.get(OPERATION_ID)).resolves.toMatchObject({ status: "ambiguous" });
  });

  it("persists the exact caller-supplied durable creation key", async () => {
    const { client, request } = clientWith(async () => ({ thread: { id: THREAD_ONE } }));
    const sessions = sessionService(client);

    await expect(sessions.start(profile(), inboxDirectory, CREATION_KEY_TWO)).resolves.toEqual({
      threadId: THREAD_ONE,
    });
    expect(request).toHaveBeenCalledTimes(2);
    await expect(journal.get(CREATION_KEY_TWO)).resolves.toMatchObject({
      operationId: CREATION_KEY_TWO,
      status: "confirmed",
      threadId: THREAD_ONE,
    });
    await expect(journal.get(OPERATION_ID)).resolves.toBeUndefined();
  });

  it("marks a malformed matching success response ambiguous", async () => {
    const { client, request } = clientWith(async () => ({
      thread: { id: "not-a-uuid" },
    }));
    const sessions = sessionService(client);

    await expect(sessions.start(profile(), inboxDirectory, OPERATION_ID)).rejects.toEqual(
      expectBridgeCode("CONFLICT"),
    );
    expect(request).toHaveBeenCalledOnce();
    await expect(journal.get(OPERATION_ID)).resolves.toMatchObject({ status: "ambiguous" });
  });

  it.each(["timeout", "transport loss"])(
    "durably marks sent-unconfirmed %s without retrying",
    async (_failure) => {
      const { client, request } = clientWith(async () => {
        throw new AppServerRequestError(
          "TIMEOUT",
          "Codex App Server request was not confirmed.",
          "sent-unconfirmed",
        );
      });
      const sessions = sessionService(client);

      await expect(sessions.start(profile(), inboxDirectory, OPERATION_ID)).rejects.toMatchObject({
        code: "CONFLICT",
        operationId: OPERATION_ID,
        remediation: expect.stringContaining("do not retry"),
      });
      expect(request).toHaveBeenCalledOnce();
      expect(request.mock.calls[0]?.[0]).toBe("thread/start");
      await expect(journal.get(OPERATION_ID)).resolves.toMatchObject({ status: "ambiguous" });
    },
  );

  it("tombstones a not-sent creation key as a definite no-side-effect outcome", async () => {
    const { client, request } = clientWith(async () => {
      throw new AppServerRequestError(
        "RUNTIME",
        "Codex App Server request failed safely.",
        "not-sent",
      );
    });
    const sessions = sessionService(client);

    await expect(sessions.start(profile(), inboxDirectory, OPERATION_ID)).rejects.toEqual(
      expectBridgeCode("RUNTIME"),
    );
    expect(request).toHaveBeenCalledOnce();
    await expect(journal.get(OPERATION_ID)).resolves.toMatchObject({ status: "not-sent" });
  });

  it("marks remote rejection after handoff ambiguous and forbids retry", async () => {
    const { client, request } = clientWith(async () => {
      throw new AppServerRequestError(
        "RUNTIME",
        "Codex App Server remotely rejected the request.",
        "remote-rejected",
      );
    });
    const sessions = sessionService(client);

    await expect(sessions.start(profile(), inboxDirectory, OPERATION_ID)).rejects.toMatchObject({
      code: "CONFLICT",
      operationId: OPERATION_ID,
      remediation: expect.stringContaining("do not retry"),
    });
    await expect(sessions.start(profile(), inboxDirectory, OPERATION_ID)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(request).toHaveBeenCalledOnce();
    await expect(journal.get(OPERATION_ID)).resolves.toMatchObject({ status: "ambiguous" });
  });

  it("does not reuse an acknowledged creation key after registry binding", async () => {
    const { client, request } = clientWith(async () => ({ thread: { id: THREAD_ONE } }));
    const sessions = sessionService(client);
    await sessions.start(profile(), inboxDirectory, OPERATION_ID);
    await journal.acknowledge({ threadId: THREAD_ONE });

    await expect(sessions.start(profile(), inboxDirectory, OPERATION_ID)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(request).toHaveBeenCalledTimes(2);
    await expect(journal.get(OPERATION_ID)).resolves.toMatchObject({ status: "acknowledged" });
  });

  it("does not send when journal begin fails", async () => {
    const { client, request } = clientWith(async () => ({ thread: { id: THREAD_ONE } }));
    const sessions = sessionService(client, {
      threadCreationJournal: journalWith({
        begin: async () => {
          throw new BridgeError("RUNTIME", "Journal unavailable.");
        },
      }),
    });

    await expect(sessions.start(profile(), inboxDirectory, OPERATION_ID)).rejects.toEqual(
      expectBridgeCode("RUNTIME"),
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("returns recoverable IDs when journal confirmation fails after known success", async () => {
    const { client, request } = clientWith(async () => ({ thread: { id: THREAD_ONE } }));
    const sessions = sessionService(client, {
      threadCreationJournal: journalWith({
        confirm: async () => {
          throw new BridgeError("RUNTIME", "Journal confirmation failed.");
        },
      }),
    });

    await expect(sessions.start(profile(), inboxDirectory, OPERATION_ID)).rejects.toMatchObject({
      code: "CONFLICT",
      operationId: OPERATION_ID,
      threadId: THREAD_ONE,
      remediation: expect.stringContaining("do not retry"),
    });
    expect(request).toHaveBeenCalledTimes(2);
    await expect(journal.get(OPERATION_ID)).resolves.toMatchObject({ status: "pending" });
  });

  it("does not retry or create a fallback thread after an unclassified failure", async () => {
    const { client, request } = clientWith(async () => {
      throw new Error("connection closed after write");
    });
    const sessions = sessionService(client);

    await expect(sessions.start(profile(), inboxDirectory, OPERATION_ID)).rejects.toEqual(
      expectBridgeCode("CONFLICT"),
    );
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toBe("thread/start");
  });

  it("resumes the exact existing thread ID without creating a fallback", async () => {
    const { client, request } = clientWith(async (_method, params) => ({
      thread: { id: params.threadId },
    }));
    const sessions = sessionService(client);

    await expect(sessions.resume(THREAD_TWO, profile(), inboxDirectory)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]).toEqual([
      "thread/resume",
      expect.objectContaining({ threadId: THREAD_TWO }),
    ]);
    expect(request.mock.calls.flat().includes("thread/start")).toBe(false);
  });

  it("authorizes structured files and markers only for the active resumed thread", async () => {
    const { client } = clientWith(async (method, params) => {
      if (method === "thread/resume") return { thread: { id: params.threadId } };
      throw new Error(`Unexpected method ${method}`);
    });
    const sessions = sessionService(client);
    const filePath = join(projectDirectory, "result.txt");
    await writeFile(filePath, "result", "utf8");
    await sessions.resume(THREAD_TWO, profile(), inboxDirectory);

    const structured = await sessions.authorizeSendFile(THREAD_TWO, {
      path: filePath,
      message: "attached",
    });
    expect(structured.message).toBe("attached");
    await expect(readAuthorizedFile(structured.file)).resolves.toBe("result");
    await structured.file.close();

    const marker = await sessions.parseFileMarkers(
      THREAD_TWO,
      `visible\n[[discord_file:${filePath}]]`,
    );
    expect(marker.visibleText).toBe("visible\n");
    expect(marker.files).toHaveLength(1);
    await Promise.all(marker.files.map((file) => file.close()));

    await expect(sessions.authorizeSendFile(THREAD_ONE, { path: filePath })).rejects.toThrow(
      BridgeError,
    );
    await expect(
      sessions.parseFileMarkers(THREAD_ONE, `[[discord_file:${filePath}]]`),
    ).rejects.toThrow(BridgeError);
  });

  it("keeps the previous active file context when a later resume fails validation", async () => {
    const { client } = clientWith(async (method, params) => {
      if (method !== "thread/resume") throw new Error(`Unexpected method ${method}`);
      return {
        thread: { id: params.threadId === THREAD_THREE ? THREAD_ONE : params.threadId },
      };
    });
    const sessions = sessionService(client);
    const filePath = join(projectDirectory, "stable.txt");
    await writeFile(filePath, "stable", "utf8");
    await sessions.resume(THREAD_TWO, profile(), inboxDirectory);

    await expect(sessions.resume(THREAD_THREE, profile(), inboxDirectory)).rejects.toThrow(
      BridgeError,
    );
    const authorized = await sessions.authorizeSendFile(THREAD_TWO, { path: filePath });
    await authorized.file.close();
    await expect(sessions.authorizeSendFile(THREAD_THREE, { path: filePath })).rejects.toThrow(
      BridgeError,
    );
  });

  it("fails closed when resume returns a different thread ID", async () => {
    const { client, request } = clientWith(async () => ({ thread: { id: THREAD_TWO } }));
    const sessions = sessionService(client);

    await expect(sessions.resume(THREAD_ONE, profile(), inboxDirectory)).rejects.toEqual(
      expectBridgeCode("RUNTIME"),
    );
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toBe("thread/resume");
  });

  it("lists all persisted interactive threads across cursor pages in server order", async () => {
    const pages = [
      {
        data: [
          { id: THREAD_ONE, cwd: "/repo/one", name: "One", updatedAt: 3, extra: true },
          { id: THREAD_TWO, cwd: "/repo/two", name: null, updatedAt: 2 },
        ],
        nextCursor: "page-2",
      },
      { data: [{ id: THREAD_THREE, cwd: "/repo/three" }], nextCursor: null },
    ];
    const { client, request } = clientWith(async () => pages.shift());
    const sessions = sessionService(client);

    await expect(sessions.list()).resolves.toEqual([
      { id: THREAD_ONE, cwd: "/repo/one", name: "One", updatedAt: 3 },
      { id: THREAD_TWO, cwd: "/repo/two", updatedAt: 2 },
      { id: THREAD_THREE, cwd: "/repo/three" },
    ]);
    expect(request.mock.calls).toEqual([
      [
        "thread/list",
        {
          limit: 100,
          sourceKinds: PERSISTED_INTERACTIVE_THREAD_SOURCE_KINDS,
        },
      ],
      [
        "thread/list",
        {
          cursor: "page-2",
          limit: 100,
          sourceKinds: PERSISTED_INTERACTIVE_THREAD_SOURCE_KINDS,
        },
      ],
    ]);
    expect(PERSISTED_INTERACTIVE_THREAD_SOURCE_KINDS).toEqual([
      "cli",
      "vscode",
      "exec",
      "appServer",
      "unknown",
    ]);
  });

  it("fails closed on repeated cursors, duplicate IDs, and configured pagination bounds", async () => {
    const repeated = clientWith(async () => ({ data: [], nextCursor: "repeat" }));
    await expect(sessionService(repeated.client).list()).rejects.toEqual(
      expectBridgeCode("RUNTIME"),
    );
    expect(repeated.request).toHaveBeenCalledTimes(2);

    const duplicatePages = [
      { data: [{ id: THREAD_ONE, cwd: "/repo" }], nextCursor: "next" },
      { data: [{ id: THREAD_ONE, cwd: "/repo" }], nextCursor: null },
    ];
    const duplicate = clientWith(async () => duplicatePages.shift());
    await expect(sessionService(duplicate.client).list()).rejects.toEqual(
      expectBridgeCode("RUNTIME"),
    );

    const tooManyPages = clientWith(async () => ({ data: [], nextCursor: crypto.randomUUID() }));
    await expect(sessionService(tooManyPages.client, { maxListPages: 2 }).list()).rejects.toEqual(
      expectBridgeCode("RUNTIME"),
    );
    expect(tooManyPages.request).toHaveBeenCalledTimes(2);

    const tooManyItems = clientWith(async () => ({
      data: [
        { id: THREAD_ONE, cwd: "/repo" },
        { id: THREAD_TWO, cwd: "/repo" },
      ],
      nextCursor: null,
    }));
    await expect(sessionService(tooManyItems.client, { maxListItems: 1 }).list()).rejects.toEqual(
      expectBridgeCode("RUNTIME"),
    );
  });

  it.each([
    ["malformed UUID id", { id: "thread", cwd: "/repo" }],
    ["id", { id: "i".repeat(513), cwd: "/repo" }],
    ["cwd", { id: THREAD_ONE, cwd: `/${"c".repeat(16 * 1024)}` }],
    ["name", { id: THREAD_ONE, cwd: "/repo", name: "n".repeat(1025) }],
    ["Unicode name bytes", { id: THREAD_ONE, cwd: "/repo", name: "😀".repeat(300) }],
  ])("rejects an oversized thread/list %s before retaining it", async (_field, thread) => {
    const { client, request } = clientWith(async () => ({
      data: [thread],
      nextCursor: "must-not-be-followed",
    }));
    const sessions = sessionService(client);

    await expect(sessions.list()).rejects.toEqual(expectBridgeCode("RUNTIME"));
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects an oversized pagination cursor before issuing the next request", async () => {
    const { client, request } = clientWith(async () => ({
      data: [],
      nextCursor: "c".repeat(8 * 1024 + 1),
    }));
    const sessions = sessionService(client);

    await expect(sessions.list()).rejects.toEqual(expectBridgeCode("RUNTIME"));
    expect(request).toHaveBeenCalledOnce();
  });

  it("reads and validates the exact target thread before link", async () => {
    const { client, request } = clientWith(async () => ({
      thread: {
        id: THREAD_ONE,
        cwd: "/repo",
        name: "Target",
        updatedAt: 10,
        future: true,
      },
    }));
    const sessions = sessionService(client);

    await expect(sessions.read(THREAD_ONE)).resolves.toEqual({
      id: THREAD_ONE,
      cwd: "/repo",
      name: "Target",
      updatedAt: 10,
    });
    expect(request).toHaveBeenCalledWith("thread/read", {
      threadId: THREAD_ONE,
      includeTurns: false,
    });
  });

  it("rejects fuzzy or malformed read results", async () => {
    for (const thread of [
      { id: THREAD_TWO, cwd: "/repo" },
      { id: THREAD_ONE },
      { id: THREAD_ONE, cwd: "relative" },
    ]) {
      const { client } = clientWith(async () => ({ thread }));
      const sessions = sessionService(client);
      await expect(sessions.read(THREAD_ONE)).rejects.toEqual(expectBridgeCode("RUNTIME"));
    }
  });

  it("registers exactly the outbound Discord file dynamic tool only on thread start", async () => {
    const { client, request } = clientWith(async (method, params) => ({
      thread: { id: method === "thread/start" ? THREAD_ONE : params.threadId },
    }));
    const sessions = sessionService(client);

    await sessions.start(profile(), inboxDirectory, OPERATION_ID);
    await sessions.resume(THREAD_TWO, profile(), inboxDirectory);

    const startParams = request.mock.calls.find(([method]) => method === "thread/start")?.[1];
    const resumeParams = request.mock.calls.find(([method]) => method === "thread/resume")?.[1];
    expect(startParams).toMatchObject({
      dynamicTools: [DISCORD_SEND_FILE_DYNAMIC_TOOL],
    });
    const firstTool = (startParams as { dynamicTools: object[] } | undefined)?.dynamicTools[0];
    expect(firstTool).toBeDefined();
    expect(Object.keys(firstTool ?? {})).toEqual(["type", "name", "description", "inputSchema"]);
    expect(Object.hasOwn(resumeParams as object, "dynamicTools")).toBe(false);
    expect(Object.isFrozen(DISCORD_SEND_FILE_DYNAMIC_TOOL)).toBe(true);
    expect(DISCORD_SEND_FILE_DYNAMIC_TOOL.inputSchema).toBe(DISCORD_SEND_FILE_INPUT_SCHEMA);
    expect(Object.isFrozen(DISCORD_SEND_FILE_DYNAMIC_TOOL.inputSchema.properties)).toBe(true);
    expect(
      DiscordSendFileArgumentsSchema.safeParse({ path: "/tmp/file", extra: true }).success,
    ).toBe(false);
  });

  it("adds fixed validated marker fallback instructions on resume without mutating the profile", async () => {
    const input = profile();
    const { client, request } = clientWith(async (_method, params) => ({
      thread: { id: params.threadId },
    }));
    const sessions = sessionService(client);

    await sessions.resume(THREAD_TWO, input, inboxDirectory);

    const params = request.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.developerInstructions).toBe(
      `Follow local instructions.\n\n${DISCORD_FILE_FALLBACK_INSTRUCTIONS}`,
    );
    expect(DISCORD_FILE_FALLBACK_INSTRUCTIONS).toContain("[[discord_file:/absolute/path]]");
    expect(DISCORD_FILE_FALLBACK_INSTRUCTIONS).toContain("standalone final response line");
    expect(DISCORD_FILE_FALLBACK_INSTRUCTIONS).toContain("bridge state");
    expect(DISCORD_FILE_FALLBACK_INSTRUCTIONS).toContain("discord_send_file");
    expect(DISCORD_FILE_FALLBACK_INSTRUCTIONS).toContain("when available");
    expect(input.developerInstructions).toBe("Follow local instructions.");
    expect(Object.hasOwn(params, "dynamicTools")).toBe(false);
  });
});

describe("CodexSessionService model catalog", () => {
  it("loads all hidden and visible models across pages as a deeply frozen catalog", async () => {
    const pages = [
      {
        data: [wireModel()],
        nextCursor: "page-2",
      },
      {
        data: [
          wireModel({
            id: "gpt-5.6-luna-id",
            model: "gpt-5.6-luna-request",
            displayName: "GPT-5.6 Luna",
            hidden: true,
            isDefault: false,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
          }),
        ],
        nextCursor: null,
      },
    ];
    const { client, request } = clientWith(async () => pages.shift());
    const sessions = sessionService(client);

    const catalog = await sessions.listModels();

    expect(catalog).toEqual([
      {
        id: "gpt-5.6-sol-id",
        model: "gpt-5.6-sol-request",
        displayName: "GPT-5.6 Sol",
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: ["low", "high"],
      },
      {
        id: "gpt-5.6-luna-id",
        model: "gpt-5.6-luna-request",
        displayName: "GPT-5.6 Luna",
        hidden: true,
        isDefault: false,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["medium"],
      },
    ]);
    expect(request.mock.calls).toEqual([
      ["model/list", { includeHidden: true, limit: 100 }],
      ["model/list", { cursor: "page-2", includeHidden: true, limit: 100 }],
    ]);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog[0])).toBe(true);
    expect(Object.isFrozen(catalog[0]?.supportedReasoningEfforts)).toBe(true);
  });

  it.each([
    ["empty catalog", { data: [], nextCursor: null }],
    ["empty continuation page", { data: [], nextCursor: "next" }],
    [
      "duplicate efforts",
      {
        data: [
          wireModel({
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "one" },
              { reasoningEffort: "low", description: "two" },
            ],
          }),
        ],
        nextCursor: null,
      },
    ],
    [
      "missing default effort",
      {
        data: [wireModel({ defaultReasoningEffort: "medium" })],
        nextCursor: null,
      },
    ],
    [
      "empty effort list",
      { data: [wireModel({ supportedReasoningEfforts: [] })], nextCursor: null },
    ],
    ["oversized model ID", { data: [wireModel({ id: "x".repeat(257) })], nextCursor: null }],
    ["oversized model ID bytes", { data: [wireModel({ id: "界".repeat(256) })], nextCursor: null }],
    ["control character", { data: [wireModel({ model: "bad\nmodel" })], nextCursor: null }],
    ["C1 control character", { data: [wireModel({ id: "bad\u0085model" })], nextCursor: null }],
    [
      "too many efforts",
      {
        data: [
          wireModel({
            defaultReasoningEffort: "effort-0",
            supportedReasoningEfforts: Array.from({ length: 65 }, (_, index) => ({
              reasoningEffort: `effort-${index}`,
              description: "effort",
            })),
          }),
        ],
        nextCursor: null,
      },
    ],
  ] as const)("rejects a malformed %s", async (_label, response) => {
    const { client, request } = clientWith(async () => response);

    await expect(sessionService(client).listModels()).rejects.toEqual(expectBridgeCode("RUNTIME"));
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects duplicate IDs, invalid defaults, and repeated or invalid cursors", async () => {
    const duplicatePages = [
      { data: [wireModel()], nextCursor: "next" },
      { data: [wireModel({ isDefault: false })], nextCursor: null },
    ];
    await expect(
      sessionService(clientWith(async () => duplicatePages.shift()).client).listModels(),
    ).rejects.toEqual(expectBridgeCode("RUNTIME"));

    const multipleDefaults = {
      data: [wireModel(), wireModel({ id: "other", model: "other" })],
      nextCursor: null,
    };
    await expect(
      sessionService(clientWith(async () => multipleDefaults).client).listModels(),
    ).rejects.toEqual(expectBridgeCode("RUNTIME"));

    const noDefault = {
      data: [wireModel({ isDefault: false })],
      nextCursor: null,
    };
    await expect(
      sessionService(clientWith(async () => noDefault).client).listModels(),
    ).rejects.toEqual(expectBridgeCode("RUNTIME"));

    for (const nextCursor of ["", "bad\ncursor", "c".repeat(8 * 1024 + 1)]) {
      const invalid = clientWith(async () => ({ data: [wireModel()], nextCursor }));
      await expect(sessionService(invalid.client).listModels()).rejects.toEqual(
        expectBridgeCode("RUNTIME"),
      );
      expect(invalid.request).toHaveBeenCalledOnce();
    }

    const repeated = clientWith(async () => ({ data: [wireModel()], nextCursor: "repeat" }));
    await expect(sessionService(repeated.client).listModels()).rejects.toEqual(
      expectBridgeCode("RUNTIME"),
    );
    expect(repeated.request).toHaveBeenCalledTimes(2);
  });

  it("enforces configured catalog page and item limits before retention", async () => {
    let page = 0;
    const tooManyPages = clientWith(async () => ({
      data: [
        wireModel({
          id: `model-${page}`,
          model: `model-${page++}`,
          isDefault: page === 1,
        }),
      ],
      nextCursor: `cursor-${page}`,
    }));
    await expect(
      sessionService(tooManyPages.client, { maxListPages: 2 }).listModels(),
    ).rejects.toEqual(expectBridgeCode("RUNTIME"));
    expect(tooManyPages.request).toHaveBeenCalledTimes(2);

    const tooManyItems = clientWith(async () => ({
      data: [wireModel(), wireModel({ id: "other", model: "other", isDefault: false })],
      nextCursor: null,
    }));
    await expect(
      sessionService(tooManyItems.client, { maxListItems: 1 }).listModels(),
    ).rejects.toEqual(expectBridgeCode("RUNTIME"));
    expect(tooManyItems.request).toHaveBeenCalledOnce();
  });

  it("accepts exactly 100 pages and 10,000 models and rejects either excess", async () => {
    let acceptedPage = 0;
    const accepted = clientWith(async () => {
      const page = acceptedPage++;
      return {
        data: Array.from({ length: 100 }, (_, index) =>
          wireModel({
            id: `model-${page}-${index}`,
            model: `request-${page}-${index}`,
            isDefault: page === 0 && index === 0,
          }),
        ),
        nextCursor: page === 99 ? null : `cursor-${page + 1}`,
      };
    });
    await expect(sessionService(accepted.client).listModels()).resolves.toHaveLength(10_000);
    expect(accepted.request).toHaveBeenCalledTimes(100);

    const excessiveItems = clientWith(async () => ({
      data: Array.from({ length: 10_001 }, (_, index) =>
        wireModel({
          id: `model-${index}`,
          model: `request-${index}`,
          isDefault: index === 0,
        }),
      ),
      nextCursor: null,
    }));
    await expect(sessionService(excessiveItems.client).listModels()).rejects.toEqual(
      expectBridgeCode("RUNTIME"),
    );
    expect(excessiveItems.request).toHaveBeenCalledOnce();

    let excessivePage = 0;
    const excessivePages = clientWith(async () => {
      const page = excessivePage++;
      return {
        data: [
          wireModel({
            id: `model-${page}`,
            model: `request-${page}`,
            isDefault: page === 0,
          }),
        ],
        nextCursor: `cursor-${page + 1}`,
      };
    });
    await expect(sessionService(excessivePages.client).listModels()).rejects.toEqual(
      expectBridgeCode("RUNTIME"),
    );
    expect(excessivePages.request).toHaveBeenCalledTimes(100);
  });

  it("keeps model catalog hard bounds when generic list limits are configured higher", async () => {
    const oversizedPage = clientWith(async () => ({ data: [wireModel()], nextCursor: null }));
    await expect(
      sessionService(oversizedPage.client, { listPageSize: 101 }).listModels(),
    ).resolves.toHaveLength(1);
    expect(oversizedPage.request).toHaveBeenCalledWith("model/list", {
      includeHidden: true,
      limit: 100,
    });

    const excessiveItems = clientWith(async () => ({
      data: Array.from({ length: 10_001 }, (_, index) =>
        wireModel({
          id: `configured-model-${index}`,
          model: `configured-request-${index}`,
          isDefault: index === 0,
        }),
      ),
      nextCursor: null,
    }));
    await expect(
      sessionService(excessiveItems.client, { maxListItems: 10_001 }).listModels(),
    ).rejects.toEqual(expectBridgeCode("RUNTIME"));

    let page = 0;
    const excessivePages = clientWith(async () => ({
      data: [
        wireModel({
          id: `configured-page-model-${page}`,
          model: `configured-page-request-${page}`,
          isDefault: page++ === 0,
        }),
      ],
      nextCursor: `configured-cursor-${page}`,
    }));
    await expect(
      sessionService(excessivePages.client, { maxListPages: 101 }).listModels(),
    ).rejects.toEqual(expectBridgeCode("RUNTIME"));
    expect(excessivePages.request).toHaveBeenCalledTimes(100);
  });
});

describe("CodexSessionService turn operations", () => {
  it("starts one text turn with exact Discord source metadata", async () => {
    const { client, request } = clientWith(async () => ({
      turn: { id: "turn-1", future: true },
    }));
    const sessions = sessionService(client);

    await expect(
      sessions.startTurn(
        THREAD_ONE,
        "hello",
        {
          messageId: "100",
          channelId: "200",
          authorId: "300",
          guildId: "400",
          parentChannelId: "500",
          interactionId: "600",
        },
        TURN_SETTINGS,
      ),
    ).resolves.toEqual({ turnId: "turn-1" });
    expect(request).toHaveBeenCalledWith("turn/start", {
      threadId: THREAD_ONE,
      input: [{ type: "text", text: "hello", text_elements: [] }],
      clientUserMessageId: "100",
      model: "gpt-5.6-sol-request",
      effort: "high",
      responsesapiClientMetadata: {
        discord_message_id: "100",
        discord_channel_id: "200",
        discord_author_id: "300",
        discord_guild_id: "400",
        discord_parent_channel_id: "500",
        discord_interaction_id: "600",
      },
    });
  });

  it("rejects empty, oversized, malformed-source, and arbitrary metadata input", async () => {
    const { client, request } = clientWith(async () => ({ turn: { id: "turn" } }));
    const sessions = sessionService(client, { maxTurnInputCharacters: 5 });
    const source = { messageId: "1", channelId: "2", authorId: "3" };

    await expect(sessions.startTurn(THREAD_ONE, "   ", source, TURN_SETTINGS)).rejects.toEqual(
      expectBridgeCode("INVALID_ARGUMENT"),
    );
    await expect(sessions.startTurn(THREAD_ONE, "123456", source, TURN_SETTINGS)).rejects.toEqual(
      expectBridgeCode("INVALID_ARGUMENT"),
    );
    await expect(
      sessions.startTurn(
        THREAD_ONE,
        "hello",
        { ...source, messageId: "not-a-snowflake" },
        TURN_SETTINGS,
      ),
    ).rejects.toEqual(expectBridgeCode("INVALID_ARGUMENT"));
    await expect(
      sessions.startTurn(
        THREAD_ONE,
        "hello",
        { ...source, token: "secret" } as never,
        TURN_SETTINGS,
      ),
    ).rejects.toEqual(expectBridgeCode("INVALID_ARGUMENT"));
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects malformed turn model settings before requesting a turn", async () => {
    const { client, request } = clientWith(async () => ({ turn: { id: "turn" } }));
    const sessions = sessionService(client);
    const source = { messageId: "1", channelId: "2", authorId: "3" };

    for (const settings of [
      { model: "", effort: "high" },
      { model: "x".repeat(257), effort: "high" },
      { model: "界".repeat(256), effort: "high" },
      { model: "bad\nmodel", effort: "high" },
      { model: "gpt-5.6-sol", effort: "" },
      { model: "gpt-5.6-sol", effort: "x".repeat(65) },
      { model: "gpt-5.6-sol", effort: "bad\neffort" },
    ]) {
      await expect(sessions.startTurn(THREAD_ONE, "hello", source, settings)).rejects.toEqual(
        expectBridgeCode("INVALID_ARGUMENT"),
      );
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("bounds input thread, turn, and Discord source IDs by bytes before requests", async () => {
    const { client, request } = clientWith(async () => ({}));
    const sessions = sessionService(client);
    const source = { messageId: "1", channelId: "2", authorId: "3" };

    await expect(sessions.read("😀".repeat(200))).rejects.toEqual(
      expectBridgeCode("INVALID_ARGUMENT"),
    );
    await expect(sessions.interrupt(THREAD_ONE, "t".repeat(513))).rejects.toEqual(
      expectBridgeCode("INVALID_ARGUMENT"),
    );
    await expect(
      sessions.startTurn(
        THREAD_ONE,
        "hello",
        { ...source, messageId: "1".repeat(33) },
        TURN_SETTINGS,
      ),
    ).rejects.toEqual(expectBridgeCode("INVALID_ARGUMENT"));
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects an oversized returned turn ID", async () => {
    const { client, request } = clientWith(async () => ({ turn: { id: "t".repeat(513) } }));
    const sessions = sessionService(client);

    await expect(
      sessions.startTurn(
        THREAD_ONE,
        "hello",
        {
          messageId: "1",
          channelId: "2",
          authorId: "3",
        },
        TURN_SETTINGS,
      ),
    ).rejects.toEqual(expectBridgeCode("RUNTIME"));
    expect(request).toHaveBeenCalledOnce();
  });

  it("interrupts the exact turn and accepts harmless additive response fields", async () => {
    const valid = clientWith(async () => ({ futureMetadata: { harmless: true } }));
    const sessions = sessionService(valid.client);
    await expect(sessions.interrupt(THREAD_ONE, "turn-1")).resolves.toBeUndefined();
    expect(valid.request).toHaveBeenCalledWith("turn/interrupt", {
      threadId: THREAD_ONE,
      turnId: "turn-1",
    });

    for (const response of [null, "", 1, []]) {
      const invalid = clientWith(async () => response);
      await expect(sessionService(invalid.client).interrupt(THREAD_ONE, "turn-1")).rejects.toEqual(
        expectBridgeCode("RUNTIME"),
      );
    }
  });
});

describe("outbound Discord file helpers", () => {
  it("parses strict dynamic tool arguments and validates the canonical file", async () => {
    const workspace = await normalizedWorkspace();
    const file = join(projectDirectory, "result [1].txt");
    await writeFile(file, "result");

    expect(parseDiscordSendFileArguments({ path: file, message: "Result" })).toEqual({
      path: file,
      message: "Result",
    });
    expect(() => parseDiscordSendFileArguments({ path: file, extra: true })).toThrow(
      expectBridgeCode("INVALID_ARGUMENT"),
    );
    const validated = await validateDiscordSendFileArguments(
      { path: file, message: "Result" },
      { workspace },
    );
    expect(validated.message).toBe("Result");
    expect(validated.file).toMatchObject({
      canonicalPath: await realpath(file),
      displayFilename: "result [1].txt",
      size: 6,
    });
    expect(await readAuthorizedFile(validated.file)).toBe("result");
    await validated.file.close();
  });

  it("caps dynamic tool messages at 2000 UTF-16 code units in runtime and advertised schemas", () => {
    expect(
      parseDiscordSendFileArguments({ path: "/tmp/result.txt", message: "x".repeat(2_000) }),
    ).toMatchObject({ message: "x".repeat(2_000) });
    expect(() =>
      parseDiscordSendFileArguments({ path: "/tmp/result.txt", message: "x".repeat(2_001) }),
    ).toThrow(expectBridgeCode("INVALID_ARGUMENT"));
    expect(() =>
      parseDiscordSendFileArguments({ path: "/tmp/result.txt", message: "😀".repeat(1_001) }),
    ).toThrow(expectBridgeCode("INVALID_ARGUMENT"));
    expect(DISCORD_SEND_FILE_INPUT_SCHEMA.properties.message).toEqual({
      type: "string",
      maxLength: 2_000,
    });
  });

  it("strips only exact final App Server assistant marker lines and preserves CRLF", async () => {
    const workspace = await normalizedWorkspace();
    const file = join(projectDirectory, "result [final].txt");
    await writeFile(file, "result");
    const text = `before\r\n[[discord_file:${file}]]\r\nafter`;

    const parsed = await parseDiscordFileMarkers(text, {
      workspace,
      source: finalAssistantSource,
    });
    expect(parsed.visibleText).toBe("before\r\nafter");
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatchObject({ canonicalPath: await realpath(file) });
    await parsed.files[0]?.close();
  });

  it("leaves near matches, relative paths, indentation, trailing spaces, prose, and fences visible", async () => {
    const workspace = await normalizedWorkspace();
    const file = join(projectDirectory, "result.txt");
    await writeFile(file, "result");
    const text = [
      ` [[discord_file:${file}]]`,
      `[[discord_file:${file}]] `,
      `prefix [[discord_file:${file}]]`,
      "[[discord_file:relative.txt]]",
      `[[discord-file:${file}]]`,
      "```text",
      `[[discord_file:${file}]]`,
      "```",
    ].join("\n");

    await expect(
      parseDiscordFileMarkers(text, { workspace, source: finalAssistantSource }),
    ).resolves.toEqual({ visibleText: text, files: [] });
  });

  it.each([
    { kind: "discord", role: "user", final: true } as const,
    { kind: "app-server", role: "assistant", final: false } as const,
    { kind: "app-server", role: "reasoning", final: true } as const,
    { kind: "app-server", role: "tool", final: true } as const,
  ])("does not parse marker text from $kind/$role/final=$final", async (source) => {
    const workspace = await normalizedWorkspace();
    const file = join(projectDirectory, "result.txt");
    await writeFile(file, "result");
    const text = `[[discord_file:${file}]]`;

    await expect(parseDiscordFileMarkers(text, { workspace, source })).resolves.toEqual({
      visibleText: text,
      files: [],
    });
  });

  it("deduplicates canonical markers in first order while stripping every marker line", async () => {
    const workspace = await normalizedWorkspace();
    const first = join(projectDirectory, "first.txt");
    const second = join(projectDirectory, "second.txt");
    await writeFile(first, "first");
    await writeFile(second, "second");
    const text = [
      "before",
      `[[discord_file:${first}]]`,
      `[[discord_file:${second}]]`,
      `[[discord_file:${first}]]`,
      "after",
    ].join("\n");

    const parsed = await parseDiscordFileMarkers(text, {
      workspace,
      source: finalAssistantSource,
    });
    expect(parsed.visibleText).toBe("before\nafter");
    expect(parsed.files.map((file) => file.canonicalPath)).toEqual([
      await realpath(first),
      await realpath(second),
    ]);
    await Promise.all(parsed.files.map((file) => file.close()));
  });

  it("fails all-or-nothing when any exact marker path is missing, outside, or protected", async () => {
    const workspace = await normalizedWorkspace();
    const valid = join(projectDirectory, "valid.txt");
    const missing = join(projectDirectory, "missing.txt");
    const outside = join(temporaryDirectory, "outside.txt");
    const protectedFile = join(bridgePaths.logsDirectory, "secret.log");
    await writeFile(valid, "valid");
    await writeFile(outside, "outside");
    await writeFile(protectedFile, "protected");

    for (const invalid of [missing, outside, protectedFile]) {
      await expect(
        parseDiscordFileMarkers(`visible\n[[discord_file:${valid}]]\n[[discord_file:${invalid}]]`, {
          workspace,
          source: finalAssistantSource,
        }),
      ).rejects.toEqual(expectBridgeCode(invalid === missing ? "NOT_FOUND" : "UNAUTHORIZED"));
    }
  });

  it("rejects marker-line floods before any filesystem work", async () => {
    const workspace = await normalizedWorkspace();
    const path = join(projectDirectory, "result.txt");
    const filesystemCall = vi.fn(async () => {
      throw new Error("filesystem must not be reached");
    });
    const text = Array.from({ length: 100 }, () => `[[discord_file:${path}]]`).join("\n");

    await expect(
      parseDiscordFileMarkers(text, {
        workspace,
        source: finalAssistantSource,
        fileSystem: {
          lstat: filesystemCall,
          open: filesystemCall,
          realpath: filesystemCall,
          stat: filesystemCall,
        } as never,
      }),
    ).rejects.toEqual(expectBridgeCode("INVALID_ARGUMENT"));
    expect(DEFAULT_DISCORD_FILE_MARKER_LIMITS.markerLines).toBe(20);
    expect(filesystemCall).not.toHaveBeenCalled();
  });

  it("rejects too many unique raw marker paths before any filesystem work", async () => {
    const workspace = await normalizedWorkspace();
    const filesystemCall = vi.fn(async () => {
      throw new Error("filesystem must not be reached");
    });
    const text = ["one.txt", "two.txt", "three.txt"]
      .map((name) => `[[discord_file:${join(projectDirectory, name)}]]`)
      .join("\n");

    await expect(
      parseDiscordFileMarkers(text, {
        workspace,
        source: finalAssistantSource,
        maxUniqueRawMarkerPaths: 2,
        fileSystem: {
          lstat: filesystemCall,
          open: filesystemCall,
          realpath: filesystemCall,
          stat: filesystemCall,
        } as never,
      }),
    ).rejects.toEqual(expectBridgeCode("INVALID_ARGUMENT"));
    expect(filesystemCall).not.toHaveBeenCalled();
  });

  it("deduplicates raw marker candidates before one filesystem authorization", async () => {
    const workspace = await normalizedWorkspace();
    const file = join(projectDirectory, "duplicate.txt");
    await writeFile(file, "duplicate");
    const tracked = trackedOutboundFileSystem();
    const text = Array.from({ length: 3 }, () => `[[discord_file:${file}]]`).join("\n");

    const parsed = await parseDiscordFileMarkers(text, {
      workspace,
      source: finalAssistantSource,
      fileSystem: tracked.fileSystem,
    });

    expect(parsed.files).toHaveLength(1);
    expect(tracked.realpathCalls.filter((path) => path === file)).toHaveLength(1);
    expect(tracked.opened()).toBe(1);
    expect(tracked.closed()).toBe(0);
    await parsed.files[0]?.close();
    expect(tracked.closed()).toBe(1);
  });

  it("closes canonical duplicates while preserving one caller-owned descriptor", async () => {
    const workspace = await normalizedWorkspace();
    const file = join(projectDirectory, "result.txt");
    const alias = join(projectDirectory, "result-link.txt");
    await writeFile(file, "result");
    await symlink(file, alias);
    const tracked = trackedOutboundFileSystem();

    const parsed = await parseDiscordFileMarkers(
      `[[discord_file:${file}]]\n[[discord_file:${alias}]]`,
      { workspace, source: finalAssistantSource, fileSystem: tracked.fileSystem },
    );

    expect(parsed.files).toHaveLength(1);
    expect(tracked.opened()).toBe(2);
    expect(tracked.closed()).toBe(1);
    await parsed.files[0]?.close();
    expect(tracked.closed()).toBe(2);
  });

  it("closes prior descriptors when a later marker fails", async () => {
    const workspace = await normalizedWorkspace();
    const valid = join(projectDirectory, "valid.txt");
    const missing = join(projectDirectory, "missing.txt");
    await writeFile(valid, "valid");
    const tracked = trackedOutboundFileSystem();

    await expect(
      parseDiscordFileMarkers(`[[discord_file:${valid}]]\n[[discord_file:${missing}]]`, {
        workspace,
        source: finalAssistantSource,
        fileSystem: tracked.fileSystem,
      }),
    ).rejects.toEqual(expectBridgeCode("NOT_FOUND"));
    expect(tracked.opened()).toBe(1);
    expect(tracked.closed()).toBe(1);
  });

  it("closes prior descriptors when filesystem parsing throws", async () => {
    const workspace = await normalizedWorkspace();
    const first = join(projectDirectory, "first.txt");
    const second = join(projectDirectory, "second.txt");
    await writeFile(first, "first");
    await writeFile(second, "second");
    const tracked = trackedOutboundFileSystem();
    const secondCanonical = await realpath(second);
    const fileSystem: OutboundFileSystem = {
      ...tracked.fileSystem,
      lstat: async (path) => {
        if (path === secondCanonical) {
          throw new Error("injected parser failure");
        }
        return lstat(path);
      },
    };

    await expect(
      parseDiscordFileMarkers(`[[discord_file:${first}]]\n[[discord_file:${second}]]`, {
        workspace,
        source: finalAssistantSource,
        fileSystem,
      }),
    ).rejects.toEqual(expectBridgeCode("INVALID_ARGUMENT"));
    expect(tracked.opened()).toBe(1);
    expect(tracked.closed()).toBe(1);
  });

  it("closes every descriptor when canonical attachments exceed the batch limit", async () => {
    const workspace = await normalizedWorkspace();
    const paths = Array.from({ length: 3 }, (_value, index) =>
      join(projectDirectory, `attachment-${String(index)}.txt`),
    );
    await Promise.all(paths.map((path) => writeFile(path, path)));
    const tracked = trackedOutboundFileSystem();

    await expect(
      parseDiscordFileMarkers(paths.map((path) => `[[discord_file:${path}]]`).join("\n"), {
        workspace,
        source: finalAssistantSource,
        fileSystem: tracked.fileSystem,
        maxAttachments: 2,
      }),
    ).rejects.toEqual(expectBridgeCode("INVALID_ARGUMENT"));
    expect(tracked.opened()).toBe(3);
    expect(tracked.closed()).toBe(3);
  });

  it("rejects oversized final text and marker paths before filesystem work", async () => {
    const workspace = await normalizedWorkspace();
    const filesystemCall = vi.fn(async () => {
      throw new Error("filesystem must not be reached");
    });
    const context = {
      workspace,
      source: finalAssistantSource,
      fileSystem: {
        lstat: filesystemCall,
        open: filesystemCall,
        realpath: filesystemCall,
        stat: filesystemCall,
      } as never,
    };

    await expect(
      parseDiscordFileMarkers(
        "x".repeat(DEFAULT_DISCORD_FILE_MARKER_LIMITS.textBytes + 1),
        context,
      ),
    ).rejects.toEqual(expectBridgeCode("INVALID_ARGUMENT"));
    await expect(
      parseDiscordFileMarkers(`[[discord_file:/long-path]]`, {
        ...context,
        maxMarkerLineBytes: 8,
      }),
    ).rejects.toEqual(expectBridgeCode("INVALID_ARGUMENT"));
    await expect(
      parseDiscordFileMarkers(`[[discord_file:/long-path]]`, {
        ...context,
        maxMarkerPathBytes: 4,
      }),
    ).rejects.toEqual(expectBridgeCode("INVALID_ARGUMENT"));
    expect(filesystemCall).not.toHaveBeenCalled();
  });

  it("allows ordinary long prose and minified JSON lines below the overall text limit", async () => {
    const workspace = await normalizedWorkspace();
    const prose = "x".repeat(4_096);
    const minified = JSON.stringify({ payload: "y".repeat(4_096) });
    const text = `${prose}\n${minified}`;

    await expect(
      parseDiscordFileMarkers(text, {
        workspace,
        source: finalAssistantSource,
        maxFinalAssistantTextBytes: 16 * 1024,
        maxMarkerLineBytes: 64,
        maxMarkerPathBytes: 32,
      }),
    ).resolves.toEqual({ visibleText: text, files: [] });
  });
});
