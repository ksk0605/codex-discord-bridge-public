import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveStatePaths } from "../src/config/paths.js";
import type {
  AgentBinding,
  BotCredentialMetadata,
  WorkspaceProfile,
} from "../src/domain/schemas.js";
import { AgentRunner, RUNNER_RESTART_EXIT_CODE } from "../src/runner.js";

const INSTANCE = "00000000-0000-4000-8000-000000000001";
const temporary: string[] = [];

const binding: AgentBinding = {
  id: INSTANCE,
  name: "agent-one",
  botName: "bot-one",
  threadId: "10000000-0000-4000-8000-000000000001",
  previousThreadIds: [],
  workspace: "main",
  tmuxSession: "codex-discord-agent-one",
  desiredState: "running",
  observedState: "stopped",
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
};

const bot: BotCredentialMetadata = {
  name: "bot-one",
  applicationId: "200000000000000001",
  botUserId: "300000000000000001",
  keychainAccount: "bot-one",
  ownerUserId: "400000000000000001",
  ownerConfirmedAt: "2026-07-28T00:00:00.000Z",
  state: "bound",
};

const workspace: WorkspaceProfile = {
  name: "main",
  cwd: "/tmp",
  sandbox: "workspace-write",
  approvalPolicy: "on-request",
  runtimeWorkspaceRoots: [],
};

async function statePaths() {
  const root = await mkdtemp(join(tmpdir(), "codex-discord-runner-"));
  temporary.push(root);
  return resolveStatePaths(root);
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function dependencies(paths: ReturnType<typeof resolveStatePaths>) {
  const component = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  const registry = {
    load: vi.fn(async () => ({ binding, bot, workspace })),
    markState: vi.fn(async () => undefined),
  };
  const keychain = { get: vi.fn(async () => "secret-discord-token") };
  const createComponent = vi.fn(async () => component);
  const runner = new AgentRunner({
    instanceId: INSTANCE,
    paths,
    registry,
    keychain,
    createComponent,
    heartbeatIntervalMs: 10_000,
  });
  return { runner, registry, keychain, createComponent, component };
}

describe("AgentRunner", () => {
  it("acquires the exclusive instance lock before reading the token", async () => {
    const paths = await statePaths();
    const context = dependencies(paths);
    context.keychain.get.mockImplementationOnce(async () => {
      await access(join(paths.instanceDirectory(INSTANCE), "runner.lock"));
      return "secret-discord-token";
    });

    await context.runner.start();

    expect(context.createComponent).toHaveBeenCalledWith(
      expect.objectContaining({ binding, bot, workspace, token: "secret-discord-token" }),
    );
    const heartbeat = await readFile(
      join(paths.instanceDirectory(INSTANCE), "heartbeat.json"),
      "utf8",
    );
    expect(heartbeat).not.toContain("secret-discord-token");
    await context.runner.shutdown();
  });

  it("prevents a second runner for the same instance", async () => {
    const paths = await statePaths();
    const first = dependencies(paths);
    const second = dependencies(paths);
    await first.runner.start();

    await expect(second.runner.start()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(second.keychain.get).not.toHaveBeenCalled();
    await first.runner.shutdown();
  });

  it("recovers a well-formed lock left by a dead runner process", async () => {
    const paths = await statePaths();
    const directory = paths.instanceDirectory(INSTANCE);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "runner.lock"),
      `${JSON.stringify({ version: 1, instanceId: INSTANCE, pid: 2_147_483_647 })}\n`,
      "utf8",
    );
    const context = dependencies(paths);

    await context.runner.start();

    expect(context.keychain.get).toHaveBeenCalledOnce();
    await context.runner.shutdown();
  });

  it("stops the component and removes heartbeat and lock state", async () => {
    const paths = await statePaths();
    const context = dependencies(paths);
    await context.runner.start();

    expect(await context.runner.shutdown()).toBe(0);
    expect(context.component.stop).toHaveBeenCalledOnce();
    await expect(
      access(join(paths.instanceDirectory(INSTANCE), "heartbeat.json")),
    ).rejects.toThrow();
    await expect(access(join(paths.instanceDirectory(INSTANCE), "runner.lock"))).rejects.toThrow();
    expect(context.registry.markState).toHaveBeenLastCalledWith("stopped");
  });

  it("returns the dedicated supervisor restart exit code", async () => {
    const paths = await statePaths();
    const context = dependencies(paths);
    await context.runner.start();

    expect(await context.runner.shutdown({ restart: true })).toBe(RUNNER_RESTART_EXIT_CODE);
  });
});
