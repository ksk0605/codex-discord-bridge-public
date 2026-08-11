import { execFile } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveStatePaths } from "../../src/config/paths.js";
import type { WorkspaceProfile } from "../../src/domain/schemas.js";
import {
  type BridgePathMetadata,
  type NormalizedWorkspace,
  validateOutboundFile,
  WorkspaceNormalizer,
} from "../../src/manager/workspaces.js";

const execFileAsync = promisify(execFile);
const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_INSTANCE_ID = "22222222-2222-4222-8222-222222222222";
const ESCAPED_INSTANCE_ID = "33333333-3333-4333-8333-333333333333";
const ALIASED_INSTANCE_ID = "44444444-4444-4444-8444-444444444444";

let temporaryDirectory: string;
let projectDirectory: string;
let outsideDirectory: string;
let inboxDirectory: string;
let otherInboxDirectory: string;
let bridgePaths: BridgePathMetadata;

function profile(overrides: Partial<WorkspaceProfile> = {}): WorkspaceProfile {
  return {
    name: "test-workspace",
    cwd: projectDirectory,
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    runtimeWorkspaceRoots: [projectDirectory],
    developerInstructions: "Use the project conventions.",
    ...overrides,
  };
}

function expectBridgeCode(code: string) {
  return expect.objectContaining({ code });
}

interface TestAuthorizedOutboundFile {
  readonly canonicalPath: string;
  readonly displayFilename: string;
  readonly size: number;
  readonly isClosed: boolean;
  createReadStream(): AsyncIterable<Buffer | string>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

async function readAuthorizedFile(file: TestAuthorizedOutboundFile): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of file.createReadStream()) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function authorizeAndExpect(
  input: string,
  workspace: NormalizedWorkspace,
  contents: string,
): Promise<TestAuthorizedOutboundFile> {
  const value: unknown = await validateOutboundFile(input, { workspace });
  const canonicalPath = await realpath(input);
  expect(value).toMatchObject({
    canonicalPath,
    displayFilename: basename(canonicalPath),
    isClosed: false,
    size: Buffer.byteLength(contents),
  });
  const authorized = value as TestAuthorizedOutboundFile;
  expect(await readAuthorizedFile(authorized)).toBe(contents);
  return authorized;
}

async function makeNormalizedWorkspace(
  overrides: Partial<WorkspaceProfile> = {},
): Promise<NormalizedWorkspace> {
  return new WorkspaceNormalizer({ bridgePaths }).normalize(profile(overrides), inboxDirectory);
}

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "codex-discord-workspaces-"));
  projectDirectory = join(temporaryDirectory, "project");
  outsideDirectory = join(temporaryDirectory, "project-prefix-collision");
  const stateRoot = join(temporaryDirectory, "bridge-state");
  inboxDirectory = join(stateRoot, "inbox", INSTANCE_ID);
  otherInboxDirectory = join(stateRoot, "inbox", OTHER_INSTANCE_ID);
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
    mkdir(outsideDirectory, { recursive: true }),
    mkdir(inboxDirectory, { recursive: true }),
    mkdir(otherInboxDirectory, { recursive: true }),
    mkdir(bridgePaths.logsDirectory, { recursive: true }),
    mkdir(bridgePaths.instancesDirectory, { recursive: true }),
  ]);
});

afterEach(async () => {
  await chmod(temporaryDirectory, 0o700).catch(() => undefined);
  await rm(temporaryDirectory, { force: true, recursive: true });
});

