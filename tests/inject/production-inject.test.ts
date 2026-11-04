import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscordTurnSource } from "../../src/app-server/session.js";
import {
  ensureStateDirectories,
  resolveStatePaths,
  type StatePaths,
} from "../../src/config/paths.js";
import type { DiscordGatewayTransport } from "../../src/discord/adapter.js";
import type { AgentBinding, RegistryDocument, WorkspaceProfile } from "../../src/domain/schemas.js";
import { injectConfigPath, writeInjectConfig } from "../../src/inject/config.js";
import { INJECT_MARKER } from "../../src/inject/service.js";
import { injectSocketPath, sendInjectRequest } from "../../src/inject/socket.js";
import type { AgentRuntimeEvent, AgentRuntimeSession } from "../../src/runtime/agent-runtime.js";
import { createProductionAgentComponent } from "../../src/runtime/production-agent.js";

const BINDING_ID = "11111111-1111-4111-8111-111111111111";
const THREAD_ID = "22222222-2222-4222-8222-222222222222";
const TURN_ID = "44444444-4444-4444-8444-444444444441";
const BOT_USER = "100000000000000002";
const CHANNEL = "200000000000000001";
const LOG_CHANNEL = "200000000000000009";
const GUILD = "300000000000000001";
const POSTED = "600000000000000001";

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
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
};

function document(): RegistryDocument {
  return {
    version: 1,
    bots: {
      "bot-one": {
        name: "bot-one",
        applicationId: "100000000000000001",
        botUserId: BOT_USER,
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
        groups: { [CHANNEL]: { requireMention: false, allowFrom: [] } },
        pendingPairings: {},
        mentionPatterns: [],
        ackReaction: "ok",
        replyToMode: "first",
        textChunkLimit: 2_000,
        chunkMode: "length",
      },
    },
    workspaces: { main: workspace },
    bindings: { [BINDING_ID]: binding },
  };
}

function transport(): DiscordGatewayTransport {
  return {
    onMessage: vi.fn(() => vi.fn()),
    onCommand: vi.fn(() => vi.fn()),
    onButton: vi.fn(() => vi.fn()),
    login: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
    sendTyping: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => ({ id: POSTED, guildId: GUILD })),
    sendFile: vi.fn(async () => ({ id: "600000000000000002" })),
    sendDirectMessage: vi.fn(async () => ({ id: "dm" })),
    // Discord gives a thread started from a message the same ID as that message.
    createProgressThread: vi.fn(async (channelId, sourceMessageId) => ({
      id: sourceMessageId,
      parentId: channelId,
      ownerId: BOT_USER,
    })),
    editMessage: vi.fn(async (_channelId, messageId) => ({ id: messageId })),
    setProgressThreadState: vi.fn(async () => undefined),
    inspectThread: vi.fn(async (threadId) => ({
      status: "found" as const,
      id: threadId,
      parentId: CHANNEL,
      ownerId: BOT_USER,
      archived: false,
      locked: false,
    })),
    inspectProgressCapabilities: vi.fn(async () => ({
      createPublicThreads: true,
      sendMessagesInThreads: true,
      manageThreads: true,
    })),
  };
}

function session(starts: Array<{ input: string; source: DiscordTurnSource }>) {
  const listeners = new Map<string, Set<(event: AgentRuntimeEvent) => void>>();
  const value: AgentRuntimeSession = {
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
    startTurn: vi.fn(async (_threadId, input, source) => {
      starts.push({ input, source });
      return { turnId: TURN_ID };
    }),
    interrupt: vi.fn(async () => undefined),
    onNotification: (method, listener) => {
      const registered = listeners.get(method) ?? new Set();
      registered.add(listener as (event: AgentRuntimeEvent) => void);
      listeners.set(method, registered);
      return () => registered.delete(listener as (event: AgentRuntimeEvent) => void);
    },
    onSendFileRequest: () => () => undefined,
    authorizeSendFile: vi.fn(async () => {
      throw new Error("unused");
    }),
  };
  const emit = (event: AgentRuntimeEvent) => {
    for (const listener of listeners.get(event.method) ?? []) listener(event);
  };
  return { value, emit };
}

