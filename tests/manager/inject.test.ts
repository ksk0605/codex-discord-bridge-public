import { mkdtemp, readFile, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveStatePaths, type StatePaths } from "../../src/config/paths.js";
import type { WorkspaceProfile } from "../../src/domain/schemas.js";
import { injectConfigPath } from "../../src/inject/config.js";
import {
  type InjectSocketServer,
  injectSocketPath,
  startInjectSocketServer,
} from "../../src/inject/socket.js";
import { ManagerService } from "../../src/manager/service.js";
import { RegistryStore } from "../../src/storage/registry.js";

const OWNER = "100000000000000001";
const THREAD = "20000000-0000-4000-8000-000000000001";
const INSTANCE = "00000000-0000-4000-8000-000000000001";

const workspace: WorkspaceProfile = {
  name: "main",
  cwd: "/tmp",
  sandbox: "workspace-write",
  approvalPolicy: "on-request",
  runtimeWorkspaceRoots: [],
};

let root: string;
let paths: StatePaths;
let service: ManagerService;
let server: InjectSocketServer | undefined;

beforeEach(async () => {
  // Short root so the socket path fits the macOS limit.
  root = await mkdtemp("/tmp/cdm-");
  paths = resolveStatePaths(root);
  service = new ManagerService({
    registry: new RegistryStore({ stateRoot: root }),
    keychain: {
      get: vi.fn(async () => "token"),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    },
    discord: {
      verify: vi.fn(async () => ({
        applicationId: "200000000000000001",
        botUserId: "300000000000000001",
      })),
      registerCommands: vi.fn(async () => undefined),
    },
    threads: {
      create: vi.fn(async () => ({ threadId: THREAD })),
      read: vi.fn(async () => ({ id: THREAD, cwd: "/tmp" })),
    },
    tmux: {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      hasSession: vi.fn(async () => false),
    },
    paths,
    createId: () => INSTANCE,
  });
  await service.registerBot({ name: "check-bot", ownerUserId: OWNER, token: "token" });
  await service.addWorkspace(workspace);
  await service.createAgent({ botName: "check-bot", workspaceName: "main", name: "check" });
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  await rm(root, { recursive: true, force: true });
});

describe("ManagerService inject", () => {
  it("sends the request to the agent's socket by agent name", async () => {
    const seen: unknown[] = [];
    server = await startInjectSocketServer({
      socketPath: injectSocketPath(paths, INSTANCE),
      handle: async (request) => {
        seen.push(request);
        return { ok: true, channelId: "400000000000000011", messageId: "500000000000000001" };
      },
    });

    const result = await service.inject("check", {
      text: "아침 브리핑",
      from: "cron:morning",
      mode: "queue",
      hop: 0,
    });

    expect(seen).toEqual([
      { version: 1, text: "아침 브리핑", from: "cron:morning", mode: "queue", hop: 0 },
    ]);
    expect(result).toEqual({
      agent: "check",
      channelId: "400000000000000011",
      messageId: "500000000000000001",
    });
  });

  it("turns a refused request into a failing command", async () => {
    server = await startInjectSocketServer({
      socketPath: injectSocketPath(paths, INSTANCE),
      handle: async () => ({
        ok: false,
        code: "RATE_LIMITED",
        message: "Inject request was rate-limited.",
        reason: "sender-cooldown",
      }),
    });

    await expect(
      service.inject("check", { text: "x", from: "cron:morning", mode: "queue", hop: 0 }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("sender-cooldown"),
    });
  });

  it("reports an unknown agent", async () => {
    await expect(
      service.inject("nobody", { text: "x", from: "cron:morning", mode: "queue", hop: 0 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("writes the agent's inject config and says a restart is needed", async () => {
    const result = await service.configureInject("check", {
      enabled: true,
      logChannelId: "400000000000000020",
    });

    expect(result).toEqual({ agent: "check", enabled: true, restartRequired: true });
    const written = JSON.parse(
      await readFile(injectConfigPath(paths.instanceDirectory(INSTANCE)), "utf8"),
    );
    expect(written).toEqual({
      version: 1,
      enabled: true,
      logChannelId: "400000000000000020",
    });
  });
});