describe("WorkspaceNormalizer", () => {
  it("canonicalizes existing directories, deduplicates roots, and appends the isolated inbox", async () => {
    const workspaceLink = join(temporaryDirectory, "workspace-link");
    await symlink(projectDirectory, workspaceLink);
    const input = profile({
      cwd: workspaceLink,
      runtimeWorkspaceRoots: [workspaceLink, projectDirectory],
    });

    const normalized = await new WorkspaceNormalizer({ bridgePaths }).normalize(
      input,
      inboxDirectory,
    );

    expect(normalized).toMatchObject({
      name: "test-workspace",
      cwd: await realpath(projectDirectory),
      configuredRuntimeWorkspaceRoots: [await realpath(projectDirectory)],
      runtimeWorkspaceRoots: [await realpath(projectDirectory), await realpath(inboxDirectory)],
      instanceInbox: await realpath(inboxDirectory),
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      developerInstructions: "Use the project conventions.",
    });
    expect(Object.hasOwn(normalized, "permissions")).toBe(false);
  });

  it.each([
    ["missing cwd", () => profile({ cwd: join(temporaryDirectory, "missing") })],
    ["relative cwd", () => profile({ cwd: "relative/path" })],
    ["file cwd", () => profile({ cwd: join(temporaryDirectory, "file") })],
    [
      "missing runtime root",
      () => profile({ runtimeWorkspaceRoots: [join(temporaryDirectory, "missing-root")] }),
    ],
  ])("rejects a %s", async (_label, makeProfile) => {
    await writeFile(join(temporaryDirectory, "file"), "not a directory");
    await expect(
      new WorkspaceNormalizer({ bridgePaths }).normalize(makeProfile(), inboxDirectory),
    ).rejects.toEqual(expectBridgeCode("CONFIGURATION"));
  });

  it("rejects relative, missing, and non-directory inbox paths", async () => {
    const normalizer = new WorkspaceNormalizer({ bridgePaths });
    const file = join(bridgePaths.inboxDirectory, "file");
    await writeFile(file, "not a directory");

    await expect(normalizer.normalize(profile(), "relative-inbox")).rejects.toEqual(
      expectBridgeCode("CONFIGURATION"),
    );
    await expect(
      normalizer.normalize(profile(), join(bridgePaths.inboxDirectory, "missing")),
    ).rejects.toEqual(expectBridgeCode("CONFIGURATION"));
    await expect(normalizer.normalize(profile(), file)).rejects.toEqual(
      expectBridgeCode("CONFIGURATION"),
    );
  });

  it("rejects symlink loops and inaccessible path failures without leaking profile text", async () => {
    const loop = join(temporaryDirectory, "loop");
    await symlink(loop, loop);
    const secret = "private developer instruction";

    const rejection = new WorkspaceNormalizer({ bridgePaths }).normalize(
      profile({ cwd: loop, developerInstructions: secret }),
      inboxDirectory,
    );

    await expect(rejection).rejects.toEqual(expectBridgeCode("CONFIGURATION"));
    await expect(rejection).rejects.not.toThrow(secret);
  });

  it("uses the injected filesystem seam and maps inaccessible directories safely", async () => {
    const inaccessible = Object.assign(new Error("sensitive path detail"), { code: "EACCES" });
    const normalizer = new WorkspaceNormalizer({
      bridgePaths,
      fileSystem: {
        realpath: async (path) => {
          if (path === projectDirectory) throw inaccessible;
          return realpath(path);
        },
        stat,
      },
    });

    const rejection = normalizer.normalize(profile(), inboxDirectory);
    await expect(rejection).rejects.toEqual(expectBridgeCode("CONFIGURATION"));
    await expect(rejection).rejects.not.toThrow("sensitive path detail");
  });

  it("rejects roots equal to, inside, or containing registry, logs, and instance state", async () => {
    const normalizer = new WorkspaceNormalizer({ bridgePaths });
    const logChild = join(bridgePaths.logsDirectory, "child");
    await mkdir(logChild);

    for (const denied of [
      bridgePaths.logsDirectory,
      logChild,
      bridgePaths.root,
      temporaryDirectory,
      bridgePaths.instancesDirectory,
    ]) {
      await expect(
        normalizer.normalize(profile({ runtimeWorkspaceRoots: [denied] }), inboxDirectory),
      ).rejects.toEqual(expectBridgeCode("CONFIGURATION"));
    }
  });

  it.each([
    ["state root", () => bridgePaths.root],
    ["state child", () => join(bridgePaths.root, "state-child")],
    ["shared inbox root", () => bridgePaths.inboxDirectory],
    ["current inbox", () => inboxDirectory],
    ["another inbox", () => otherInboxDirectory],
    ["home ancestor", () => temporaryDirectory],
  ])("rejects a profile selecting the %s", async (_label, deniedPath) => {
    const normalizer = new WorkspaceNormalizer({ bridgePaths });
    const denied = deniedPath();
    await mkdir(denied, { recursive: true });

    await expect(
      normalizer.normalize(profile({ cwd: denied, runtimeWorkspaceRoots: [] }), inboxDirectory),
    ).rejects.toEqual(expectBridgeCode("CONFIGURATION"));
    await expect(
      normalizer.normalize(profile({ runtimeWorkspaceRoots: [denied] }), inboxDirectory),
    ).rejects.toEqual(expectBridgeCode("CONFIGURATION"));
  });

  it("requires the manager inbox to be one exact safe canonical child of the shared inbox", async () => {
    const normalizer = new WorkspaceNormalizer({ bridgePaths });
    const nested = join(inboxDirectory, "nested");
    const unsafeName = join(bridgePaths.inboxDirectory, "unsafe.name");
    const escapedLink = join(bridgePaths.inboxDirectory, ESCAPED_INSTANCE_ID);
    const aliasedInbox = join(bridgePaths.inboxDirectory, ALIASED_INSTANCE_ID);
    await mkdir(nested);
    await mkdir(unsafeName);
    await symlink(projectDirectory, escapedLink);
    await symlink(otherInboxDirectory, aliasedInbox);

    for (const denied of [
      bridgePaths.inboxDirectory,
      nested,
      unsafeName,
      escapedLink,
      aliasedInbox,
    ]) {
      await expect(normalizer.normalize(profile(), denied)).rejects.toEqual(
        expectBridgeCode("CONFIGURATION"),
      );
    }
  });

  it.each(["registryPath", "logsDirectory", "instancesDirectory", "managerStatePaths"] as const)(
    "rejects the current inbox configured as hard protected %s",
    async (field) => {
      const conflictedPaths: BridgePathMetadata =
        field === "managerStatePaths"
          ? { ...bridgePaths, managerStatePaths: [inboxDirectory] }
          : { ...bridgePaths, [field]: inboxDirectory };

      await expect(
        new WorkspaceNormalizer({ bridgePaths: conflictedPaths }).normalize(
          profile(),
          inboxDirectory,
        ),
      ).rejects.toEqual(expectBridgeCode("CONFIGURATION"));
    },
  );

  it("denies a broad root containing a protected registry file that does not exist yet", async () => {
    const broad = join(temporaryDirectory, "broad");
    const stateRoot = join(broad, "nested-state");
    await mkdir(broad);
    const paths: BridgePathMetadata = {
      root: stateRoot,
      registryPath: join(stateRoot, "registry.json"),
      logsDirectory: join(stateRoot, "logs"),
      instancesDirectory: join(stateRoot, "instances"),
      inboxDirectory: join(stateRoot, "inbox"),
      managerStatePaths: [join(stateRoot, "manager.json")],
    };
    const instanceInbox = join(paths.inboxDirectory, INSTANCE_ID);
    await mkdir(instanceInbox, { recursive: true });

    await expect(
      new WorkspaceNormalizer({ bridgePaths: paths }).normalize(
        profile({ cwd: broad, runtimeWorkspaceRoots: [] }),
        instanceInbox,
      ),
    ).rejects.toMatchObject({
      code: "CONFIGURATION",
      message: "Workspace cwd overlaps hard protected bridge state.",
    });
  });

  it("rejects malformed policies and emits exactly one permission mode", async () => {
    const normalizer = new WorkspaceNormalizer({ bridgePaths });
    const permissions = await normalizer.normalize(
      profile({ permissions: "workspace-write", sandbox: undefined }),
      inboxDirectory,
    );
    expect(permissions.permissions).toBe("workspace-write");
    expect(Object.hasOwn(permissions, "sandbox")).toBe(false);

    for (const malformed of [
      profile({ approvalPolicy: "sometimes" }),
      profile({ sandbox: "partial" }),
      profile({ permissions: "INVALID PERMISSION", sandbox: undefined }),
      { ...profile(), permissions: "workspace-write" },
      profile({ permissions: undefined, sandbox: undefined }),
      { ...profile(), model: "" },
      { ...profile(), serviceTier: "" },
    ]) {
      await expect(
        normalizer.normalize(malformed as WorkspaceProfile, inboxDirectory),
      ).rejects.toEqual(expectBridgeCode("CONFIGURATION"));
    }
  });

  it("returns a deeply immutable value independent of mutable profile input", async () => {
    const input = profile();
    const normalized = await new WorkspaceNormalizer({ bridgePaths }).normalize(
      input,
      inboxDirectory,
    );
    input.runtimeWorkspaceRoots.push(outsideDirectory);
    input.developerInstructions = "changed";

    expect(normalized.runtimeWorkspaceRoots).not.toContain(outsideDirectory);
    expect(normalized.developerInstructions).toBe("Use the project conventions.");
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.runtimeWorkspaceRoots)).toBe(true);
    expect(() => (normalized.runtimeWorkspaceRoots as string[]).push(outsideDirectory)).toThrow();
  });
});