let root: string;
let paths: StatePaths;

beforeEach(async () => {
  // A short root keeps the socket path under the 103-byte macOS limit.
  root = await mkdtemp("/tmp/cdb-");
  paths = resolveStatePaths(root);
  await ensureStateDirectories(paths);
  await mkdir(paths.instanceDirectory(BINDING_ID), { mode: 0o700, recursive: true });
  await mkdir(paths.instanceInboxDirectory(BINDING_ID), { mode: 0o700, recursive: true });
  await writeFile(paths.registryPath, `${JSON.stringify(document())}\n`, { mode: 0o600 });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function component(discord: DiscordGatewayTransport, codex: AgentRuntimeSession) {
  const current = document();
  return createProductionAgentComponent(
    {
      binding,
      bot: current.bots["bot-one"] as NonNullable<(typeof current.bots)["bot-one"]>,
      workspace,
      token: "test-token",
      paths,
      requestShutdown: vi.fn(),
    },
    {
      createTransport: () => discord,
      createAppServer: () => ({
        start: vi.fn(async () => codex),
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
}

describe("inject in the production agent", () => {
  it("does not open a socket unless inject is enabled", async () => {
    const starts: Array<{ input: string; source: DiscordTurnSource }> = [];
    const agent = await component(transport(), session(starts).value);
    await agent.start();

    await expect(lstat(injectSocketPath(paths, BINDING_ID))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await agent.stop();
  });

  it("turns an injected request into a visible Discord message and a Codex turn", async () => {
    await writeInjectConfig(injectConfigPath(paths.instanceDirectory(BINDING_ID)), {
      enabled: true,
      logChannelId: LOG_CHANNEL,
    });
    const discord = transport();
    const starts: Array<{ input: string; source: DiscordTurnSource }> = [];
    const codex = session(starts);
    const agent = await component(discord, codex.value);
    await agent.start();
    const socketPath = injectSocketPath(paths, BINDING_ID);

    const response = await sendInjectRequest(socketPath, {
      version: 1,
      text: "아침 브리핑 만들어서 올려",
      from: "cron:morning",
    });

    expect(response).toEqual({ ok: true, channelId: CHANNEL, messageId: POSTED });
    const sends = vi.mocked(discord.sendMessage).mock.calls;
    expect(sends[0]?.[0]).toBe(CHANNEL);
    expect(sends[0]?.[1].content.startsWith(INJECT_MARKER)).toBe(true);
    expect(sends.some(([channelId]) => channelId === LOG_CHANNEL)).toBe(true);
    await vi.waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]?.input).toContain("아침 브리핑 만들어서 올려");
    expect(starts[0]?.input).toContain(INJECT_MARKER);
    expect(starts[0]?.source).toMatchObject({
      channelId: CHANNEL,
      messageId: POSTED,
      authorId: BOT_USER,
      guildId: GUILD,
    });

    codex.emit({
      method: "item/started",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: "final-1",
      kind: "agentMessage",
      phase: "final_answer",
    } as never);
    codex.emit({
      method: "item/agentMessage/delta",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: "final-1",
      delta: "브리핑 올렸어요",
    } as never);
    codex.emit({
      method: "item/completed",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: "final-1",
      kind: "agentMessage",
      phase: "final_answer",
      text: "브리핑 올렸어요",
    } as never);
    codex.emit({ method: "turn/completed", threadId: THREAD_ID, turnId: TURN_ID });

    // The agent's answer must reach Discord as a reply to the injected message.
    await vi.waitFor(() =>
      expect(
        vi
          .mocked(discord.sendMessage)
          .mock.calls.some(
            ([channelId, payload]) =>
              channelId === CHANNEL &&
              payload.content.includes("브리핑 올렸어요") &&
              payload.replyToMessageId === POSTED,
          ),
      ).toBe(true),
    );
    expect(
      vi
        .mocked(discord.sendMessage)
        .mock.calls.some(([, payload]) => payload.content.includes("delivery failed")),
    ).toBe(false);
    await agent.stop();
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
