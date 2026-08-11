import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ZodError, z } from "zod";
import {
  ensureStateDirectories,
  resolveStatePaths,
  type StatePaths,
} from "../../src/config/paths.js";
import { BridgeError, type BridgeErrorCode } from "../../src/domain/errors.js";
import {
  type AccessPolicy,
  AccessPolicySchema,
  AgentBindingSchema,
  type BotCredentialMetadata,
  ModelIdSchema,
  ReasoningEffortSchema,
  RegistryDocumentSchema,
  ThreadIdSchema,
  type WorkspaceProfile,
  WorkspaceProfileSchema,
} from "../../src/domain/schemas.js";
import {
  type AtomicJsonEvent,
  AtomicJsonStore,
  type AtomicWriteFaultPoint,
} from "../../src/storage/atomic-json.js";
import { accessPolicyRevision, RegistryStore } from "../../src/storage/registry.js";

const NOW = "2026-07-24T10:00:00.000Z";
const LATER = "2026-07-24T11:00:00.000Z";

const BOT_ONE_APPLICATION_ID = "100000000000000001";
const BOT_ONE_USER_ID = "200000000000000001";
const BOT_TWO_APPLICATION_ID = "100000000000000002";
const BOT_TWO_USER_ID = "200000000000000002";
const OWNER_ONE_ID = "300000000000000001";
const OWNER_TWO_ID = "300000000000000002";
const EXPLICIT_USER_ID = "300000000000000003";
const SECOND_EXPLICIT_USER_ID = "300000000000000004";
const DM_CHANNEL_ID = "400000000000000001";
const SECOND_DM_CHANNEL_ID = "400000000000000002";

const BINDING_ONE_ID = "00000000-0000-4000-8000-000000000001";
const BINDING_TWO_ID = "00000000-0000-4000-8000-000000000002";
const THREAD_ONE_ID = "10000000-0000-4000-8000-000000000001";
const THREAD_TWO_ID = "10000000-0000-4000-8000-000000000002";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

type TestLockRelease = () => Promise<void>;
type TestLockAdapter = (
  targetPath: string,
  acquire: () => Promise<TestLockRelease>,
) => Promise<TestLockRelease>;

function failAfterSuccessfulUnlock(error: unknown): TestLockAdapter {
  return async (_targetPath, acquire) => {
    const release = await acquire();
    return async () => {
      await release();
      throw error;
    };
  };
}

function retainProperLockOnRelease(): TestLockAdapter {
  return async (targetPath, acquire) => {
    const release = await acquire();
    await writeFile(join(`${targetPath}.lock`, "release-blocker"), "retain lock\n", "utf8");
    return release;
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function makeStatePath(): Promise<{ directory: string; registryPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "codex-discord-registry-"));
  temporaryDirectories.push(directory);
  return {
    directory,
    registryPath: join(directory, "state", "registry.json"),
  };
}

function bot(overrides: Partial<BotCredentialMetadata> = {}): BotCredentialMetadata {
  return {
    name: "bot-one",
    applicationId: BOT_ONE_APPLICATION_ID,
    botUserId: BOT_ONE_USER_ID,
    keychainAccount: "codex-discord-bot-one",
    ownerUserId: OWNER_ONE_ID,
    state: "registered",
    ...overrides,
  };
}

function workspace(overrides: Partial<WorkspaceProfile> = {}): WorkspaceProfile {
  return {
    name: "main-workspace",
    cwd: "/tmp/project",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    runtimeWorkspaceRoots: ["/tmp/project-shared"],
    ...overrides,
  };
}

function accessPolicy(
  ownerUserId = OWNER_ONE_ID,
  overrides: Partial<AccessPolicy> = {},
): AccessPolicy {
  return {
    dmPolicy: "pairing",
    allowFrom: [ownerUserId],
    groups: {},
    pendingPairings: {},
    mentionPatterns: [],
    ackReaction: "\u2705",
    replyToMode: "first",
    textChunkLimit: 2_000,
    chunkMode: "length",
    ...overrides,
  };
}

function revisionFor(policy: AccessPolicy): string {
  return accessPolicyRevision(policy);
}

async function casUpdateAccess(
  registry: RegistryStore,
  botName: string,
  expectedRevision: string,
  nextPolicy: AccessPolicy,
): Promise<AccessPolicy> {
  return registry.updateAccess(botName, expectedRevision, nextPolicy);
}

async function updateCurrentAccess(
  registry: RegistryStore,
  botName: string,
  mutate: (current: AccessPolicy) => AccessPolicy,
): Promise<AccessPolicy> {
  const current = (await registry.read()).access[botName];
  if (current === undefined) {
    throw new Error(`Expected access policy for ${botName}`);
  }
  return casUpdateAccess(registry, botName, revisionFor(current), mutate(current));
}

function bindingInput(
  overrides: Partial<Parameters<RegistryStore["createBinding"]>[0]> = {},
): Parameters<RegistryStore["createBinding"]>[0] {
  return {
    id: BINDING_ONE_ID,
    name: "agent-one",
    botName: "bot-one",
    threadId: THREAD_ONE_ID,
    workspace: "main-workspace",
    tmuxSession: "codex-discord-agent-one",
    ...overrides,
  };
}

async function createRegistry(
  options: ConstructorParameters<typeof RegistryStore>[0] extends infer Options
    ? Omit<Extract<Options, object>, "registryPath">
    : never = {},
): Promise<{
  directory: string;
  registryPath: string;
  registry: RegistryStore;
}> {
  const paths = await makeStatePath();
  return {
    ...paths,
    registry: new RegistryStore({
      registryPath: paths.registryPath,
      now: () => new Date(NOW),
      ...options,
    }),
  };
}

async function seedBindableRegistry(registry: RegistryStore): Promise<void> {
  await registry.registerBot(bot());
  await registry.addWorkspace(workspace());
}

async function expectBridgeError(
  promise: Promise<unknown>,
  code: BridgeErrorCode,
): Promise<BridgeError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BridgeError);
    expect(error).toMatchObject({ code });
    return error as BridgeError;
  }

  throw new Error(`Expected BridgeError with code ${code}`);
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("Expected operation to fail");
}

function expectSynchronousBridgeError(
  operation: () => unknown,
  code: BridgeErrorCode,
): BridgeError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(BridgeError);
    expect(error).toMatchObject({ code });
    return error as BridgeError;
  }

  throw new Error(`Expected BridgeError with code ${code}`);
}

describe("state path validation", () => {
  it.each([
    ["empty string", ""],
    ["number", 42],
    ["null", null],
    ["NUL byte", "invalid\0path"],
  ] as const)("rejects a malformed root override: %s", (_label, rootOverride) => {
    const error = expectSynchronousBridgeError(
      () => resolveStatePaths(rootOverride as string),
      "INVALID_ARGUMENT",
    );

    expect(error.cause).toBeInstanceOf(ZodError);
  });

  it.each([
    ["instanceDirectory", "not-a-uuid"],
    ["instanceDirectory", 42],
    ["instanceInboxDirectory", "not-a-uuid"],
    ["instanceInboxDirectory", 42],
    ["instanceLogPath", "not-a-uuid"],
    ["instanceLogPath", 42],
    ["progressJournalPath", ""],
    ["progressJournalPath", "not-a-uuid"],
    ["progressJournalPath", "../00000000-0000-4000-8000-000000000001"],
    ["progressJournalPath", "00000000-0000-4000-8000-000000000001/child"],
    ["progressJournalPath", 42],
  ] as const)("rejects malformed %s input", (resolverName, instanceId) => {
    const paths = resolveStatePaths("/tmp/codex-discord-path-test");
    const resolver = paths[resolverName];
    const error = expectSynchronousBridgeError(
      () => resolver(instanceId as string),
      "INVALID_ARGUMENT",
    );

    expect(error.cause).toBeInstanceOf(ZodError);
  });

  it.each(["root", "instancesDirectory", "inboxDirectory", "logsDirectory"] as const)(
    "rejects a malformed %s before filesystem access",
    async (field) => {
      const paths = resolveStatePaths("/tmp/codex-discord-path-test");
      const malformedPaths = { ...paths, [field]: 42 } as unknown as StatePaths;

      const error = await expectBridgeError(
        ensureStateDirectories(malformedPaths),
        "INVALID_ARGUMENT",
      );

      expect(error.cause).toBeInstanceOf(ZodError);
    },
  );

  it.each([
    ["empty stateRoot", { stateRoot: "" }],
    ["non-string stateRoot", { stateRoot: 42 }],
    ["null stateRoot", { stateRoot: null }],
    ["NUL stateRoot", { stateRoot: "invalid\0root" }],
    ["empty registryPath", { registryPath: "" }],
    ["non-string registryPath", { registryPath: 42 }],
    ["null registryPath", { registryPath: null }],
    ["NUL registryPath", { registryPath: "invalid\0registry.json" }],
    ["non-object options", 42],
    ["null options", null],
  ] as const)("rejects malformed RegistryStore construction: %s", (_label, options) => {
    const error = expectSynchronousBridgeError(
      () => new RegistryStore(options as unknown as ConstructorParameters<typeof RegistryStore>[0]),
      "INVALID_ARGUMENT",
    );

    expect(error.cause).toBeInstanceOf(ZodError);
  });

  it("preserves deterministic default and overridden paths", () => {
    const expectedDefaultRoot = resolve(join(homedir(), ".codex-discord-bridge"));
    const override = join(tmpdir(), "codex-discord-path-test");
    const first = resolveStatePaths(override);
    const second = resolveStatePaths(override);

    expect(resolveStatePaths().root).toBe(expectedDefaultRoot);
    expect(first.root).toBe(resolve(override));
    expect(first.registryPath).toBe(join(resolve(override), "registry.json"));
    expect(second.registryPath).toBe(first.registryPath);
    expect(first.instanceDirectory(BINDING_ONE_ID)).toBe(
      join(resolve(override), "instances", BINDING_ONE_ID),
    );
    expect(first.instanceInboxDirectory(BINDING_ONE_ID)).toBe(
      join(resolve(override), "inbox", BINDING_ONE_ID),
    );
    expect(first.instanceLogPath(BINDING_ONE_ID)).toBe(
      join(resolve(override), "logs", `${BINDING_ONE_ID}.log`),
    );
    expect(first.progressJournalPath(BINDING_ONE_ID)).toBe(
      join(resolve(override), "instances", BINDING_ONE_ID, "progress-observations.json"),
    );
  });

  it("does not relabel operational filesystem errors as invalid input", async () => {
    const { directory } = await makeStatePath();
    const filePath = join(directory, "ordinary-file");
    await writeFile(filePath, "not a directory", "utf8");

    try {
      await ensureStateDirectories(resolveStatePaths(filePath));
    } catch (error) {
      expect(error).not.toBeInstanceOf(BridgeError);
      expect(error).toMatchObject({ code: "EEXIST" });
      return;
    }

    throw new Error("Expected filesystem error");
  });
});

