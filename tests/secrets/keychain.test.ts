import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeError, type BridgeErrorCode } from "../../src/domain/errors.js";
import {
  KEYCHAIN_NOT_FOUND_EXIT_CODE,
  type KeychainSpawn,
  KeychainStore,
  MAX_KEYCHAIN_TOKEN_BYTES,
} from "../../src/secrets/keychain.js";

interface FakeHelperControl {
  readonly mode?: "normal" | "hang" | "signal";
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly accounts?: readonly string[];
  readonly getValueBase64?: string;
}

interface FakeHelper {
  readonly directory: string;
  readonly executablePath: string;
  readonly capturePath: string;
}

interface NonClosingFakeChild {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly kill: ReturnType<typeof vi.fn>;
  readonly unref: ReturnType<typeof vi.fn>;
}

const temporaryDirectories: string[] = [];
const NATIVE_HELPER_SOURCE_PATH = fileURLToPath(
  new URL("../../native/keychain-helper.m", import.meta.url),
);

const FAKE_HELPER_SOURCE = `#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const control = JSON.parse(await readFile(join(directory, "control.json"), "utf8"));
const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}
const input = Buffer.concat(chunks);
const argv = process.argv.slice(2);
await writeFile(
  join(directory, "capture.json"),
  JSON.stringify({
    argv,
    stdinBytes: input.byteLength,
    stdinSha256: createHash("sha256").update(input).digest("hex"),
    pid: process.pid,
  }),
  "utf8",
);

if (control.mode === "hang") {
  setInterval(() => {}, 1_000);
} else if (control.mode === "signal") {
  process.kill(process.pid, "SIGTERM");
} else {
  if (control.stdout !== undefined) {
    process.stdout.write(control.stdout);
  } else if (argv[0] === "get" && control.getValueBase64 !== undefined) {
    process.stdout.write(Buffer.from(control.getValueBase64, "base64"));
  } else if (argv[0] === "list") {
    process.stdout.write(JSON.stringify(control.accounts ?? []));
  }
  if (control.stderr !== undefined) {
    process.stderr.write(control.stderr);
  }
  process.exitCode = control.exitCode ?? 0;
}
`;

async function makeFakeHelper(control: FakeHelperControl = {}): Promise<FakeHelper> {
  const directory = await mkdtemp(join(tmpdir(), "codex-discord-keychain-"));
  temporaryDirectories.push(directory);
  const executablePath = join(directory, "fake-keychain-helper.mjs");
  const capturePath = join(directory, "capture.json");
  await writeFile(executablePath, FAKE_HELPER_SOURCE, "utf8");
  await writeFile(join(directory, "control.json"), JSON.stringify(control), "utf8");
  await chmod(executablePath, 0o700);
  return { directory, executablePath, capturePath };
}

async function readCapture(helper: FakeHelper): Promise<{
  argv: string[];
  stdinBytes: number;
  stdinSha256: string;
  pid: number;
}> {
  return JSON.parse(await readFile(helper.capturePath, "utf8")) as {
    argv: string[];
    stdinBytes: number;
    stdinSha256: string;
    pid: number;
  };
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

async function expectBridgeErrorWithin(
  promise: Promise<unknown>,
  code: BridgeErrorCode,
  maximumMs: number,
): Promise<BridgeError> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("Keychain operation did not settle in time")),
      maximumMs,
    );
  });
  try {
    return await expectBridgeError(Promise.race([promise, deadline]), code);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function makeNonClosingFakeChild(): NonClosingFakeChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = vi.fn(() => true);
  const unref = vi.fn();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    kill,
    unref,
  }) as unknown as ChildProcessWithoutNullStreams;
  return { child, stdin, stdout, stderr, kill, unref };
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

function serializedError(error: BridgeError): string {
  return JSON.stringify({
    name: error.name,
    code: error.code,
    message: error.message,
    remediation: error.remediation,
    cause: error.cause instanceof Error ? error.cause.message : error.cause,
  });
}

