import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveStatePaths } from "../../src/config/paths.js";
import { AtomicProgressObservationJournal } from "../../src/discord/progress-journal.js";
import { BridgeError } from "../../src/domain/errors.js";
import type { WorkspaceProfile } from "../../src/domain/schemas.js";
import { ManagerService } from "../../src/manager/service.js";
import { RegistryStore } from "../../src/storage/registry.js";

const OWNER = "100000000000000001";
const THREAD = "20000000-0000-4000-8000-000000000001";
const INSTANCE = "00000000-0000-4000-8000-000000000001";
const OTHER_INSTANCE = "00000000-0000-4000-8000-000000000002";
const PROGRESS_THREAD = "400000000000000001";
const ACTIVE_PROGRESS_THREAD = "400000000000000002";
const OTHER_PROGRESS_THREAD = "400000000000000003";
const CHANNEL_ONE = "400000000000000011";
const CHANNEL_TWO = "400000000000000012";
const temporary: string[] = [];

const workspace: WorkspaceProfile = {
  name: "main",
  cwd: "/tmp",
  sandbox: "workspace-write",
  approvalPolicy: "on-request",
  runtimeWorkspaceRoots: [],
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "codex-discord-manager-"));
  temporary.push(root);
  const paths = resolveStatePaths(root);
  const registry = new RegistryStore({ stateRoot: root });
  const keychain = {
    get: vi.fn(async () => "discord-secret-token"),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
  const discord = {
    verify: vi.fn(async () => ({
      applicationId: "200000000000000001",
      botUserId: "300000000000000001",
    })),
    registerCommands: vi.fn(async () => undefined),
  };
  const threads = {
    create: vi.fn(async () => ({ threadId: THREAD })),
    read: vi.fn(async () => ({ id: THREAD, cwd: "/tmp" })),
  };
  const tmux = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    hasSession: vi.fn(async () => false),
  };
  const service = new ManagerService({
    registry,
    keychain,
    discord,
    threads,
    tmux,
    paths,
    createId: () => INSTANCE,
  });
  return { service, registry, keychain, discord, threads, tmux, paths };
}