describe("RegistryStore binding reservations", () => {
  it("rejects a bot already reserved by a stopped binding", async () => {
    const { registry } = await createRegistry();
    await seedBindableRegistry(registry);
    await registry.createBinding(bindingInput());

    await expectBridgeError(
      registry.createBinding(
        bindingInput({
          id: BINDING_TWO_ID,
          name: "agent-two",
          threadId: THREAD_TWO_ID,
          tmuxSession: "codex-discord-agent-two",
        }),
      ),
      "CONFLICT",
    );
  });

  it("rejects a thread already reserved by another binding", async () => {
    const { registry } = await createRegistry();
    await seedBindableRegistry(registry);
    await registry.registerBot(
      bot({
        name: "bot-two",
        applicationId: BOT_TWO_APPLICATION_ID,
        botUserId: BOT_TWO_USER_ID,
        keychainAccount: "codex-discord-bot-two",
      }),
    );
    await registry.createBinding(bindingInput());

    await expectBridgeError(
      registry.createBinding(
        bindingInput({
          id: BINDING_TWO_ID,
          name: "agent-two",
          botName: "bot-two",
          tmuxSession: "codex-discord-agent-two",
        }),
      ),
      "CONFLICT",
    );
  });

  it("persists a valid bot-thread-tmux 1:1 binding", async () => {
    const { registry } = await createRegistry();
    await seedBindableRegistry(registry);

    const binding = await registry.createBinding(bindingInput());
    const persisted = await registry.read();

    expect(binding).toMatchObject({
      desiredState: "stopped",
      observedState: "stopped",
      previousThreadIds: [],
    });
    expect(persisted.bindings[BINDING_ONE_ID]).toEqual(binding);
    expect(persisted.bots["bot-one"]?.state).toBe("bound");
  });

  it("releases bot and thread only after unlink", async () => {
    const { registry } = await createRegistry();
    await seedBindableRegistry(registry);
    await registry.createBinding(bindingInput());

    await expectBridgeError(
      registry.createBinding(
        bindingInput({
          id: BINDING_TWO_ID,
          name: "agent-two",
        }),
      ),
      "CONFLICT",
    );

    const unlinked = await registry.unlink(BINDING_ONE_ID);
    const replacement = await registry.createBinding(
      bindingInput({
        id: BINDING_TWO_ID,
        name: "agent-two",
      }),
    );

    expect(unlinked.id).toBe(BINDING_ONE_ID);
    expect(replacement.id).toBe(BINDING_TWO_ID);
    expect((await registry.read()).bots["bot-one"]?.state).toBe("bound");
  });

  it("keeps stopped bindings reserved until they are unlinked", async () => {
    const { registry } = await createRegistry();
    await seedBindableRegistry(registry);
    await registry.createBinding(bindingInput());

    await expectBridgeError(
      registry.registerBot(
        bot({
          name: "bot-two",
          applicationId: BOT_ONE_APPLICATION_ID,
          botUserId: BOT_TWO_USER_ID,
          keychainAccount: "codex-discord-bot-two",
        }),
      ),
      "CONFLICT",
    );
  });

  it("rejects duplicate Keychain accounts", async () => {
    const { registry } = await createRegistry();
    await registry.registerBot(bot());

    await expectBridgeError(
      registry.registerBot(
        bot({
          name: "bot-two",
          applicationId: BOT_TWO_APPLICATION_ID,
          botUserId: BOT_TWO_USER_ID,
        }),
      ),
      "CONFLICT",
    );
  });
});

describe("RegistryStore ownership", () => {
  it("confirms only the configured owner and keeps confirmation idempotent", async () => {
    const { registry } = await createRegistry();
    await registry.registerBot(bot());

    await expectBridgeError(registry.confirmOwner("bot-one", OWNER_TWO_ID), "UNAUTHORIZED");
    const confirmed = await registry.confirmOwner("bot-one", OWNER_ONE_ID);
    const confirmedAgain = await registry.confirmOwner("bot-one", OWNER_ONE_ID);

    expect(confirmed.ownerConfirmedAt).toBe(NOW);
    expect(confirmedAgain).toEqual(confirmed);
    expect((await registry.read()).bots["bot-one"]).toEqual(confirmed);
  });

  it("rejects owner transfer without explicit confirmation", async () => {
    const { registry } = await createRegistry();
    await registry.registerBot(bot());

    await expectBridgeError(
      registry.setOwner("bot-one", {
        ownerUserId: OWNER_TWO_ID,
        confirmed: false,
      }),
      "CONFLICT",
    );
  });

  it("rejects owner transfer while any binding for the bot is not stopped", async () => {
    const { registry } = await createRegistry();
    await seedBindableRegistry(registry);
    await registry.createBinding(bindingInput());
    await registry.markObservedState(BINDING_ONE_ID, "running");

    await expectBridgeError(
      registry.setOwner("bot-one", {
        ownerUserId: OWNER_TWO_ID,
        confirmed: true,
      }),
      "CONFLICT",
    );
  });

  it("transfers the automatic allowlist entry and preserves explicit users", async () => {
    const { registry } = await createRegistry();
    await registry.registerBot(bot({ ownerConfirmedAt: NOW }));
    const current = await registry.read();
    const access = current.access["bot-one"];
    if (access === undefined) {
      throw new Error("Expected bot access policy");
    }
    await updateCurrentAccess(registry, "bot-one", (currentAccess) => ({
      ...currentAccess,
      allowFrom: [OWNER_ONE_ID, EXPLICIT_USER_ID],
    }));

    const updatedBot = await registry.setOwner("bot-one", {
      ownerUserId: OWNER_TWO_ID,
      confirmed: true,
    });
    const updated = await registry.read();

    expect(updatedBot.ownerUserId).toBe(OWNER_TWO_ID);
    expect(updatedBot.ownerConfirmedAt).toBeUndefined();
    expect(updated.access["bot-one"]?.allowFrom).toEqual([EXPLICIT_USER_ID, OWNER_TWO_ID]);
  });

  it("canonicalizes an already-allowed new owner and preserves every other user", async () => {
    const { registry } = await createRegistry();
    await registry.registerBot(bot());
    await updateCurrentAccess(registry, "bot-one", (currentAccess) => ({
      ...currentAccess,
      allowFrom: [OWNER_ONE_ID, OWNER_TWO_ID, EXPLICIT_USER_ID, SECOND_EXPLICIT_USER_ID],
    }));

    await registry.setOwner("bot-one", {
      ownerUserId: OWNER_TWO_ID,
      confirmed: true,
    });

    expect((await registry.read()).access["bot-one"]?.allowFrom).toEqual([
      OWNER_TWO_ID,
      EXPLICIT_USER_ID,
      SECOND_EXPLICIT_USER_ID,
    ]);
  });

  it("keeps the owner in the allowlist when access is updated", async () => {
    const { registry } = await createRegistry();
    await registry.registerBot(bot());
    const current = await registry.read();
    const access = current.access["bot-one"];
    if (access === undefined) {
      throw new Error("Expected bot access policy");
    }

    const updated = await updateCurrentAccess(registry, "bot-one", (currentAccess) => ({
      ...currentAccess,
      allowFrom: [EXPLICIT_USER_ID],
    }));

    expect(updated.allowFrom).toEqual([EXPLICIT_USER_ID, OWNER_ONE_ID]);
  });

  it("rejects owner transfer while startup is desired but not yet observed", async () => {
    const { registry } = await createRegistry();
    await seedBindableRegistry(registry);
    await registry.createBinding(bindingInput());
    await registry.setDesiredState(BINDING_ONE_ID, "running");

    await expectBridgeError(
      registry.setOwner("bot-one", {
        ownerUserId: OWNER_TWO_ID,
        confirmed: true,
      }),
      "CONFLICT",
    );
  });
});