function nativeFunction(source: string, name: string): string {
  const start = source.indexOf(` ${name}(`);
  if (start < 0) {
    throw new Error(`Missing native helper function ${name}`);
  }
  const openingBrace = source.indexOf("{", start);
  if (openingBrace < 0) {
    throw new Error(`Missing native helper function body ${name}`);
  }

  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  throw new Error(`Unterminated native helper function body ${name}`);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("native Keychain query contract", () => {
  it("uses the current user's default keychain for exact item operations", async () => {
    const source = await readFile(NATIVE_HELPER_SOURCE_PATH, "utf8");
    const itemQuery = nativeFunction(source, "itemQuery");
    const setSecret = nativeFunction(source, "setSecret");

    expect(itemQuery).toContain("kSecClassGenericPassword");
    expect(itemQuery).toContain("kSecAttrService");
    expect(itemQuery).toContain("kSecAttrAccount");
    expect(itemQuery.includes("kSecUseDataProtectionKeychain")).toBe(false);
    expect(setSecret.includes("kSecAttrAccessible")).toBe(false);
    const exactItemQuery = "itemQuery(service, account)";
    expect(setSecret.split(exactItemQuery)).toHaveLength(3);
    expect(nativeFunction(source, "getSecret").split(exactItemQuery)).toHaveLength(2);
    expect(nativeFunction(source, "deleteSecret").split(exactItemQuery)).toHaveLength(2);
  });

  it("lists attributes only from the current user's default keychain", async () => {
    const source = await readFile(NATIVE_HELPER_SOURCE_PATH, "utf8");
    const getSecret = nativeFunction(source, "getSecret");
    const listAccounts = nativeFunction(source, "listAccounts");

    expect(getSecret).toContain("kSecReturnData");
    expect(getSecret.includes("kSecReturnAttributes")).toBe(false);
    expect(listAccounts.includes("kSecUseDataProtectionKeychain")).toBe(false);
    expect(listAccounts).toContain("kSecReturnAttributes");
    expect(listAccounts.includes("kSecReturnData")).toBe(false);
  });
});

describe("KeychainStore", () => {
  it("writes exact token bytes to stdin without placing the token in argv", async () => {
    const helper = await makeFakeHelper();
    const token = "token-with-leading-space \n\tand-no-trim";
    const store = new KeychainStore({
      helperPath: helper.executablePath,
      service: "com.example.bridge",
    });

    await store.set("bot-primary", token);

    const capture = await readCapture(helper);
    const tokenBytes = Buffer.from(token, "utf8");
    expect(capture).toMatchObject({
      argv: ["set", "com.example.bridge", "bot-primary"],
      stdinBytes: tokenBytes.byteLength,
      stdinSha256: createHash("sha256").update(tokenBytes).digest("hex"),
    });
    expect(capture.argv.some((argument) => argument.includes(token))).toBe(false);
  });

  it("returns the stored token without logging it", async () => {
    const token = "stored-token-never-logged";
    const helper = await makeFakeHelper({
      getValueBase64: Buffer.from(token).toString("base64"),
    });
    const consoleSpies = [
      vi.spyOn(console, "debug").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
    ];
    const store = new KeychainStore({
      helperPath: helper.executablePath,
      service: "com.example.bridge",
    });

    const storedToken = await store.get("bot-primary");

    expect(Buffer.byteLength(storedToken)).toBe(Buffer.byteLength(token));
    expect(createHash("sha256").update(storedToken).digest("hex")).toBe(
      createHash("sha256").update(token).digest("hex"),
    );
    expect(consoleSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    expect(await readCapture(helper)).toMatchObject({
      argv: ["get", "com.example.bridge", "bot-primary"],
      stdinBytes: 0,
    });
  });

  it("deletes the exact service and account entry", async () => {
    const helper = await makeFakeHelper();
    const store = new KeychainStore({
      helperPath: helper.executablePath,
      service: "com.example.bridge",
    });

    await store.delete("bot-secondary");

    expect(await readCapture(helper)).toMatchObject({
      argv: ["delete", "com.example.bridge", "bot-secondary"],
      stdinBytes: 0,
    });
  });

  it("lists only sorted bridge-owned account names", async () => {
    const helper = await makeFakeHelper({
      accounts: ["bot-primary", "bot-secondary"],
    });
    const store = new KeychainStore({
      helperPath: helper.executablePath,
      service: "com.example.bridge",
    });

    await expect(store.listAccounts()).resolves.toEqual(["bot-primary", "bot-secondary"]);
    expect(await readCapture(helper)).toMatchObject({
      argv: ["list", "com.example.bridge"],
      stdinBytes: 0,
    });
  });

  it("validates deterministic UTF-8 byte ordering for account names", async () => {
    const accounts = ["zeta", "\u00e9clair"];
    const helper = await makeFakeHelper({ accounts });
    const store = new KeychainStore({
      helperPath: helper.executablePath,
      service: "com.example.bridge",
    });

    await expect(store.listAccounts()).resolves.toEqual(accounts);
  });

  it("spawns the absolute helper directly without a shell", async () => {
    const helper = await makeFakeHelper();
    const calls: Array<{
      file: string;
      args: readonly string[];
      options: { shell?: boolean };
    }> = [];
    const recordingSpawn = ((
      file: string,
      args: readonly string[],
      options: { shell?: boolean },
    ) => {
      calls.push({ file, args, options });
      return spawn(file, args, options);
    }) as typeof spawn;
    const store = new KeychainStore({
      helperPath: helper.executablePath,
      service: "com.example.bridge",
      spawn: recordingSpawn,
    });

    await store.delete("bot-primary");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      file: helper.executablePath,
      args: ["delete", "com.example.bridge", "bot-primary"],
      options: { shell: false },
    });
  });

  it.each([
    ["empty account", ""],
    ["control character in account", "bot\nprimary"],
    ["NUL in account", "bot\0primary"],
  ])("rejects %s before spawning", async (_label, account) => {
    const helper = await makeFakeHelper();
    let spawnCalls = 0;
    const forbiddenSpawn = (() => {
      spawnCalls += 1;
      throw new Error("spawn must not be called");
    }) as unknown as typeof spawn;
    const store = new KeychainStore({
      helperPath: helper.executablePath,
      service: "com.example.bridge",
      spawn: forbiddenSpawn,
    });

    await expectBridgeError(store.get(account), "INVALID_ARGUMENT");
    expect(spawnCalls).toBe(0);
  });

  it.each([
    ["empty service", ""],
    ["control character in service", "com.example\nbridge"],
    ["relative helper path", "relative/keychain-helper"],
  ])("rejects invalid constructor configuration: %s", (label, value) => {
    const options =
      label === "relative helper path"
        ? { helperPath: value, service: "com.example.bridge" }
        : { helperPath: "/tmp/keychain-helper", service: value };

    expectSynchronousBridgeError(() => new KeychainStore(options), "CONFIGURATION");
  });

  it("rejects a non-object constructor configuration", () => {
    expectSynchronousBridgeError(
      () => new KeychainStore(null as unknown as ConstructorParameters<typeof KeychainStore>[0]),
      "CONFIGURATION",
    );
  });

  it.each([
    ["empty token", ""],
    ["oversized token", "x".repeat(MAX_KEYCHAIN_TOKEN_BYTES + 1)],
  ])("rejects an %s before spawning", async (_label, token) => {
    const helper = await makeFakeHelper();
    let spawnCalls = 0;
    const forbiddenSpawn = (() => {
      spawnCalls += 1;
      throw new Error("spawn must not be called");
    }) as unknown as typeof spawn;
    const store = new KeychainStore({
      helperPath: helper.executablePath,
      service: "com.example.bridge",
      spawn: forbiddenSpawn,
    });

    await expectBridgeError(store.set("bot-primary", token), "INVALID_ARGUMENT");
    expect(spawnCalls).toBe(0);
  });

  it.each([
    ["stdout", { stdout: "x".repeat(65) }, { maxStdoutBytes: 64 }],
    ["stderr", { stderr: "x".repeat(65) }, { maxStderrBytes: 64 }],
  ] as const)("caps helper %s and kills the child", async (_stream, control, limits) => {
    const helper = await makeFakeHelper(control);
    let child: ReturnType<typeof spawn> | undefined;
    const recordingSpawn = ((...args: Parameters<typeof spawn>) => {
      child = spawn(...args);
      return child;
    }) as typeof spawn;
    const store = new KeychainStore({
      helperPath: helper.executablePath,
      service: "com.example.bridge",
      spawn: recordingSpawn,
      ...limits,
    });

    await expectBridgeError(store.get("bot-primary"), "CONFIGURATION");
    expect(child?.killed).toBe(true);
  });

  it("enforces a bounded timeout and kills the helper", async () => {
    const helper = await makeFakeHelper({ mode: "hang" });
    let child: ReturnType<typeof spawn> | undefined;
    const recordingSpawn = ((...args: Parameters<typeof spawn>) => {
      child = spawn(...args);
      return child;
    }) as typeof spawn;
    const store = new KeychainStore({
      helperPath: helper.executablePath,
      service: "com.example.bridge",
      spawn: recordingSpawn,
      timeoutMs: 50,
    });

    await expectBridgeError(store.get("bot-primary"), "TIMEOUT");
    expect(child?.killed).toBe(true);
  });

  it("settles after kill grace when a timed-out child never closes", async () => {
    const token = "timeout-token-marker";
    const fake = makeNonClosingFakeChild();
    fake.kill.mockImplementation(() => {
      queueMicrotask(() => fake.child.emit("error", new Error("late kill error")));
      return true;
    });
    const store = new KeychainStore({
      helperPath: "/tmp/fake-keychain-helper",
      service: "com.example.bridge",
      spawn: (() => fake.child) as KeychainSpawn,
      timeoutMs: 10,
      killGraceMs: 20,
    });

    const error = await expectBridgeErrorWithin(store.set("bot-primary", token), "TIMEOUT", 250);

    expect(fake.kill).toHaveBeenCalledWith("SIGKILL");
    expect(fake.unref).toHaveBeenCalledOnce();
    expect([fake.stdin.destroyed, fake.stdout.destroyed, fake.stderr.destroyed]).toEqual([
      true,
      true,
      true,
    ]);
    expect(serializedError(error).includes(token)).toBe(false);
    expect(() => fake.child.emit("error", new Error("late fake child error"))).not.toThrow();
    expect(() => fake.child.emit("close", null, "SIGKILL")).not.toThrow();
  });

  it.each(["stdout", "stderr"] as const)(
    "settles after kill grace when %s overflows and the child never closes",
    async (streamName) => {
      const token = `${streamName}-overflow-token-marker`;
      const fake = makeNonClosingFakeChild();
      const store = new KeychainStore({
        helperPath: "/tmp/fake-keychain-helper",
        service: "com.example.bridge",
        spawn: (() => fake.child) as KeychainSpawn,
        timeoutMs: 1_000,
        killGraceMs: 20,
        maxStdoutBytes: 64,
        maxStderrBytes: 64,
      });
      const operation = store.set("bot-primary", token);

      fake[streamName].write(Buffer.alloc(65, 0x78));
      const error = await expectBridgeErrorWithin(operation, "CONFIGURATION", 250);

      expect(fake.kill).toHaveBeenCalledWith("SIGKILL");
      expect(fake.unref).toHaveBeenCalledOnce();
      expect([fake.stdin.destroyed, fake.stdout.destroyed, fake.stderr.destroyed]).toEqual([
        true,
        true,
        true,
      ]);
      expect(serializedError(error).includes(token)).toBe(false);
      expect(() => fake.child.emit("error", new Error("late fake child error"))).not.toThrow();
      expect(() => fake.child.emit("close", null, "SIGKILL")).not.toThrow();
    },
  );

  it.each(["get", "delete"] as const)("maps missing %s to NOT_FOUND", async (operation) => {
    const helper = await makeFakeHelper({ exitCode: KEYCHAIN_NOT_FOUND_EXIT_CODE });
    const store = new KeychainStore({
      helperPath: helper.executablePath,
      service: "com.example.bridge",
    });

    await expectBridgeError(store[operation]("missing-bot"), "NOT_FOUND");
  });

  it("maps a missing helper executable to CONFIGURATION", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-discord-keychain-missing-"));
    temporaryDirectories.push(directory);
    const store = new KeychainStore({
      helperPath: join(directory, "missing-helper"),
      service: "com.example.bridge",
    });

    const error = await expectBridgeError(store.get("bot-primary"), "CONFIGURATION");

    expect(error.remediation).toContain("native:build");
  });

  it("redacts helper stderr, causes, argv, and diagnostics on failure", async () => {
    const token = "unique-sensitive-token-marker";
    const helper = await makeFakeHelper({
      exitCode: 70,
      stderr: `helper unexpectedly echoed ${token}`,
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = new KeychainStore({
      helperPath: helper.executablePath,
      service: "com.example.bridge",
    });

    const error = await expectBridgeError(store.set("bot-primary", token), "CONFIGURATION");
    const capture = await readCapture(helper);

    expect(serializedError(error).includes(token)).toBe(false);
    expect(error.cause).toBeUndefined();
    expect(capture.argv.some((argument) => argument.includes(token))).toBe(false);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("reports signal termination distinctly without exposing diagnostics", async () => {
    const helper = await makeFakeHelper({ mode: "signal" });
    const store = new KeychainStore({
      helperPath: helper.executablePath,
      service: "com.example.bridge",
    });

    const error = await expectBridgeError(store.get("bot-primary"), "CONFIGURATION");

    expect(error.message).toContain("signal");
    expect(error.cause).toBeUndefined();
  });

  it.each([
    ["duplicate accounts", ["bot-primary", "bot-primary"]],
    ["unsorted accounts", ["bot-secondary", "bot-primary"]],
    ["invalid account", ["bot-primary", "secret\nvalue"]],
  ])("rejects malformed list output with %s", async (_label, accounts) => {
    const helper = await makeFakeHelper({ accounts });
    const store = new KeychainStore({
      helperPath: helper.executablePath,
      service: "com.example.bridge",
    });

    await expectBridgeError(store.listAccounts(), "CONFIGURATION");
  });

  it("rejects secret-bearing fields outside the list account array", async () => {
    const token = "secret-shaped-list-output";
    const helper = await makeFakeHelper({
      stdout: JSON.stringify({ accounts: ["bot-primary"], secret: token }),
    });
    const store = new KeychainStore({
      helperPath: helper.executablePath,
      service: "com.example.bridge",
    });

    const error = await expectBridgeError(store.listAccounts(), "CONFIGURATION");

    expect(serializedError(error).includes(token)).toBe(false);
  });

  it.each([
    ["empty get output", { getValueBase64: "" }],
    ["extra stdout from delete", { stdout: "unexpected" }],
    ["stderr on success", { stderr: "unexpected diagnostics" }],
  ] as const)("rejects invalid helper output: %s", async (label, control) => {
    const helper = await makeFakeHelper(control);
    const store = new KeychainStore({
      helperPath: helper.executablePath,
      service: "com.example.bridge",
    });
    const operation =
      label === "extra stdout from delete" ? store.delete("bot-primary") : store.get("bot-primary");

    await expectBridgeError(operation, "CONFIGURATION");
  });
});
