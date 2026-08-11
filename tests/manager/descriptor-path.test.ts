import { open, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeError } from "../../src/domain/errors.js";
import {
  DEFAULT_DESCRIPTOR_PATH_MAX_OUTPUT_BYTES,
  DEFAULT_DESCRIPTOR_PATH_TIMEOUT_MS,
  FdPathHelperDescriptorPathResolver,
} from "../../src/manager/descriptor-path.js";

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HELPER_PATH = join(PACKAGE_ROOT, "dist/native/fd-path-helper");
const temporaryFiles: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryFiles.splice(0).map(async (path) => {
      const { rm } = await import("node:fs/promises");
      await rm(path, { force: true });
    }),
  );
});

describe("FdPathHelperDescriptorPathResolver", () => {
  it("passes the retained descriptor as child fd 3 with bounded controlled execution", async () => {
    const run = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      stdout: Buffer.from("/private/tmp/result.txt"),
    }));
    const resolver = new FdPathHelperDescriptorPathResolver({
      helperPath: "/absolute/fd-path-helper",
      run,
    });

    await expect(resolver.resolve(42)).resolves.toBe("/private/tmp/result.txt");
    expect(run).toHaveBeenCalledWith("/absolute/fd-path-helper", [], {
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      maxOutputBytes: DEFAULT_DESCRIPTOR_PATH_MAX_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "ignore", 42],
      timeoutMs: DEFAULT_DESCRIPTOR_PATH_TIMEOUT_MS,
    });
  });

  it.each([
    ["nonzero exit", { exitCode: 1, signal: null, stdout: Buffer.alloc(0) }],
    ["signal exit", { exitCode: null, signal: "SIGKILL", stdout: Buffer.alloc(0) }],
    ["empty output", { exitCode: 0, signal: null, stdout: Buffer.alloc(0) }],
    ["relative path", { exitCode: 0, signal: null, stdout: Buffer.from("relative.txt") }],
    ["newline", { exitCode: 0, signal: null, stdout: Buffer.from("/tmp/result\n.txt") }],
    ["normalized traversal", { exitCode: 0, signal: null, stdout: Buffer.from("/tmp/../secret") }],
  ])("fails closed on %s", async (_label, result) => {
    const resolver = new FdPathHelperDescriptorPathResolver({
      helperPath: "/absolute/fd-path-helper",
      run: async () => result as never,
    });

    await expect(resolver.resolve(42)).rejects.toBeInstanceOf(BridgeError);
  });

  it("fails safely when helper execution times out or exceeds its output bound", async () => {
    const resolver = new FdPathHelperDescriptorPathResolver({
      helperPath: "/absolute/fd-path-helper",
      maxOutputBytes: 16,
      run: async () => {
        throw new Error("sensitive helper failure");
      },
    });

    await expect(resolver.resolve(42)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: expect.not.stringContaining("sensitive"),
    });
  });

  it("resolves a real retained descriptor through the built F_GETPATH helper", async () => {
    const file = join(tmpdir(), `codex-fd-path-${String(process.pid)}-${String(Date.now())}.txt`);
    temporaryFiles.push(file);
    await writeFile(file, "retained bytes");
    const handle = await open(file, "r");
    try {
      const resolver = new FdPathHelperDescriptorPathResolver({ helperPath: HELPER_PATH });

      await expect(resolver.resolve(handle.fd)).resolves.toBe(await realpath(file));
    } finally {
      await handle.close();
    }
  });
});