async function progressRecord(
  journal: AtomicProgressObservationJournal,
  threadId: string,
  terminal: boolean,
): Promise<void> {
  const timestamp = "2026-07-31T00:00:00.000Z";
  await journal.beginCreation({
    createdAt: timestamp,
    source: {
      channelId: "300000000000000001",
      guildId: "200000000000000001",
      messageId: threadId,
    },
    threadCreationExpected: true,
  });
  await journal.confirmDestination(
    threadId,
    {
      kind: "thread",
      ownerId: "100000000000000001",
      parentChannelId: "300000000000000001",
      threadId,
    },
    timestamp,
  );
  await journal.markPreparing(threadId, timestamp);
  await journal.markQueued(threadId, timestamp);
  await journal.markRunning(threadId, "50000000-0000-4000-8000-000000000001", timestamp);
  if (terminal) await journal.close(threadId, "completed", timestamp);
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("ManagerService", () => {
  it("registers a verified bot while keeping the token out of registry metadata", async () => {
    const context = await fixture();

    const registered = await context.service.registerBot({
      name: "bot-one",
      ownerUserId: OWNER,
      token: "discord-secret-token",
    });

    expect(context.discord.verify).toHaveBeenCalledWith("discord-secret-token");
    expect(context.keychain.set).toHaveBeenCalledWith("bot-one", "discord-secret-token");
    expect(context.discord.registerCommands).toHaveBeenCalledWith(
      "200000000000000001",
      "discord-secret-token",
    );
    expect(JSON.stringify(registered)).not.toContain("discord-secret-token");
    expect((await context.registry.read()).bots["bot-one"]?.state).toBe("registered");
  });

  it("re-registers commands for an existing bot with its Keychain token", async () => {
    const context = await fixture();
    await context.service.registerBot({
      name: "bot-one",
      ownerUserId: OWNER,
      token: "discord-secret-token",
    });
    context.discord.registerCommands.mockClear();

    await context.service.registerBotCommands("bot-one");

    expect(context.keychain.get).toHaveBeenCalledWith("bot-one");
    expect(context.discord.registerCommands).toHaveBeenCalledExactlyOnceWith(
      "200000000000000001",
      "discord-secret-token",
    );
  });

  it("creates a thread, commits a 1:1 binding, and starts detached tmux", async () => {
    const context = await fixture();
    await context.service.registerBot({ name: "bot-one", ownerUserId: OWNER, token: "secret" });
    await context.service.addWorkspace(workspace);

    const binding = await context.service.createAgent({
      botName: "bot-one",
      workspaceName: "main",
      name: "agent-one",
    });

    expect(context.threads.create).toHaveBeenCalledWith(
      workspace,
      context.paths.instanceInboxDirectory(INSTANCE),
      INSTANCE,
    );
    expect(binding.threadId).toBe(THREAD);
    expect(binding.botName).toBe("bot-one");
    expect(context.tmux.start).toHaveBeenCalledWith(INSTANCE, binding.tmuxSession);
  });

  it("links an existing thread stopped unless start is explicit", async () => {
    const context = await fixture();
    await context.service.registerBot({ name: "bot-one", ownerUserId: OWNER, token: "secret" });
    await context.service.addWorkspace(workspace);

    const binding = await context.service.linkAgent({
      botName: "bot-one",
      workspaceName: "main",
      threadId: THREAD,
      name: "linked-agent",
    });

    expect(context.threads.read).toHaveBeenCalledWith(THREAD);
    expect(binding.desiredState).toBe("stopped");
    expect(context.tmux.start).not.toHaveBeenCalled();
  });

  it("spawns only an unbound bot owned by the Discord caller", async () => {
    const context = await fixture();
    await context.service.registerBot({ name: "bot-one", ownerUserId: OWNER, token: "secret" });
    await context.service.addWorkspace(workspace);

    await expect(
      context.service.spawnForOwner("100000000000000099", "bot-one", "main"),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const binding = await context.service.spawnForOwner(OWNER, "bot-one", "main");

    expect(binding.botName).toBe("bot-one");
    expect(context.tmux.start).toHaveBeenCalledOnce();
  });

  it("provisions a bot, existing workspace, channels, thread, and tmux in one operation", async () => {
    const context = await fixture();
    await context.service.addWorkspace(workspace);

    const provisioned = await context.service.provisionAgent({
      botName: "bot-one",
      ownerUserId: OWNER,
      token: "discord-secret-token",
      workspace: { kind: "existing", name: "main" },
      channelIds: [CHANNEL_ONE, CHANNEL_TWO],
      requireMention: false,
      name: "agent-one",
    });

    expect(provisioned).toMatchObject({
      bot: { name: "bot-one", ownerUserId: OWNER },
      workspace,
      channelIds: [CHANNEL_ONE, CHANNEL_TWO],
      access: {
        groups: {
          [CHANNEL_ONE]: { allowFrom: [], requireMention: false },
          [CHANNEL_TWO]: { allowFrom: [], requireMention: false },
        },
      },
      binding: { botName: "bot-one", name: "agent-one", workspace: "main" },
    });
    expect(Object.isFrozen(provisioned)).toBe(true);
    expect(Object.isFrozen(provisioned.channelIds)).toBe(true);
    expect(context.discord.verify).toHaveBeenCalledExactlyOnceWith("discord-secret-token");
    expect(context.discord.registerCommands).toHaveBeenCalledExactlyOnceWith(
      "200000000000000001",
      "discord-secret-token",
    );
    expect(context.keychain.set).toHaveBeenCalledExactlyOnceWith("bot-one", "discord-secret-token");
    expect(context.threads.create).toHaveBeenCalledExactlyOnceWith(
      workspace,
      context.paths.instanceInboxDirectory(INSTANCE),
      INSTANCE,
    );
    expect(context.tmux.start).toHaveBeenCalledOnce();
    expect(JSON.stringify(provisioned)).not.toContain("discord-secret-token");
  });

  it("provisions an agent for any existing absolute project directory", async () => {
    const context = await fixture();
    const project = await mkdtemp(join(tmpdir(), "codex-discord-project-"));
    temporary.push(project);
    const canonicalProject = await realpath(project);

    const provisioned = await context.service.provisionAgent({
      botName: "bot-one",
      ownerUserId: OWNER,
      token: "discord-secret-token",
      workspace: { kind: "cwd", cwd: project },
      channelIds: [CHANNEL_ONE],
      requireMention: true,
    });

    expect(provisioned.workspace).toEqual({
      name: "bot-one-workspace",
      cwd: canonicalProject,
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      runtimeWorkspaceRoots: [],
    });
    expect((await context.registry.read()).workspaces["bot-one-workspace"]).toEqual(
      provisioned.workspace,
    );
    expect(provisioned.access.groups[CHANNEL_ONE]).toEqual({
      allowFrom: [],
      requireMention: true,
    });
    expect(provisioned.binding.name).toBe("bot-one-agent");
  });

  it("rejects malformed provisioning input before Discord or Keychain side effects", async () => {
    const missingFile = join(tmpdir(), `codex-discord-missing-${Date.now()}`);
    const regularFileRoot = await mkdtemp(join(tmpdir(), "codex-discord-file-"));
    temporary.push(regularFileRoot);
    const regularFile = join(regularFileRoot, "project.txt");
    await writeFile(regularFile, "not a directory", { mode: 0o600 });

    const inputs = [
      {
        botName: "INVALID",
        ownerUserId: OWNER,
        token: "discord-secret-token",
        workspace: { kind: "existing", name: "main" },
        channelIds: [CHANNEL_ONE],
        requireMention: false,
      },
      {
        botName: "bot-one",
        ownerUserId: "invalid-owner",
        token: "discord-secret-token",
        workspace: { kind: "existing", name: "main" },
        channelIds: [CHANNEL_ONE],
        requireMention: false,
      },
      {
        botName: "bot-one",
        ownerUserId: OWNER,
        token: "discord-secret-token",
        workspace: { kind: "existing", name: "missing" },
        channelIds: [CHANNEL_ONE],
        requireMention: false,
      },
      {
        botName: "bot-one",
        ownerUserId: OWNER,
        token: "discord-secret-token",
        workspace: { kind: "existing", name: "main" },
        channelIds: [],
        requireMention: false,
      },
      {
        botName: "bot-one",
        ownerUserId: OWNER,
        token: "discord-secret-token",
        workspace: { kind: "existing", name: "main" },
        channelIds: [CHANNEL_ONE, CHANNEL_ONE],
        requireMention: false,
      },
      {
        botName: "bot-one",
        ownerUserId: OWNER,
        token: "discord-secret-token",
        workspace: { kind: "existing", name: "main" },
        channelIds: ["invalid-channel"],
        requireMention: false,
      },
      {
        botName: "bot-one",
        ownerUserId: OWNER,
        token: "discord-secret-token",
        workspace: { kind: "cwd", cwd: "relative/project" },
        channelIds: [CHANNEL_ONE],
        requireMention: false,
      },
      {
        botName: "bot-one",
        ownerUserId: OWNER,
        token: "discord-secret-token",
        workspace: { kind: "cwd", cwd: missingFile },
        channelIds: [CHANNEL_ONE],
        requireMention: false,
      },
      {
        botName: "bot-one",
        ownerUserId: OWNER,
        token: "discord-secret-token",
        workspace: { kind: "cwd", cwd: regularFile },
        channelIds: [CHANNEL_ONE],
        requireMention: false,
      },
    ] as const;

    for (const input of inputs) {
      const context = await fixture();
      await context.service.addWorkspace(workspace);
      await expect(context.service.provisionAgent(input)).rejects.toMatchObject({
        code: expect.stringMatching(/INVALID_ARGUMENT|NOT_FOUND/u),
      });
      expect(context.discord.verify).not.toHaveBeenCalled();
      expect(context.discord.registerCommands).not.toHaveBeenCalled();
      expect(context.keychain.set).not.toHaveBeenCalled();
    }
  });

  it("rejects a generated workspace conflict before storing the token", async () => {
    const context = await fixture();
    const project = await mkdtemp(join(tmpdir(), "codex-discord-project-"));
    temporary.push(project);
    await context.service.addWorkspace({ ...workspace, name: "bot-one-workspace" });

    await expect(
      context.service.provisionAgent({
        botName: "bot-one",
        ownerUserId: OWNER,
        token: "discord-secret-token",
        workspace: { kind: "cwd", cwd: project },
        channelIds: [CHANNEL_ONE],
        requireMention: false,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(context.discord.verify).not.toHaveBeenCalled();
    expect(context.keychain.set).not.toHaveBeenCalled();
  });

  it("preserves completed setup and reports a secret-free create recovery command", async () => {
    const context = await fixture();
    await context.service.addWorkspace(workspace);
    context.threads.create.mockRejectedValueOnce(new Error("discord-secret-token"));

    const error = await context.service
      .provisionAgent({
        botName: "bot-one",
        ownerUserId: OWNER,
        token: "discord-secret-token",
        workspace: { kind: "existing", name: "main" },
        channelIds: [CHANNEL_ONE],
        requireMention: false,
        name: "agent-one",
      })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "RUNTIME",
      remediation:
        "Retry with `node dist/cli.js create bot-one --workspace main --name agent-one`.",
    });
    expect(error).toBeInstanceOf(BridgeError);
    if (!(error instanceof BridgeError)) throw error;
    expect(String(error)).not.toContain("discord-secret-token");
    expect(error.remediation).not.toContain("discord-secret-token");
    const persisted = await context.registry.read();
    expect(persisted.bots["bot-one"]?.state).toBe("registered");
    expect(persisted.access["bot-one"]?.groups[CHANNEL_ONE]).toEqual({
      allowFrom: [],
      requireMention: false,
    });
    expect(Object.keys(persisted.bindings)).toHaveLength(0);
  });

  it("controls an exact binding target without unlinking its thread", async () => {
    const context = await fixture();
    await context.service.registerBot({ name: "bot-one", ownerUserId: OWNER, token: "secret" });
    await context.service.addWorkspace(workspace);
    const binding = await context.service.linkAgent({
      botName: "bot-one",
      workspaceName: "main",
      threadId: THREAD,
      name: "agent-one",
    });

    await context.service.start(binding.id);
    await context.service.stop("agent-one");

    expect(context.tmux.start).toHaveBeenCalledWith(binding.id, binding.tmuxSession);
    expect(context.tmux.stop).toHaveBeenCalledWith(binding.tmuxSession, { force: false });
    expect((await context.registry.read()).bindings[binding.id]?.threadId).toBe(THREAD);
  });

  it("records an idempotent local reconciliation request only for a terminal agent tombstone", async () => {
    const context = await fixture();
    await context.service.registerBot({ name: "bot-one", ownerUserId: OWNER, token: "secret" });
    await context.service.addWorkspace(workspace);
    const binding = await context.service.linkAgent({
      botName: "bot-one",
      workspaceName: "main",
      threadId: THREAD,
      name: "agent-one",
    });
    const journal = new AtomicProgressObservationJournal({
      filePath: join(context.paths.instanceDirectory(binding.id), "progress-observations.json"),
    });
    await progressRecord(journal, PROGRESS_THREAD, true);
    await progressRecord(journal, ACTIVE_PROGRESS_THREAD, false);
    context.discord.verify.mockResolvedValueOnce({
      applicationId: "200000000000000002",
      botUserId: "300000000000000002",
    });
    await context.service.registerBot({
      name: "bot-two",
      ownerUserId: OWNER,
      token: "other-secret",
    });
    await mkdir(context.paths.instanceDirectory(OTHER_INSTANCE), {
      mode: 0o700,
      recursive: true,
    });
    await context.registry.createBinding({
      id: OTHER_INSTANCE,
      name: "agent-two",
      botName: "bot-two",
      threadId: "20000000-0000-4000-8000-000000000002",
      workspace: "main",
      tmuxSession: "codex-discord-other",
    });
    const otherJournal = new AtomicProgressObservationJournal({
      filePath: join(context.paths.instanceDirectory(OTHER_INSTANCE), "progress-observations.json"),
    });
    await progressRecord(otherJournal, OTHER_PROGRESS_THREAD, true);
    context.discord.verify.mockClear();
    context.discord.registerCommands.mockClear();

    await expect(
      context.service.requestProgressReconciliation("agent-one", PROGRESS_THREAD),
    ).resolves.toEqual({
      agentId: binding.id,
      agentName: "agent-one",
      reconciliationRequested: true,
      restartRequired: true,
      threadId: PROGRESS_THREAD,
    });
    await context.service.requestProgressReconciliation(binding.id, PROGRESS_THREAD);

    expect((await journal.get(PROGRESS_THREAD))?.reconciliationRequestedAt).toBeTypeOf("string");
    await expect(
      context.service.requestProgressReconciliation(binding.id, ACTIVE_PROGRESS_THREAD),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      context.service.requestProgressReconciliation(binding.id, "not-a-snowflake"),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      context.service.requestProgressReconciliation(binding.id, OTHER_PROGRESS_THREAD),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(context.discord.verify).not.toHaveBeenCalled();
    expect(context.discord.registerCommands).not.toHaveBeenCalled();
  });
});