describe("RegistryStore atomic persistence", () => {
  it("orders temp sync, close, rename, directory sync, and lock release", async () => {
    const { registryPath } = await makeStatePath();
    const events: AtomicJsonEvent[] = [];
    const registry = new RegistryStore({
      registryPath,
      eventObserver: (event) => events.push(event),
    });

    await registry.read();

    expect(events).toEqual([
      "temp-file-synced",
      "temp-file-closed",
      "file-renamed",
      "directory-synced",
      "lock-released",
    ]);
  });

  it("serializes transactions across independent processes", async () => {
    const { registryPath } = await makeStatePath();
    const registryModuleUrl = pathToFileURL(join(process.cwd(), "src/storage/registry.ts")).href;
    const childScript = `
      const [registryPath, name, applicationId, botUserId] = process.argv.slice(1);
      const { RegistryStore } = await import(${JSON.stringify(registryModuleUrl)});
      const registry = new RegistryStore({ registryPath });
      await registry.registerBot({
        name,
        applicationId,
        botUserId,
        keychainAccount: "codex-discord-" + name,
        ownerUserId: ${JSON.stringify(OWNER_ONE_ID)},
        state: "registered"
      });
    `;
    const childArguments = ["--import", "tsx", "--input-type=module", "--eval", childScript];

    await Promise.all([
      execFileAsync(process.execPath, [
        ...childArguments,
        registryPath,
        "bot-one",
        BOT_ONE_APPLICATION_ID,
        BOT_ONE_USER_ID,
      ]),
      execFileAsync(process.execPath, [
        ...childArguments,
        registryPath,
        "bot-two",
        BOT_TWO_APPLICATION_ID,
        BOT_TWO_USER_ID,
      ]),
    ]);

    const persisted = await new RegistryStore({ registryPath }).read();
    expect(Object.keys(persisted.bots).sort()).toEqual(["bot-one", "bot-two"]);
  });

  it("recovers the previous valid file when a write is interrupted", async () => {
    const { registryPath, registry } = await createRegistry();
    await seedBindableRegistry(registry);
    const before = await readFile(registryPath, "utf8");
    let injected = false;
    const interruptedRegistry = new RegistryStore({
      registryPath,
      now: () => new Date(NOW),
      faultInjector: (point) => {
        if (point === "after-temp-file-fsync") {
          injected = true;
          throw new Error("simulated interruption");
        }
      },
    });

    await expect(
      interruptedRegistry.registerBot(
        bot({
          name: "bot-two",
          applicationId: BOT_TWO_APPLICATION_ID,
          botUserId: BOT_TWO_USER_ID,
          keychainAccount: "codex-discord-bot-two",
        }),
      ),
    ).rejects.toThrow("simulated interruption");

    expect(injected).toBe(true);
    expect(await readFile(registryPath, "utf8")).toBe(before);
    expect((await new RegistryStore({ registryPath }).read()).bots).toHaveProperty("bot-one");
    expect((await new RegistryStore({ registryPath }).read()).bots).not.toHaveProperty("bot-two");
    expect((await readdir(join(registryPath, ".."))).some((entry) => entry.includes(".tmp-"))).toBe(
      false,
    );
  });

  it("retains primary and temp-cleanup failures", async () => {
    const { registryPath, registry } = await createRegistry();
    await registry.registerBot(bot());
    const before = await readFile(registryPath, "utf8");
    const failedRegistry = new RegistryStore({
      registryPath,
      faultInjector: (point: AtomicWriteFaultPoint) => {
        if (point === "after-temp-file-fsync") {
          throw new Error("primary write failure");
        }
        if (point === "before-temp-file-cleanup") {
          throw new Error("secondary cleanup failure");
        }
      },
    });

    const error = await captureError(failedRegistry.addWorkspace(workspace()));

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "primary write failure" }),
      expect.objectContaining({ message: "secondary cleanup failure" }),
    ]);
    expect(await readFile(registryPath, "utf8")).toBe(before);
    expect((await readdir(dirname(registryPath))).some((entry) => entry.includes(".tmp-"))).toBe(
      false,
    );
  });

  it("retains a post-release adapter failure alongside a precommit primary failure", async () => {
    const { registryPath, registry } = await createRegistry();
    await registry.registerBot(bot());
    const failedRegistry = new RegistryStore({
      registryPath,
      faultInjector: (point: AtomicWriteFaultPoint) => {
        if (point === "after-temp-file-fsync") {
          throw new Error("primary write failure");
        }
      },
      lockAdapter: failAfterSuccessfulUnlock(new Error("secondary release failure")),
    });

    const error = await captureError(failedRegistry.addWorkspace(workspace()));

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "primary write failure" }),
      expect.objectContaining({
        code: "RUNTIME",
        cause: expect.objectContaining({ message: "secondary release failure" }),
      }),
    ]);
  });

  it("reports a committed post-release adapter failure without retaining the lock", async () => {
    const { registryPath, registry } = await createRegistry();
    await registry.registerBot(bot());
    let actualReleaseCalled = false;
    const lockAdapter: TestLockAdapter = async (_targetPath, acquire) => {
      const release = await acquire();
      return async () => {
        actualReleaseCalled = true;
        await release();
        throw new Error("simulated actual release failure");
      };
    };
    const failedRegistry = new RegistryStore({
      registryPath,
      lockAdapter,
    });

    const error = await captureError(failedRegistry.addWorkspace(workspace()));

    expect(error).toBeInstanceOf(BridgeError);
    expect(error).toMatchObject({
      code: "RUNTIME",
      cause: expect.objectContaining({ message: "simulated actual release failure" }),
    });
    expect(actualReleaseCalled).toBe(true);
    expect((error as BridgeError).message).toContain("commit succeeded");
    expect((error as BridgeError).remediation).toContain("Do not retry automatically");
    // The adapter rejected after proper-lockfile removed its lock, so immediate recovery is safe.
    expect((await new RegistryStore({ registryPath }).read()).workspaces).toHaveProperty(
      "main-workspace",
    );
  });

  it("reports an actual release failure while the proper lock remains retained", async () => {
    const { registryPath, registry } = await createRegistry();
    await registry.registerBot(bot());
    const lockDirectory = `${registryPath}.lock-target.lock`;
    const sentinelPath = join(lockDirectory, "release-blocker");
    const failedRegistry = new RegistryStore({
      registryPath,
      lockAdapter: retainProperLockOnRelease(),
    });

    try {
      const error = await captureError(failedRegistry.addWorkspace(workspace()));

      expect(error).toBeInstanceOf(BridgeError);
      expect(error).toMatchObject({
        code: "RUNTIME",
        cause: expect.objectContaining({ code: "ENOTEMPTY" }),
      });
      expect((error as BridgeError).message).toContain("commit succeeded");
      expect((error as BridgeError).message).toContain("lock release failed");
      expect((await stat(lockDirectory)).isDirectory()).toBe(true);
      expect(await readFile(sentinelPath, "utf8")).toBe("retain lock\n");
      const committed = JSON.parse(await readFile(registryPath, "utf8")) as {
        workspaces: Record<string, unknown>;
      };
      expect(committed.workspaces).toHaveProperty("main-workspace");

      const blocked = await captureError(
        withTimeout(
          new RegistryStore({ registryPath }).read(),
          3_000,
          "Immediate registry acquisition did not settle while the lock was retained",
        ),
      );
      expect(blocked).toMatchObject({ code: "ELOCKED" });
    } finally {
      await withTimeout(
        (async () => {
          await rm(sentinelPath, { force: true });
          await rm(lockDirectory, { force: true, recursive: true });
        })(),
        2_000,
        "Retained proper-lockfile directory cleanup timed out",
      );
    }

    expect((await new RegistryStore({ registryPath }).read()).workspaces).toHaveProperty(
      "main-workspace",
    );
  });

  it("does not mislabel a pre-release hook failure as an actual release failure", async () => {
    const { registryPath, registry } = await createRegistry();
    await registry.registerBot(bot());
    const failedRegistry = new RegistryStore({
      registryPath,
      faultInjector: (point: AtomicWriteFaultPoint) => {
        if (point === "before-lock-release") {
          throw new Error("pre-release hook failure");
        }
      },
    });

    const error = await captureError(failedRegistry.addWorkspace(workspace()));

    expect(error).toBeInstanceOf(BridgeError);
    expect(error).toMatchObject({
      code: "RUNTIME",
      cause: expect.objectContaining({ message: "pre-release hook failure" }),
    });
    expect((error as BridgeError).message).toContain("fault hook");
    expect((error as BridgeError).message).not.toContain("lock release failed");
    expect((await new RegistryStore({ registryPath }).read()).workspaces).toHaveProperty(
      "main-workspace",
    );
  });

  it("does not swallow an undefined post-release adapter rejection", async () => {
    const { registryPath, registry } = await createRegistry();
    await registry.registerBot(bot());
    const failedRegistry = new RegistryStore({
      registryPath,
      lockAdapter: failAfterSuccessfulUnlock(undefined),
    });

    const error = await captureError(failedRegistry.addWorkspace(workspace()));

    expect(error).toBeInstanceOf(BridgeError);
    expect(error).toMatchObject({ code: "RUNTIME" });
    expect((error as BridgeError).message).toContain("commit succeeded");
    expect((error as Error).cause).toBeUndefined();
    expect((await new RegistryStore({ registryPath }).read()).workspaces).toHaveProperty(
      "main-workspace",
    );
  });

  it.each(["after-rename", "after-directory-fsync"] as const)(
    "reports postcommit fault at %s without losing the committed document",
    async (faultPoint) => {
      const { registryPath, registry } = await createRegistry();
      await registry.registerBot(bot());
      const failedRegistry = new RegistryStore({
        registryPath,
        faultInjector: (point: AtomicWriteFaultPoint) => {
          if (point === faultPoint) {
            throw new Error(`simulated ${faultPoint}`);
          }
        },
      });

      const error = await captureError(failedRegistry.addWorkspace(workspace()));

      expect(error).toBeInstanceOf(BridgeError);
      expect(error).toMatchObject({ code: "RUNTIME" });
      expect((error as BridgeError).message).toContain("rename committed");
      expect((await new RegistryStore({ registryPath }).read()).workspaces).toHaveProperty(
        "main-workspace",
      );
    },
  );

  it("retains committed status when durability and post-release adapter finalization both fail", async () => {
    const { registryPath, registry } = await createRegistry();
    await registry.registerBot(bot());
    const failedRegistry = new RegistryStore({
      registryPath,
      faultInjector: (point: AtomicWriteFaultPoint) => {
        if (point === "after-rename") {
          throw new Error("postcommit durability failure");
        }
      },
      lockAdapter: failAfterSuccessfulUnlock(new Error("postcommit release failure")),
    });

    const error = await captureError(failedRegistry.addWorkspace(workspace()));

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({
        code: "RUNTIME",
        message: expect.stringContaining("rename committed"),
      }),
      expect.objectContaining({
        code: "RUNTIME",
        message: expect.stringContaining("commit succeeded"),
      }),
    ]);
    expect((await new RegistryStore({ registryPath }).read()).workspaces).toHaveProperty(
      "main-workspace",
    );
  });

  it("recovers from a killed writer with stale lock and temp artifacts", async () => {
    const { registryPath, registry } = await createRegistry();
    await registry.registerBot(bot());
    const registryModuleUrl = pathToFileURL(join(process.cwd(), "src/storage/registry.ts")).href;
    const childScript = `
      const [registryPath] = process.argv.slice(1);
      const { RegistryStore } = await import(${JSON.stringify(registryModuleUrl)});
      const registry = new RegistryStore({
        registryPath,
        faultInjector: async (point) => {
          if (point === "after-temp-file-fsync") {
            process.stdout.write("READY\\n");
            await new Promise(() => {
              setInterval(() => {}, 1_000);
            });
          }
        }
      });
      await registry.registerBot({
        name: "bot-two",
        applicationId: ${JSON.stringify(BOT_TWO_APPLICATION_ID)},
        botUserId: ${JSON.stringify(BOT_TWO_USER_ID)},
        keychainAccount: "codex-discord-bot-two",
        ownerUserId: ${JSON.stringify(OWNER_ONE_ID)},
        state: "registered"
      });
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", childScript, registryPath],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const exitPromise = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        const cleanup = () => {
          clearTimeout(timeout);
          child.stdout.off("data", onData);
          child.off("exit", onEarlyExit);
        };
        const settleReady = () => {
          cleanup();
          resolveReady();
        };
        const onData = (chunk: string) => {
          if (chunk.includes("READY")) {
            settleReady();
          }
        };
        const onEarlyExit = (code: number | null, signal: NodeJS.Signals | null) => {
          cleanup();
          rejectReady(new Error(`Child exited before checkpoint (${code ?? signal}): ${stderr}`));
        };
        const timeout = setTimeout(() => {
          cleanup();
          rejectReady(new Error(`Child did not reach fsync checkpoint: ${stderr}`));
        }, 3_000);
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", onData);
        child.once("exit", onEarlyExit);
      });

      child.kill("SIGKILL");
      const [, signal] = await withTimeout(
        exitPromise,
        2_000,
        `Child did not exit after SIGKILL: ${stderr}`,
      );
      expect(signal).toBe("SIGKILL");

      const parent = dirname(registryPath);
      const lockDirectory = `${registryPath}.lock-target.lock`;
      const beforeRecovery = await readdir(parent);
      expect(beforeRecovery.some((entry) => entry.includes(".tmp-"))).toBe(true);
      await utimes(lockDirectory, new Date(0), new Date(0));

      await registry.registerBot(
        bot({
          name: "bot-two",
          applicationId: BOT_TWO_APPLICATION_ID,
          botUserId: BOT_TWO_USER_ID,
          keychainAccount: "codex-discord-bot-two",
        }),
      );

      const recovered = await registry.read();
      expect(Object.keys(recovered.bots).sort()).toEqual(["bot-one", "bot-two"]);
      expect((await readdir(parent)).some((entry) => entry.includes(".tmp-"))).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await withTimeout(exitPromise, 2_000, `Crash-test child could not be terminated: ${stderr}`);
    }
  });

  it("never overwrites malformed existing state and repairs its mode first", async () => {
    const { registryPath, registry } = await createRegistry();
    await registry.read();
    const malformed = '{"version":1,"bots":';
    await writeFile(registryPath, malformed, "utf8");
    await chmod(registryPath, 0o644);

    await expectBridgeError(registry.registerBot(bot()), "CONFIGURATION");

    expect(await readFile(registryPath, "utf8")).toBe(malformed);
    expect((await stat(registryPath)).mode & 0o777).toBe(0o600);
  });

  it("rejects a directory registry target without changing its mode", async () => {
    const { registryPath } = await makeStatePath();
    await mkdir(registryPath, { mode: 0o755, recursive: true });
    await chmod(registryPath, 0o755);
    const beforeMode = (await stat(registryPath)).mode & 0o777;

    const error = await expectBridgeError(
      new RegistryStore({ registryPath }).read(),
      "CONFIGURATION",
    );

    expect(error.message).toContain("regular file");
    expect(error.message).not.toContain("malformed JSON");
    expect((await stat(registryPath)).mode & 0o777).toBe(beforeMode);
  });

  it("rejects a symlink registry target without reading or chmodding its target", async () => {
    const { directory, registryPath } = await makeStatePath();
    const targetPath = join(directory, "target-registry.json");
    await new RegistryStore({ registryPath: targetPath }).read();
    await chmod(targetPath, 0o644);
    const beforeContents = await readFile(targetPath, "utf8");
    const beforeMode = (await stat(targetPath)).mode & 0o777;
    await mkdir(dirname(registryPath), { recursive: true });
    await symlink(targetPath, registryPath);

    const error = await expectBridgeError(
      new RegistryStore({ registryPath }).read(),
      "CONFIGURATION",
    );

    expect(error.message).toContain("symbolic link");
    expect(error.message).not.toContain("malformed JSON");
    expect(await readFile(targetPath, "utf8")).toBe(beforeContents);
    expect((await stat(targetPath)).mode & 0o777).toBe(beforeMode);
  });

  it("rejects a FIFO registry target without blocking or changing its mode", async () => {
    if (process.platform === "win32") {
      return;
    }
    const { registryPath } = await makeStatePath();
    await mkdir(dirname(registryPath), { recursive: true });
    await execFileAsync("mkfifo", [registryPath], { timeout: 1_000 });
    await chmod(registryPath, 0o644);
    const beforeMode = (await stat(registryPath)).mode & 0o777;
    const registryModuleUrl = pathToFileURL(join(process.cwd(), "src/storage/registry.ts")).href;
    const childScript = `
      const { RegistryStore } = await import(${JSON.stringify(registryModuleUrl)});
      try {
        await new RegistryStore({ registryPath: process.argv[1] }).read();
        process.stdout.write(JSON.stringify({ outcome: "resolved" }));
      } catch (error) {
        process.stdout.write(JSON.stringify({
          outcome: "rejected",
          code: error?.code,
          message: error?.message
        }));
      }
    `;

    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", childScript, registryPath],
      { timeout: 1_000, killSignal: "SIGKILL" },
    );
    const outcome = JSON.parse(stdout) as {
      outcome: string;
      code?: string;
      message?: string;
    };

    expect(outcome).toMatchObject({
      outcome: "rejected",
      code: "CONFIGURATION",
      message: expect.stringContaining("regular file"),
    });
    expect((await stat(registryPath)).mode & 0o777).toBe(beforeMode);
  });

  it("rejects a directory lock target without changing its mode", async () => {
    const { registryPath } = await makeStatePath();
    const lockTargetPath = `${registryPath}.lock-target`;
    await mkdir(lockTargetPath, { mode: 0o755, recursive: true });
    await chmod(lockTargetPath, 0o755);
    const beforeMode = (await stat(lockTargetPath)).mode & 0o777;

    const error = await expectBridgeError(
      new RegistryStore({ registryPath }).read(),
      "CONFIGURATION",
    );

    expect(error.message).toContain("Lock target");
    expect(error.message).toContain("regular file");
    expect((await stat(lockTargetPath)).mode & 0o777).toBe(beforeMode);
  });

  it("rejects a symlink lock target without reading or chmodding its target", async () => {
    const { directory, registryPath } = await makeStatePath();
    const lockTargetPath = `${registryPath}.lock-target`;
    const symlinkTargetPath = join(directory, "lock-target-sentinel");
    await mkdir(dirname(lockTargetPath), { recursive: true });
    await writeFile(symlinkTargetPath, "unchanged\n", { encoding: "utf8", mode: 0o644 });
    await chmod(symlinkTargetPath, 0o644);
    const beforeContents = await readFile(symlinkTargetPath, "utf8");
    const beforeMode = (await stat(symlinkTargetPath)).mode & 0o777;
    await symlink(symlinkTargetPath, lockTargetPath);

    const error = await expectBridgeError(
      new RegistryStore({ registryPath }).read(),
      "CONFIGURATION",
    );

    expect(error.message).toContain("Lock target");
    expect(error.message).toContain("symbolic link");
    expect(await readFile(symlinkTargetPath, "utf8")).toBe(beforeContents);
    expect((await stat(symlinkTargetPath)).mode & 0o777).toBe(beforeMode);
  });

  it("rejects a FIFO lock target without blocking or changing its mode", async () => {
    if (process.platform === "win32") {
      return;
    }
    const { registryPath } = await makeStatePath();
    const lockTargetPath = `${registryPath}.lock-target`;
    await mkdir(dirname(lockTargetPath), { recursive: true });
    await execFileAsync("mkfifo", [lockTargetPath], { timeout: 1_000 });
    await chmod(lockTargetPath, 0o644);
    const beforeMode = (await stat(lockTargetPath)).mode & 0o777;
    const registryModuleUrl = pathToFileURL(join(process.cwd(), "src/storage/registry.ts")).href;
    const childScript = `
      const { RegistryStore } = await import(${JSON.stringify(registryModuleUrl)});
      try {
        await new RegistryStore({ registryPath: process.argv[1] }).read();
        process.stdout.write(JSON.stringify({ outcome: "resolved" }));
      } catch (error) {
        process.stdout.write(JSON.stringify({
          outcome: "rejected",
          code: error?.code,
          message: error?.message
        }));
      }
    `;

    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", childScript, registryPath],
      { timeout: 1_000, killSignal: "SIGKILL" },
    );
    const outcome = JSON.parse(stdout) as {
      outcome: string;
      code?: string;
      message?: string;
    };

    expect(outcome).toMatchObject({
      outcome: "rejected",
      code: "CONFIGURATION",
      message: expect.stringContaining("Lock target"),
    });
    expect(outcome.message).toContain("regular file");
    expect((await stat(lockTargetPath)).mode & 0o777).toBe(beforeMode);
  });

  it("does not swallow undefined thrown by a transaction callback", async () => {
    const { registryPath } = await makeStatePath();
    const store = new AtomicJsonStore({
      filePath: registryPath,
      schema: z.object({ value: z.number() }).strict(),
      initialDocument: () => ({ value: 1 }),
    });
    await store.read();
    const before = await readFile(registryPath, "utf8");

    await expect(
      store.transact(() => {
        throw undefined;
      }),
    ).rejects.toBeUndefined();

    expect(await readFile(registryPath, "utf8")).toBe(before);
    expect(await store.read()).toEqual({ value: 1 });
  });

  it("does not swallow an undefined precommit fault rejection", async () => {
    const { registryPath, registry } = await createRegistry();
    await registry.registerBot(bot());
    const before = await readFile(registryPath, "utf8");
    const failedRegistry = new RegistryStore({
      registryPath,
      faultInjector: (point) =>
        point === "after-temp-file-fsync" ? Promise.reject(undefined) : undefined,
    });

    await expect(failedRegistry.addWorkspace(workspace())).rejects.toBeUndefined();

    expect(await readFile(registryPath, "utf8")).toBe(before);
    expect((await new RegistryStore({ registryPath }).read()).workspaces).not.toHaveProperty(
      "main-workspace",
    );
  });

  it.each(["after-rename", "after-directory-fsync"] as const)(
    "does not swallow an undefined postcommit fault at %s",
    async (faultPoint) => {
      const { registryPath, registry } = await createRegistry();
      await registry.registerBot(bot());
      const failedRegistry = new RegistryStore({
        registryPath,
        faultInjector: (point) => (point === faultPoint ? Promise.reject(undefined) : undefined),
      });

      await expect(failedRegistry.addWorkspace(workspace())).rejects.toMatchObject({
        code: "RUNTIME",
      });

      expect((await new RegistryStore({ registryPath }).read()).workspaces).toHaveProperty(
        "main-workspace",
      );
    },
  );

  it("creates registry state with owner-only directory and file modes", async () => {
    const { registryPath, registry } = await createRegistry();

    await registry.read();

    expect((await stat(join(registryPath, ".."))).mode & 0o777).toBe(0o700);
    expect((await stat(registryPath)).mode & 0o777).toBe(0o600);
    expect((await stat(`${registryPath}.lock-target`)).mode & 0o777).toBe(0o600);
  });

  it("repairs permissive modes without changing valid state", async () => {
    const { registryPath, registry } = await createRegistry();
    await registry.read();
    await chmod(join(registryPath, ".."), 0o755);
    await chmod(registryPath, 0o644);

    await registry.read();

    expect((await stat(join(registryPath, ".."))).mode & 0o777).toBe(0o700);
    expect((await stat(registryPath)).mode & 0o777).toBe(0o600);
  });
});

describe("RegistryStore lifecycle operations", () => {
  it("persists an unbound bot in the repairable registering state", async () => {
    const { registry } = await createRegistry();

    const registering = await registry.registerBot(bot({ state: "registering" }));

    expect(registering.state).toBe("registering");
    expect((await registry.read()).bots["bot-one"]?.state).toBe("registering");
  });

  it("replaces the current thread without reserving historical threads", async () => {
    const { registry } = await createRegistry();
    await seedBindableRegistry(registry);
    await registry.registerBot(
      bot({
        name: "bot-two",
        applicationId: BOT_TWO_APPLICATION_ID,
        botUserId: BOT_TWO_USER_ID,
        keychainAccount: "codex-discord-bot-two",
      }),
    );
    await registry.createBinding(bindingInput());

    const replaced = await registry.replaceThread(BINDING_ONE_ID, THREAD_TWO_ID);
    const second = await registry.createBinding(
      bindingInput({
        id: BINDING_TWO_ID,
        name: "agent-two",
        botName: "bot-two",
        threadId: THREAD_ONE_ID,
        tmuxSession: "codex-discord-agent-two",
      }),
    );

    expect(replaced.threadId).toBe(THREAD_TWO_ID);
    expect(replaced.previousThreadIds).toEqual([THREAD_ONE_ID]);
    expect(second.threadId).toBe(THREAD_ONE_ID);
  });

  it("sets and clears bounded model settings without changing binding identity", async () => {
    let now = NOW;
    const { registry } = await createRegistry({ now: () => new Date(now) });
    await seedBindableRegistry(registry);
    const created = await registry.createBinding(bindingInput());

    now = LATER;
    const configured = await registry.updateModelSettings(BINDING_ONE_ID, {
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
    });

    expect(configured).toEqual({
      ...created,
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      updatedAt: LATER,
    });
    expect((await registry.read()).bindings[BINDING_ONE_ID]).toEqual(configured);

    const cleared = await registry.updateModelSettings(BINDING_ONE_ID, {});
    expect(cleared).toEqual({ ...created, updatedAt: LATER });
    expect(cleared).not.toHaveProperty("modelId");
    expect(cleared).not.toHaveProperty("reasoningEffort");
  });

  it("rejects missing bindings and invalid model setting updates", async () => {
    const { registry } = await createRegistry();
    await seedBindableRegistry(registry);
    await registry.createBinding(bindingInput());

    await expectBridgeError(
      registry.updateModelSettings(BINDING_TWO_ID, { modelId: "gpt-5.6-sol" }),
      "NOT_FOUND",
    );
    await expectBridgeError(
      registry.updateModelSettings(BINDING_ONE_ID, { modelId: "bad\nmodel" }),
      "INVALID_ARGUMENT",
    );
    await expectBridgeError(
      registry.updateModelSettings(BINDING_ONE_ID, {
        reasoningEffort: "x".repeat(65),
      }),
      "INVALID_ARGUMENT",
    );
    expect((await registry.read()).bindings[BINDING_ONE_ID]).not.toHaveProperty("modelId");
  });

  it("rejects replacing a thread with another current reservation", async () => {
    const { registry } = await createRegistry();
    await seedBindableRegistry(registry);
    await registry.registerBot(
      bot({
        name: "bot-two",
        applicationId: BOT_TWO_APPLICATION_ID,
        botUserId: BOT_TWO_USER_ID,
        keychainAccount: "codex-discord-bot-two",
      }),
    );
    await registry.createBinding(bindingInput());
    await registry.createBinding(
      bindingInput({
        id: BINDING_TWO_ID,
        name: "agent-two",
        botName: "bot-two",
        threadId: THREAD_TWO_ID,
        tmuxSession: "codex-discord-agent-two",
      }),
    );

    await expectBridgeError(registry.replaceThread(BINDING_ONE_ID, THREAD_TWO_ID), "CONFLICT");
  });

  it("keeps bot lifecycle state coherent with observed binding state", async () => {
    const { registry } = await createRegistry();
    await seedBindableRegistry(registry);
    await registry.createBinding(bindingInput());

    for (const [observedState, botState] of [
      ["starting", "bound"],
      ["running", "running"],
      ["stopping", "running"],
      ["failed", "failed"],
      ["stopped", "bound"],
    ] as const) {
      await registry.markObservedState(BINDING_ONE_ID, observedState);
      expect((await registry.read()).bots["bot-one"]?.state).toBe(botState);
    }
  });

  it("requires stopped observation before unlink", async () => {
    const { registry } = await createRegistry();
    await seedBindableRegistry(registry);
    await registry.createBinding(bindingInput());
    await registry.markObservedState(BINDING_ONE_ID, "stopping");

    await expectBridgeError(registry.unlink(BINDING_ONE_ID), "CONFLICT");
  });

  it("sets desired state atomically without breaking observed lifecycle coherence", async () => {
    const { registry } = await createRegistry();
    await seedBindableRegistry(registry);
    await registry.createBinding(bindingInput());

    const updated = await registry.setDesiredState(BINDING_ONE_ID, "running");
    const persisted = await registry.read();

    expect(updated.desiredState).toBe("running");
    expect(updated.observedState).toBe("stopped");
    expect(persisted.bindings[BINDING_ONE_ID]).toEqual(updated);
    expect(persisted.bots["bot-one"]?.state).toBe("bound");
  });

  it("rejects unlink while startup is desired but not yet observed", async () => {
    const { registry } = await createRegistry();
    await seedBindableRegistry(registry);
    await registry.createBinding(bindingInput());
    await registry.setDesiredState(BINDING_ONE_ID, "running");

    await expectBridgeError(registry.unlink(BINDING_ONE_ID), "CONFLICT");
  });

  it("removes bot access only after the deleting lifecycle completes", async () => {
    const { registry } = await createRegistry();
    await registry.registerBot(bot());

    await registry.beginBotRemoval("bot-one");
    expect((await registry.read()).access).toHaveProperty("bot-one");
    const removed = await registry.finishBotRemoval("bot-one");
    const persisted = await registry.read();

    expect(removed.state).toBe("deleting");
    expect(persisted.bots).not.toHaveProperty("bot-one");
    expect(persisted.access).not.toHaveProperty("bot-one");
  });

  it("rejects bot removal while a stopped binding still refers to it", async () => {
    const { registry } = await createRegistry();
    await seedBindableRegistry(registry);
    await registry.createBinding(bindingInput());

    await expectBridgeError(registry.beginBotRemoval("bot-one"), "CONFLICT");
  });
});

describe("RegistryStore workspace and access operations", () => {
  it("computes the same access revision regardless of record insertion order", () => {
    const pairingOne = {
      senderId: EXPLICIT_USER_ID,
      dmChannelId: DM_CHANNEL_ID,
      createdAt: NOW,
      expiresAt: LATER,
      replyCount: 0,
    };
    const pairingTwo = {
      senderId: SECOND_EXPLICIT_USER_ID,
      dmChannelId: SECOND_DM_CHANNEL_ID,
      createdAt: NOW,
      expiresAt: LATER,
      replyCount: 0,
    };
    const first = accessPolicy(OWNER_ONE_ID, {
      groups: {
        [DM_CHANNEL_ID]: { requireMention: true, allowFrom: [EXPLICIT_USER_ID] },
        [SECOND_DM_CHANNEL_ID]: {
          requireMention: false,
          allowFrom: [SECOND_EXPLICIT_USER_ID],
        },
      },
      pendingPairings: {
        first: pairingOne,
        second: pairingTwo,
      },
    });
    const second = accessPolicy(OWNER_ONE_ID, {
      groups: {
        [SECOND_DM_CHANNEL_ID]: {
          requireMention: false,
          allowFrom: [SECOND_EXPLICIT_USER_ID],
        },
        [DM_CHANNEL_ID]: { requireMention: true, allowFrom: [EXPLICIT_USER_ID] },
      },
      pendingPairings: {
        second: pairingTwo,
        first: pairingOne,
      },
    });

    expect(revisionFor(first)).toBe(revisionFor(second));
  });

  it("rejects a callback update because access changes require CAS", async () => {
    const { registry } = await createRegistry();
    await registry.registerBot(bot());

    await expectBridgeError(
      (
        registry.updateAccess as unknown as (
          name: string,
          callback: (current: AccessPolicy) => AccessPolicy,
        ) => Promise<AccessPolicy>
      )("bot-one", (current) => current),
      "INVALID_ARGUMENT",
    );
  });

  it("rejects a stale CAS without erasing a concurrent pairing", async () => {
    const { registry } = await createRegistry();
    await registry.registerBot(bot());
    await updateCurrentAccess(registry, "bot-one", (current) => ({
      ...current,
      pendingPairings: {
        concurrent: {
          senderId: EXPLICIT_USER_ID,
          dmChannelId: DM_CHANNEL_ID,
          createdAt: NOW,
          expiresAt: LATER,
          replyCount: 0,
        },
      },
    }));
    const firstRead = await registry.read();
    const secondRead = await registry.read();
    const firstPolicy = firstRead.access["bot-one"];
    const stalePolicy = secondRead.access["bot-one"];
    if (firstPolicy === undefined || stalePolicy === undefined) {
      throw new Error("Expected bot access policy");
    }
    const staleRevision = revisionFor(firstPolicy);
    await registry.approvePairing("bot-one", "concurrent");

    await expectBridgeError(
      casUpdateAccess(registry, "bot-one", staleRevision, {
        ...stalePolicy,
        ackReaction: "\u2611\uFE0F",
      }),
      "CONFLICT",
    );

    const current = (await registry.read()).access["bot-one"];
    expect(current?.pendingPairings).not.toHaveProperty("concurrent");
    expect(current?.allowFrom).toContain(EXPLICIT_USER_ID);
    expect(current?.ackReaction).toBe("\u2705");
  });

  it("rejects a stale CAS without resurrecting the old owner", async () => {
    const { registry } = await createRegistry();
    await registry.registerBot(bot());
    const firstRead = await registry.read();
    const secondRead = await registry.read();
    const firstPolicy = firstRead.access["bot-one"];
    const stalePolicy = secondRead.access["bot-one"];
    if (firstPolicy === undefined || stalePolicy === undefined) {
      throw new Error("Expected bot access policy");
    }
    const staleRevision = revisionFor(firstPolicy);
    await registry.setOwner("bot-one", {
      ownerUserId: OWNER_TWO_ID,
      confirmed: true,
    });

    await expectBridgeError(
      casUpdateAccess(registry, "bot-one", staleRevision, {
        ...stalePolicy,
        ackReaction: "\u2611\uFE0F",
      }),
      "CONFLICT",
    );

    const current = (await registry.read()).access["bot-one"];
    expect(current?.allowFrom).toContain(OWNER_TWO_ID);
    expect(current?.allowFrom).not.toContain(OWNER_ONE_ID);
    expect(current?.ackReaction).toBe("\u2705");
  });

  it("checks a stale revision before validating its replacement policy", async () => {
    const { registry } = await createRegistry();
    await registry.registerBot(bot());
    const stalePolicy = (await registry.read()).access["bot-one"];
    if (stalePolicy === undefined) {
      throw new Error("Expected bot access policy");
    }
    const staleRevision = revisionFor(stalePolicy);
    await registry.setOwner("bot-one", {
      ownerUserId: OWNER_TWO_ID,
      confirmed: true,
    });

    await expectBridgeError(
      registry.updateAccess("bot-one", staleRevision, {
        ...stalePolicy,
        allowFrom: [],
        unknown: true,
      } as never),
      "CONFLICT",
    );
  });

  it("rejects an additional explicit grant for the current owner", async () => {
    const { registry } = await createRegistry();
    await registry.registerBot(bot());
    const current = (await registry.read()).access["bot-one"];
    if (current === undefined) {
      throw new Error("Expected bot access policy");
    }

    await expectBridgeError(
      casUpdateAccess(registry, "bot-one", revisionFor(current), {
        ...current,
        allowFrom: [OWNER_ONE_ID, OWNER_ONE_ID],
      }),
      "INVALID_ARGUMENT",
    );

    expect((await registry.read()).access["bot-one"]?.allowFrom).toEqual([OWNER_ONE_ID]);
  });

  it("updates a referenced workspace only while all bindings are stopped", async () => {
    const { registry } = await createRegistry();
    await seedBindableRegistry(registry);
    await registry.createBinding(bindingInput());

    const updated = await registry.updateWorkspace(
      "main-workspace",
      workspace({ cwd: "/tmp/new-project" }),
    );

    expect(updated.cwd).toBe("/tmp/new-project");
  });

  it("rejects workspace updates while a referencing binding is active", async () => {
    const { registry } = await createRegistry();
    await seedBindableRegistry(registry);
    await registry.createBinding(bindingInput());
    await registry.markObservedState(BINDING_ONE_ID, "starting");

    await expectBridgeError(
      registry.updateWorkspace("main-workspace", workspace({ cwd: "/tmp/new-project" })),
      "CONFLICT",
    );
  });

  it("rejects workspace updates while startup is desired but not yet observed", async () => {
    const { registry } = await createRegistry();
    await seedBindableRegistry(registry);
    await registry.createBinding(bindingInput());
    await registry.setDesiredState(BINDING_ONE_ID, "running");

    await expectBridgeError(
      registry.updateWorkspace("main-workspace", workspace({ cwd: "/tmp/new-project" })),
      "CONFLICT",
    );
  });

  it("requires every binding to be unlinked before workspace removal", async () => {
    const { registry } = await createRegistry();
    await seedBindableRegistry(registry);
    await registry.createBinding(bindingInput());

    await expectBridgeError(registry.removeWorkspace("main-workspace"), "CONFLICT");
    await registry.unlink(BINDING_ONE_ID);
    const removed = await registry.removeWorkspace("main-workspace");

    expect(removed.name).toBe("main-workspace");
    expect((await registry.read()).workspaces).not.toHaveProperty("main-workspace");
  });

  it("approves an unexpired pairing atomically", async () => {
    const { registryPath, registry } = await createRegistry();
    await registry.registerBot(bot());
    const document = await registry.read();
    const access = document.access["bot-one"];
    if (access === undefined) {
      throw new Error("Expected bot access policy");
    }
    const pendingAccess: AccessPolicy = {
      ...access,
      pendingPairings: {
        "pair-code": {
          senderId: EXPLICIT_USER_ID,
          dmChannelId: DM_CHANNEL_ID,
          createdAt: NOW,
          expiresAt: LATER,
          replyCount: 0,
        },
      },
    };
    await updateCurrentAccess(registry, "bot-one", (currentAccess) => ({
      ...currentAccess,
      pendingPairings: pendingAccess.pendingPairings,
    }));

    const approved = await registry.approvePairing("bot-one", "pair-code");
    const persisted = await new RegistryStore({ registryPath }).read();

    expect(approved.allowFrom).toContain(EXPLICIT_USER_ID);
    expect(approved.pendingPairings).not.toHaveProperty("pair-code");
    expect(persisted.access["bot-one"]).toEqual(approved);
  });

  it("rejects expired pairing codes", async () => {
    const { registry } = await createRegistry();
    await registry.registerBot(bot());
    const document = await registry.read();
    const access = document.access["bot-one"];
    if (access === undefined) {
      throw new Error("Expected bot access policy");
    }
    await updateCurrentAccess(registry, "bot-one", (currentAccess) => ({
      ...currentAccess,
      pendingPairings: {
        expired: {
          senderId: EXPLICIT_USER_ID,
          dmChannelId: DM_CHANNEL_ID,
          createdAt: "2026-07-24T08:00:00.000Z",
          expiresAt: "2026-07-24T09:00:00.000Z",
          replyCount: 0,
        },
      },
    }));

    await expectBridgeError(registry.approvePairing("bot-one", "expired"), "CONFLICT");
  });

  it("does not expose caller-owned mutable access-policy references", async () => {
    const { registry } = await createRegistry();
    await registry.registerBot(bot());
    const current = (await registry.read()).access["bot-one"];
    if (current === undefined) {
      throw new Error("Expected bot access policy");
    }
    const next: AccessPolicy = { ...current, ackReaction: "\u2611\uFE0F" };
    const committed = await casUpdateAccess(registry, "bot-one", revisionFor(current), next);
    next.allowFrom.push(EXPLICIT_USER_ID);
    committed.allowFrom.push(SECOND_EXPLICIT_USER_ID);

    expect((await registry.read()).access["bot-one"]?.allowFrom).not.toContain(EXPLICIT_USER_ID);
    expect((await registry.read()).access["bot-one"]?.allowFrom).not.toContain(
      SECOND_EXPLICIT_USER_ID,
    );
  });

  it.each(["__proto__", "prototype", "constructor"])(
    "rejects unsafe pairing code %s",
    async (pairingCode) => {
      const { registry } = await createRegistry();
      await registry.registerBot(bot());

      await expectBridgeError(registry.approvePairing("bot-one", pairingCode), "INVALID_ARGUMENT");
    },
  );

  it("does not count inherited constructor properties as bot resources", async () => {
    const { registry } = await createRegistry();
    await registry.addWorkspace(workspace());

    await expectBridgeError(
      registry.createBinding(bindingInput({ botName: "constructor" })),
      "NOT_FOUND",
    );
  });

  it("does not count inherited constructor properties as workspace resources", async () => {
    const { registry } = await createRegistry();
    await registry.registerBot(bot());

    await expectBridgeError(
      registry.createBinding(bindingInput({ workspace: "constructor" })),
      "NOT_FOUND",
    );
  });

  it("rejects persisted JSON containing an own unsafe pairing key", async () => {
    const { registryPath, registry } = await createRegistry();
    await registry.registerBot(bot());
    const persisted = JSON.parse(await readFile(registryPath, "utf8")) as {
      access: Record<string, AccessPolicy>;
    };
    const pairing = {
      senderId: EXPLICIT_USER_ID,
      dmChannelId: DM_CHANNEL_ID,
      createdAt: NOW,
      expiresAt: LATER,
      replyCount: 0,
    };
    const access = persisted.access["bot-one"];
    if (access === undefined) {
      throw new Error("Expected bot access policy");
    }
    access.pendingPairings = JSON.parse(`{"__proto__":${JSON.stringify(pairing)}}`) as Record<
      string,
      typeof pairing
    >;
    await writeFile(registryPath, `${JSON.stringify(persisted)}\n`, "utf8");

    await expectBridgeError(registry.read(), "CONFIGURATION");
  });

  it("loads legacy v1 workspaces with explicit read-only sandbox without rewriting the file", async () => {
    const { registryPath } = await makeStatePath();
    await mkdir(dirname(registryPath), { recursive: true });
    const legacyWorkspace = workspace({ permissions: undefined, sandbox: undefined });
    const persisted = `${JSON.stringify({
      version: 1,
      bots: {},
      access: {},
      workspaces: { "main-workspace": legacyWorkspace },
      bindings: {},
    })}\n`;
    await writeFile(registryPath, persisted, "utf8");

    const loaded = await new RegistryStore({ registryPath }).read();

    expect(WorkspaceProfileSchema.safeParse(legacyWorkspace).success).toBe(false);
    expect(loaded.workspaces["main-workspace"]).toMatchObject({ sandbox: "read-only" });
    expect(await readFile(registryPath, "utf8")).toBe(persisted);
  });

  it("rejects both-present persisted workspace modes without overwriting malformed state", async () => {
    const { registryPath } = await makeStatePath();
    await mkdir(dirname(registryPath), { recursive: true });
    const persisted = `${JSON.stringify({
      version: 1,
      bots: {},
      access: {},
      workspaces: {
        "main-workspace": workspace({ permissions: "trusted", sandbox: "workspace-write" }),
      },
      bindings: {},
    })}\n`;
    await writeFile(registryPath, persisted, "utf8");

    await expectBridgeError(new RegistryStore({ registryPath }).read(), "CONFIGURATION");
    expect(await readFile(registryPath, "utf8")).toBe(persisted);
  });
});

describe("RegistryDocumentSchema", () => {
  it("keeps version-1 bindings without model settings backward compatible", () => {
    const binding = AgentBindingSchema.parse({
      id: BINDING_ONE_ID,
      name: "agent-one",
      botName: "bot-one",
      threadId: THREAD_ONE_ID,
      previousThreadIds: [],
      workspace: "main-workspace",
      tmuxSession: "codex-discord-agent-one",
      desiredState: "stopped",
      observedState: "stopped",
      createdAt: NOW,
      updatedAt: NOW,
    });

    expect(binding).not.toHaveProperty("modelId");
    expect(binding).not.toHaveProperty("reasoningEffort");
  });

  it("bounds model settings by code units and UTF-8 bytes and reserves default", () => {
    expect(ModelIdSchema.safeParse("gpt-5.6-sol").success).toBe(true);
    expect(ModelIdSchema.safeParse("x".repeat(257)).success).toBe(false);
    expect(ModelIdSchema.safeParse("界".repeat(256)).success).toBe(false);
    expect(ModelIdSchema.safeParse("bad\nmodel").success).toBe(false);
    expect(ModelIdSchema.safeParse("default").success).toBe(false);

    expect(ReasoningEffortSchema.safeParse("xhigh").success).toBe(true);
    expect(ReasoningEffortSchema.safeParse("x".repeat(65)).success).toBe(false);
    expect(ReasoningEffortSchema.safeParse("界".repeat(64)).success).toBe(false);
    expect(ReasoningEffortSchema.safeParse("bad\u007feffort").success).toBe(false);
    expect(ReasoningEffortSchema.safeParse("default").success).toBe(false);
  });

  it.each(["registering", "registered", "deleting"] as const)(
    "accepts valid unbound bot lifecycle state %s",
    (state) => {
      const document = {
        version: 1,
        bots: { "bot-one": bot({ state }) },
        access: { "bot-one": accessPolicy() },
        workspaces: {},
        bindings: {},
      };

      expect(RegistryDocumentSchema.safeParse(document).success).toBe(true);
    },
  );

  it("rejects an unbound failed bot without a concrete registration repair state", () => {
    const document = {
      version: 1,
      bots: { "bot-one": bot({ state: "failed" }) },
      access: { "bot-one": accessPolicy() },
      workspaces: {},
      bindings: {},
    };

    expect(RegistryDocumentSchema.safeParse(document).success).toBe(false);
  });

  it.each([
    ["stopped", "bound"],
    ["starting", "bound"],
    ["running", "running"],
    ["stopping", "running"],
    ["failed", "failed"],
  ] as const)("accepts observed %s with coherent bound bot state %s", (observedState, botState) => {
    const binding = {
      ...bindingInput(),
      previousThreadIds: [],
      desiredState: "stopped",
      observedState,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const document = {
      version: 1,
      bots: { "bot-one": bot({ state: botState }) },
      access: { "bot-one": accessPolicy() },
      workspaces: { "main-workspace": workspace() },
      bindings: { [BINDING_ONE_ID]: binding },
    };

    expect(RegistryDocumentSchema.safeParse(document).success).toBe(true);
  });

  it.each([
    ["stopped", "running"],
    ["starting", "failed"],
    ["running", "bound"],
    ["stopping", "bound"],
    ["failed", "running"],
  ] as const)(
    "rejects observed %s with incoherent bound bot state %s",
    (observedState, botState) => {
      const binding = {
        ...bindingInput(),
        previousThreadIds: [],
        desiredState: "stopped",
        observedState,
        createdAt: NOW,
        updatedAt: NOW,
      };
      const document = {
        version: 1,
        bots: { "bot-one": bot({ state: botState }) },
        access: { "bot-one": accessPolicy() },
        workspaces: { "main-workspace": workspace() },
        bindings: { [BINDING_ONE_ID]: binding },
      };

      expect(RegistryDocumentSchema.safeParse(document).success).toBe(false);
    },
  );

  it("rejects duplicate owner entries in the persisted allowlist", () => {
    const document = {
      version: 1,
      bots: { "bot-one": bot() },
      access: {
        "bot-one": accessPolicy(OWNER_ONE_ID, {
          allowFrom: [OWNER_ONE_ID, OWNER_ONE_ID],
        }),
      },
      workspaces: {},
      bindings: {},
    };

    expect(AccessPolicySchema.safeParse(document.access["bot-one"]).success).toBe(false);
    expect(RegistryDocumentSchema.safeParse(document).success).toBe(false);
  });

  it("rejects unknown persisted fields", () => {
    const document = {
      version: 1,
      bots: {},
      access: {},
      workspaces: {
        "main-workspace": {
          ...workspace(),
          unknown: true,
        },
      },
      bindings: {},
    };

    expect(RegistryDocumentSchema.safeParse(document).success).toBe(false);
  });

  it("rejects workspace permissions combined with sandbox", () => {
    const document = {
      version: 1,
      bots: {},
      access: {},
      workspaces: {
        "main-workspace": workspace({
          permissions: "trusted",
          sandbox: "workspace-write",
        }),
      },
      bindings: {},
    };

    expect(RegistryDocumentSchema.safeParse(document).success).toBe(false);
  });

  it("defaults a legacy persisted workspace with neither mode to read-only", () => {
    const document = {
      version: 1,
      bots: {},
      access: {},
      workspaces: {
        "main-workspace": workspace({ permissions: undefined, sandbox: undefined }),
      },
      bindings: {},
    };

    const parsed = RegistryDocumentSchema.parse(document);
    expect(parsed.workspaces["main-workspace"]).toMatchObject({ sandbox: "read-only" });
    expect(WorkspaceProfileSchema.safeParse(document.workspaces["main-workspace"]).success).toBe(
      false,
    );
  });

  it("uses the shared UUID thread schema for current and historical UUIDv7 IDs", () => {
    const current = "019535d0-9f4a-7cc3-98c4-1d8efc0c1234";
    const previous = "019535d0-a04b-7a31-8e74-42a612b5c678";

    expect(ThreadIdSchema.parse(current)).toBe(current);
    expect(
      AgentBindingSchema.safeParse({
        id: BINDING_ONE_ID,
        name: "agent-one",
        botName: "bot-one",
        threadId: current,
        previousThreadIds: [previous],
        workspace: "main-workspace",
        tmuxSession: "codex-discord-agent-one",
        desiredState: "running",
        observedState: "stopped",
        createdAt: NOW,
        updatedAt: NOW,
      }).success,
    ).toBe(true);
    expect(ThreadIdSchema.safeParse("thread-one").success).toBe(false);
  });

  it("rejects persisted access that omits the automatic owner allowlist", () => {
    const accessWithoutOwner = accessPolicy(OWNER_ONE_ID, { allowFrom: [] });
    const document = {
      version: 1,
      bots: { "bot-one": bot() },
      access: { "bot-one": accessWithoutOwner },
      workspaces: {},
      bindings: {},
    };

    expect(RegistryDocumentSchema.safeParse(document).success).toBe(false);
  });

  it("rejects duplicate persisted Keychain accounts", () => {
    const document = {
      version: 1,
      bots: {
        "bot-one": bot(),
        "bot-two": bot({
          name: "bot-two",
          applicationId: BOT_TWO_APPLICATION_ID,
          botUserId: BOT_TWO_USER_ID,
        }),
      },
      access: {
        "bot-one": accessPolicy(),
        "bot-two": accessPolicy(),
      },
      workspaces: {},
      bindings: {},
    };

    expect(RegistryDocumentSchema.safeParse(document).success).toBe(false);
  });

  it("rejects bot lifecycle state that is incoherent with its binding", () => {
    const binding = {
      ...bindingInput(),
      previousThreadIds: [],
      desiredState: "stopped",
      observedState: "stopped",
      createdAt: NOW,
      updatedAt: NOW,
    };
    const document = {
      version: 1,
      bots: { "bot-one": bot({ state: "registered" }) },
      access: { "bot-one": accessPolicy() },
      workspaces: { "main-workspace": workspace() },
      bindings: { [BINDING_ONE_ID]: binding },
    };

    expect(RegistryDocumentSchema.safeParse(document).success).toBe(false);
  });

  it("rejects a bound bot without a binding", () => {
    const document = {
      version: 1,
      bots: { "bot-one": bot({ state: "bound" }) },
      access: { "bot-one": accessPolicy() },
      workspaces: {},
      bindings: {},
    };

    expect(RegistryDocumentSchema.safeParse(document).success).toBe(false);
  });

  it("rejects key identity mismatches and duplicate persisted identities", () => {
    const binding = {
      ...bindingInput(),
      previousThreadIds: [],
      desiredState: "stopped",
      observedState: "stopped",
      createdAt: NOW,
      updatedAt: NOW,
    };
    const document = {
      version: 1,
      bots: {
        "wrong-key": bot(),
        "bot-two": bot({
          name: "bot-two",
          applicationId: BOT_ONE_APPLICATION_ID,
          botUserId: BOT_TWO_USER_ID,
          keychainAccount: "codex-discord-bot-two",
        }),
      },
      access: {},
      workspaces: { "main-workspace": workspace() },
      bindings: {
        "wrong-binding-key": binding,
        [BINDING_TWO_ID]: {
          ...binding,
          id: BINDING_TWO_ID,
          name: "agent-two",
          botName: "bot-two",
          threadId: THREAD_TWO_ID,
        },
      },
    };

    expect(RegistryDocumentSchema.safeParse(document).success).toBe(false);
  });
});