describe("validateOutboundFile", () => {
  it("returns canonical regular files with spaces and brackets under approved roots", async () => {
    const workspace = await makeNormalizedWorkspace();
    const file = join(projectDirectory, "report [final].txt");
    await writeFile(file, "report");

    const authorized = await authorizeAndExpect(file, workspace, "report");
    await authorized.close();
  });

  it.each(["", "relative.txt", "\0bad", "/tmp/control\tfile"])(
    "rejects malformed outbound path %j",
    async (path) => {
      const workspace = await makeNormalizedWorkspace();
      await expect(validateOutboundFile(path, { workspace })).rejects.toEqual(
        expectBridgeCode("INVALID_ARGUMENT"),
      );
    },
  );

  it("uses canonical containment rather than prefixes and resolves dot segments", async () => {
    const workspace = await makeNormalizedWorkspace();
    const inside = join(projectDirectory, "inside.txt");
    const outside = join(outsideDirectory, "outside.txt");
    await writeFile(inside, "inside");
    await writeFile(outside, "outside");

    const authorized = await authorizeAndExpect(
      join(projectDirectory, "sub", "..", "inside.txt"),
      workspace,
      "inside",
    );
    await authorized.close();
    await expect(validateOutboundFile(outside, { workspace })).rejects.toEqual(
      expectBridgeCode("UNAUTHORIZED"),
    );
    await expect(
      validateOutboundFile(
        join(projectDirectory, "..", "project-prefix-collision", "outside.txt"),
        {
          workspace,
        },
      ),
    ).rejects.toEqual(expectBridgeCode("UNAUTHORIZED"));
  });

  it("allows symlinks that remain inside and denies symlinks escaping allowed roots", async () => {
    const workspace = await makeNormalizedWorkspace();
    const inside = join(projectDirectory, "inside.txt");
    const outside = join(outsideDirectory, "outside.txt");
    const insideLink = join(projectDirectory, "inside-link.txt");
    const outsideLink = join(projectDirectory, "outside-link.txt");
    await writeFile(inside, "inside");
    await writeFile(outside, "outside");
    await symlink(inside, insideLink);
    await symlink(outside, outsideLink);

    const authorized = await authorizeAndExpect(insideLink, workspace, "inside");
    await authorized.close();
    await expect(validateOutboundFile(outsideLink, { workspace })).rejects.toEqual(
      expectBridgeCode("UNAUTHORIZED"),
    );
  });

  it("explicitly denies protected bridge files reached through a workspace symlink", async () => {
    const workspace = await makeNormalizedWorkspace();
    const protectedLog = join(bridgePaths.logsDirectory, "instance.log");
    const link = join(projectDirectory, "log-link");
    await writeFile(protectedLog, "sensitive");
    await symlink(protectedLog, link);

    await expect(validateOutboundFile(link, { workspace })).rejects.toEqual(
      expectBridgeCode("UNAUTHORIZED"),
    );
  });

  it("protects the per-instance progress journal from workspace roots and outbound symlinks", async () => {
    const progressJournal = resolveStatePaths(bridgePaths.root).progressJournalPath(INSTANCE_ID);
    const progressDirectory = dirname(progressJournal);
    const journalLink = join(projectDirectory, "progress-journal-link.json");
    await mkdir(progressDirectory, { recursive: true });
    await writeFile(progressJournal, '{"version":1}\n');
    await symlink(progressJournal, journalLink);

    await expect(
      new WorkspaceNormalizer({ bridgePaths }).normalize(
        profile({ runtimeWorkspaceRoots: [progressDirectory] }),
        inboxDirectory,
      ),
    ).rejects.toEqual(expectBridgeCode("CONFIGURATION"));

    const workspace = await makeNormalizedWorkspace();
    await expect(validateOutboundFile(journalLink, { workspace })).rejects.toEqual(
      expectBridgeCode("UNAUTHORIZED"),
    );
  });

  it("allows only the exact current inbox and denies every other shared inbox", async () => {
    const workspace = await makeNormalizedWorkspace();
    const ownFile = join(inboxDirectory, "own.txt");
    const otherFile = join(otherInboxDirectory, "other.txt");
    const stateFile = join(bridgePaths.root, "state.txt");
    const sharedInboxFile = join(bridgePaths.inboxDirectory, "shared.txt");
    const otherLink = join(projectDirectory, "other-inbox-link.txt");
    await writeFile(ownFile, "own");
    await writeFile(otherFile, "other");
    await writeFile(stateFile, "state");
    await writeFile(sharedInboxFile, "shared");
    await symlink(otherFile, otherLink);

    const authorized = await authorizeAndExpect(ownFile, workspace, "own");
    await authorized.close();
    await expect(validateOutboundFile(otherFile, { workspace })).rejects.toEqual(
      expectBridgeCode("UNAUTHORIZED"),
    );
    await expect(validateOutboundFile(otherLink, { workspace })).rejects.toEqual(
      expectBridgeCode("UNAUTHORIZED"),
    );
    await expect(validateOutboundFile(stateFile, { workspace })).rejects.toEqual(
      expectBridgeCode("UNAUTHORIZED"),
    );
    await expect(validateOutboundFile(sharedInboxFile, { workspace })).rejects.toEqual(
      expectBridgeCode("UNAUTHORIZED"),
    );
  });

  it("denies every hard protected path nested under the current inbox before its carveout", async () => {
    const nestedRegistry = join(inboxDirectory, "registry.json");
    const nestedLogs = join(inboxDirectory, "logs");
    const nestedInstances = join(inboxDirectory, "instances");
    const nestedManagerState = join(inboxDirectory, "manager-state");
    const hardTargets = [
      nestedRegistry,
      join(nestedLogs, "bridge.log"),
      join(nestedInstances, "runtime.json"),
      join(nestedManagerState, "manager.json"),
    ];
    const ordinaryFile = join(inboxDirectory, "ordinary.txt");
    const nestedBridgePaths: BridgePathMetadata = {
      ...bridgePaths,
      registryPath: nestedRegistry,
      logsDirectory: nestedLogs,
      instancesDirectory: nestedInstances,
      managerStatePaths: [nestedManagerState],
    };
    await Promise.all([mkdir(nestedLogs), mkdir(nestedInstances), mkdir(nestedManagerState)]);
    await Promise.all([
      ...hardTargets.map((target) => writeFile(target, "protected")),
      writeFile(ordinaryFile, "ordinary"),
    ]);
    const hardLinkTargets = hardTargets.map((target, index) => ({
      link: join(inboxDirectory, `protected-link-${String(index)}.txt`),
      target,
    }));
    await Promise.all(hardLinkTargets.map(({ link, target }) => symlink(target, link)));
    const hardLinks = hardLinkTargets.map(({ link }) => link);

    const workspace = await new WorkspaceNormalizer({
      bridgePaths: nestedBridgePaths,
    }).normalize(profile(), inboxDirectory);

    for (const denied of [...hardTargets, ...hardLinks]) {
      await expect(validateOutboundFile(denied, { workspace })).rejects.toEqual(
        expectBridgeCode("UNAUTHORIZED"),
      );
    }
    const authorized = await authorizeAndExpect(ordinaryFile, workspace, "ordinary");
    await authorized.close();
  });

  it("rejects safe-looking symlinks whose canonical target path contains controls", async () => {
    const workspace = await makeNormalizedWorkspace();
    const controlledFile = join(projectDirectory, "line\nfeed.txt");
    const controlledParent = join(projectDirectory, "tab\tparent");
    const fileLink = join(projectDirectory, "safe-file-link.txt");
    const parentLink = join(projectDirectory, "safe-parent-link.txt");
    const nestedFile = join(controlledParent, "result.txt");
    await writeFile(controlledFile, "controlled");
    await mkdir(controlledParent);
    await writeFile(nestedFile, "nested");
    await symlink(controlledFile, fileLink);
    await symlink(nestedFile, parentLink);

    await expect(validateOutboundFile(fileLink, { workspace })).rejects.toEqual(
      expectBridgeCode("INVALID_ARGUMENT"),
    );
    await expect(validateOutboundFile(parentLink, { workspace })).rejects.toEqual(
      expectBridgeCode("INVALID_ARGUMENT"),
    );
  });

  it("re-resolves a changed symlink on every use", async () => {
    const workspace = await makeNormalizedWorkspace();
    const inside = join(projectDirectory, "inside.txt");
    const outside = join(outsideDirectory, "outside.txt");
    const link = join(projectDirectory, "mutable-link.txt");
    await writeFile(inside, "inside");
    await writeFile(outside, "outside");
    await symlink(inside, link);
    const authorized = await authorizeAndExpect(link, workspace, "inside");
    await authorized.close();

    await unlink(link);
    await symlink(outside, link);
    await expect(validateOutboundFile(link, { workspace })).rejects.toEqual(
      expectBridgeCode("UNAUTHORIZED"),
    );
  });

  it("retains the authorized file identity when its pathname is replaced", async () => {
    const workspace = await makeNormalizedWorkspace();
    const file = join(projectDirectory, "result.txt");
    const moved = join(projectDirectory, "authorized-result.txt");
    const protectedLog = join(bridgePaths.logsDirectory, "protected.log");
    await writeFile(file, "authorized bytes");
    await writeFile(protectedLog, "protected bytes");

    const authorized = (await validateOutboundFile(file, {
      workspace,
    })) as unknown as TestAuthorizedOutboundFile;
    await rename(file, moved);
    await symlink(protectedLog, file);

    expect(await readAuthorizedFile(authorized)).toBe("authorized bytes");
    await authorized.close();
  });

  it("detects replacement between the pathname snapshot and descriptor open", async () => {
    const workspace = await makeNormalizedWorkspace();
    const file = join(projectDirectory, "result.txt");
    const moved = join(projectDirectory, "moved-result.txt");
    const protectedLog = join(bridgePaths.logsDirectory, "protected.log");
    const canonical = await realpath(projectDirectory).then((root) => join(root, "result.txt"));
    await writeFile(file, "result");
    await writeFile(protectedLog, "protected");
    let swapped = false;

    await expect(
      validateOutboundFile(file, {
        workspace,
        fileSystem: {
          realpath,
          stat,
          lstat,
          open: async (path: string, flags: number) => {
            if (path === canonical && !swapped) {
              swapped = true;
              await rename(file, moved);
              await symlink(protectedLog, file);
            }
            return open(path, flags);
          },
        } as never,
      }),
    ).rejects.toEqual(expectBridgeCode("UNAUTHORIZED"));
    expect(swapped).toBe(true);
  });

  it("rejects a retained descriptor whose parent was moved outside and replaced by a symlink", async () => {
    const workspace = await makeNormalizedWorkspace();
    const parent = join(projectDirectory, "replaceable-parent");
    const movedParent = join(outsideDirectory, "moved-parent");
    const file = join(parent, "result.txt");
    const movedFile = join(movedParent, "result.txt");
    await mkdir(parent);
    await writeFile(file, "same inode");
    let swapped = false;
    let resolvedDescriptor = false;

    const outcome = await validateOutboundFile(file, {
      workspace,
      fileSystem: {
        realpath,
        stat,
        lstat,
        open: async (path: string, flags: number) => {
          if (!swapped) {
            swapped = true;
            await rename(parent, movedParent);
            await symlink(movedParent, parent);
          }
          return open(path, flags);
        },
      },
      descriptorPathResolver: {
        resolve: async (descriptor: number) => {
          expect(Number.isSafeInteger(descriptor)).toBe(true);
          resolvedDescriptor = true;
          return movedFile;
        },
      },
    } as never).then(
      async (authorized) => {
        await authorized.close();
        return { authorized: true } as const;
      },
      (error: unknown) => ({ error }),
    );

    expect(swapped).toBe(true);
    expect(resolvedDescriptor).toBe(true);
    expect(outcome).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("does not query a descriptor-reported pathname after F_GETPATH resolution", async () => {
    const workspace = await makeNormalizedWorkspace();
    const parent = join(projectDirectory, "descriptor-decoy");
    const movedParent = join(outsideDirectory, "descriptor-decoy-moved");
    const replacementParent = join(outsideDirectory, "descriptor-decoy-replacement");
    const file = join(parent, "result.txt");
    const descriptorPath = await realpath(projectDirectory).then((root) =>
      join(root, "descriptor-decoy", "result.txt"),
    );
    await mkdir(parent);
    await mkdir(replacementParent);
    await writeFile(file, "retained bytes");
    await writeFile(join(replacementParent, "result.txt"), "replacement bytes");
    let descriptorResolved = false;
    const rejectPostResolutionPathCall =
      <Arguments extends unknown[], Result>(
        operation: (...arguments_: Arguments) => Promise<Result>,
      ) =>
      async (...arguments_: Arguments): Promise<Result> => {
        if (descriptorResolved) {
          throw new Error("pathname filesystem API called after descriptor resolution");
        }
        return operation(...arguments_);
      };

    const authorized = (await validateOutboundFile(file, {
      workspace,
      fileSystem: {
        realpath: rejectPostResolutionPathCall(realpath),
        stat: rejectPostResolutionPathCall(stat),
        lstat: rejectPostResolutionPathCall(lstat),
        open: rejectPostResolutionPathCall(open),
      },
      descriptorPathResolver: {
        resolve: async () => {
          await rename(parent, movedParent);
          await symlink(replacementParent, parent);
          descriptorResolved = true;
          return descriptorPath;
        },
      },
    } as never)) as unknown as TestAuthorizedOutboundFile;

    expect(descriptorResolved).toBe(true);
    expect(await readAuthorizedFile(authorized)).toBe("retained bytes");
    await authorized.close();
  });

  it("fails closed and closes the descriptor when its actual path cannot be established", async () => {
    const workspace = await makeNormalizedWorkspace();
    const file = join(projectDirectory, "unresolvable.txt");
    await writeFile(file, "content");
    let closeCalls = 0;

    const outcome = await validateOutboundFile(file, {
      workspace,
      fileSystem: {
        realpath,
        stat,
        lstat,
        open: async (path: string, flags: number) => {
          const handle = await open(path, flags);
          return {
            fd: handle.fd,
            close: async () => {
              closeCalls += 1;
              await handle.close();
            },
            createReadStream: handle.createReadStream.bind(handle),
            stat: handle.stat.bind(handle),
          };
        },
      },
      descriptorPathResolver: {
        resolve: async () => {
          throw new Error("untrusted resolver detail");
        },
      },
    } as never).then(
      async (authorized) => {
        await authorized.close();
        return { authorized: true } as const;
      },
      (error: unknown) => ({ error }),
    );

    expect(outcome).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    expect(closeCalls).toBe(1);
  });

  it("rejects hardlink aliases even when the alias is under an approved root", async () => {
    const workspace = await makeNormalizedWorkspace();
    const protectedLog = join(bridgePaths.logsDirectory, "protected.log");
    const alias = join(projectDirectory, "log-copy.txt");
    await writeFile(protectedLog, "protected");
    await link(protectedLog, alias);

    await expect(validateOutboundFile(alias, { workspace })).rejects.toEqual(
      expectBridgeCode("UNAUTHORIZED"),
    );
  });

  it("enforces the configured byte limit after open and closes the rejected descriptor", async () => {
    const workspace = await makeNormalizedWorkspace();
    const file = join(projectDirectory, "large.txt");
    await writeFile(file, "1234");
    let closeCalls = 0;

    await expect(
      validateOutboundFile(file, {
        workspace,
        maxFileBytes: 3,
        fileSystem: {
          realpath,
          stat,
          lstat,
          open: async (path: string, flags: number) => {
            const handle = await open(path, flags);
            return {
              close: async () => {
                closeCalls += 1;
                await handle.close();
              },
              createReadStream: handle.createReadStream.bind(handle),
              stat: handle.stat.bind(handle),
            };
          },
        },
      } as never),
    ).rejects.toEqual(expectBridgeCode("INVALID_ARGUMENT"));
    expect(closeCalls).toBe(1);
  });

  it.each([0, -1, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid configured byte limit %s before filesystem work",
    async (maxFileBytes) => {
      const workspace = await makeNormalizedWorkspace();
      const filesystemCall = vi.fn(async () => {
        throw new Error("filesystem must not be reached");
      });

      await expect(
        validateOutboundFile(join(projectDirectory, "result.txt"), {
          workspace,
          maxFileBytes,
          fileSystem: {
            lstat: filesystemCall,
            open: filesystemCall,
            realpath: filesystemCall,
            stat: filesystemCall,
          } as never,
        }),
      ).rejects.toEqual(expectBridgeCode("INVALID_ARGUMENT"));
      expect(filesystemCall).not.toHaveBeenCalled();
    },
  );

  it("makes caller-owned descriptor closure idempotent", async () => {
    const workspace = await makeNormalizedWorkspace();
    const file = join(projectDirectory, "close-me.txt");
    await writeFile(file, "close me");
    const authorized = await authorizeAndExpect(file, workspace, "close me");

    expect(Object.isFrozen(authorized)).toBe(true);
    expect(typeof authorized[Symbol.asyncDispose]).toBe("function");
    await authorized.close();
    await authorized.close();
    await authorized[Symbol.asyncDispose]();

    expect(authorized.isClosed).toBe(true);
    expect(() => authorized.createReadStream()).toThrow(expectBridgeCode("RUNTIME"));
  });

  it("rejects missing paths, directories, FIFOs, and devices with stable codes", async () => {
    const workspace = await makeNormalizedWorkspace();
    const fifo = join(projectDirectory, "pipe");
    await execFileAsync("mkfifo", [fifo]);

    await expect(
      validateOutboundFile(join(projectDirectory, "missing.txt"), { workspace }),
    ).rejects.toEqual(expectBridgeCode("NOT_FOUND"));
    await expect(validateOutboundFile(projectDirectory, { workspace })).rejects.toEqual(
      expectBridgeCode("INVALID_ARGUMENT"),
    );
    await expect(validateOutboundFile(fifo, { workspace })).rejects.toEqual(
      expectBridgeCode("INVALID_ARGUMENT"),
    );

    const deviceWorkspace = await makeNormalizedWorkspace({
      cwd: dirname("/dev/null"),
      runtimeWorkspaceRoots: [],
    });
    await expect(validateOutboundFile("/dev/null", { workspace: deviceWorkspace })).rejects.toEqual(
      expectBridgeCode("INVALID_ARGUMENT"),
    );
  });

  it("maps an inaccessible outbound file to UNAUTHORIZED through the filesystem seam", async () => {
    const workspace = await makeNormalizedWorkspace();
    const file = join(projectDirectory, "private.txt");
    await writeFile(file, "private");
    const inaccessible = Object.assign(new Error("sensitive path detail"), { code: "EACCES" });

    await expect(
      validateOutboundFile(file, {
        workspace,
        fileSystem: {
          lstat,
          open,
          realpath: async (path) => {
            if (path === file) throw inaccessible;
            return realpath(path);
          },
          stat,
        },
      }),
    ).rejects.toEqual(expectBridgeCode("UNAUTHORIZED"));
  });
});
