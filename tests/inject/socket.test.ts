import { spawn } from "node:child_process";
import { lstat, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  injectSocketPath,
  sendInjectRequest,
  startInjectSocketServer,
} from "../../src/inject/socket.js";

let directory: string;
const closers: Array<() => Promise<void>> = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "inj-"));
});

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  await rm(directory, { recursive: true, force: true });
});

describe("inject socket", () => {
  it("derives a short per-instance socket path under the state root", () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";

    expect(injectSocketPath({ root: "/state" }, id)).toBe(`/state/run/${id}.sock`);
    expect(() => injectSocketPath({ root: "/state" }, "../escape")).toThrow();
  });

  it("round-trips one JSON request and response", async () => {
    const socketPath = join(directory, "run", "a.sock");
    const seen: unknown[] = [];
    const server = await startInjectSocketServer({
      socketPath,
      handle: async (request) => {
        seen.push(request);
        return { ok: true, echo: request };
      },
    });
    closers.push(() => server.close());

    const response = await sendInjectRequest(socketPath, { version: 1, text: "hi" });

    expect(seen).toEqual([{ version: 1, text: "hi" }]);
    expect(response).toEqual({ ok: true, echo: { version: 1, text: "hi" } });
  });

  it("creates the socket readable only by the owner inside a private directory", async () => {
    const socketPath = join(directory, "run", "a.sock");
    const server = await startInjectSocketServer({ socketPath, handle: async () => ({}) });
    closers.push(() => server.close());

    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, "run"))).mode & 0o777).toBe(0o700);
  });

  it("answers invalid JSON with an error instead of calling the handler", async () => {
    const socketPath = join(directory, "a.sock");
    let calls = 0;
    const server = await startInjectSocketServer({
      socketPath,
      handle: async () => {
        calls += 1;
        return {};
      },
    });
    closers.push(() => server.close());

    const response = await sendInjectRequest(socketPath, undefined, { rawLine: "{not json" });

    expect(response).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    expect(calls).toBe(0);
  });

  it("answers a handler crash with a generic error and reports it", async () => {
    const socketPath = join(directory, "a.sock");
    const errors: unknown[] = [];
    const server = await startInjectSocketServer({
      socketPath,
      handle: async () => {
        throw new Error("secret detail");
      },
      onError: (error) => errors.push(error),
    });
    closers.push(() => server.close());

    const response = await sendInjectRequest(socketPath, { version: 1 });

    expect(response).toEqual({ ok: false, code: "INTERNAL", message: "Inject request failed." });
    expect(errors).toHaveLength(1);
  });

  it("keeps the connection open while a slow request is being handled", async () => {
    const socketPath = join(directory, "a.sock");
    const server = await startInjectSocketServer({
      socketPath,
      idleTimeoutMs: 30,
      handle: async () => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        return { ok: true };
      },
    });
    closers.push(() => server.close());

    expect(await sendInjectRequest(socketPath, {})).toEqual({ ok: true });
  });

  it("drops a client that connects but never sends a request", async () => {
    const socketPath = join(directory, "a.sock");
    const server = await startInjectSocketServer({
      socketPath,
      idleTimeoutMs: 30,
      handle: async () => ({}),
    });
    closers.push(() => server.close());

    const closed = await new Promise<boolean>((resolve) => {
      const socket = connect(socketPath);
      socket.on("error", () => undefined);
      socket.once("close", () => resolve(true));
      setTimeout(() => resolve(false), 1_000);
    });

    expect(closed).toBe(true);
  });

  it("reports a client-side timeout as possibly delivered", async () => {
    const socketPath = join(directory, "a.sock");
    const server = await startInjectSocketServer({
      socketPath,
      handle: () => new Promise(() => undefined),
    });
    closers.push(() => server.close());

    await expect(sendInjectRequest(socketPath, {}, { timeoutMs: 30 })).rejects.toMatchObject({
      code: "TIMEOUT",
      remediation: expect.stringContaining("may"),
    });
  });

  it("replaces a stale socket file left by a dead process", async () => {
    const socketPath = join(directory, "a.sock");
    // A process killed with SIGKILL leaves its socket file behind.
    await new Promise<void>((resolve) => {
      const child = spawn(process.execPath, [
        "-e",
        `require("node:net").createServer().listen(${JSON.stringify(socketPath)}, () => process.kill(process.pid, "SIGKILL"))`,
      ]);
      child.on("exit", () => resolve());
    });
    expect((await lstat(socketPath)).isSocket()).toBe(true);

    const server = await startInjectSocketServer({ socketPath, handle: async () => ({ ok: 1 }) });
    closers.push(() => server.close());

    expect(await sendInjectRequest(socketPath, {})).toEqual({ ok: 1 });
  });

  it("refuses to start when another server is already listening", async () => {
    const socketPath = join(directory, "a.sock");
    const first = await startInjectSocketServer({ socketPath, handle: async () => ({}) });
    closers.push(() => first.close());

    await expect(startInjectSocketServer({ socketPath, handle: async () => ({}) })).rejects.toThrow(
      /already/,
    );
  });

  it("refuses to remove a regular file at the socket path", async () => {
    const socketPath = join(directory, "a.sock");
    await writeFile(socketPath, "keep me");

    await expect(startInjectSocketServer({ socketPath, handle: async () => ({}) })).rejects.toThrow(
      /not a socket/,
    );
  });

  it("lets a request that is being handled finish when closing", async () => {
    const socketPath = join(directory, "a.sock");
    let started!: () => void;
    const handling = new Promise<void>((resolve) => {
      started = resolve;
    });
    const server = await startInjectSocketServer({
      socketPath,
      handle: async () => {
        started();
        await new Promise((resolve) => setTimeout(resolve, 80));
        return { ok: true };
      },
    });

    const response = sendInjectRequest(socketPath, {});
    await handling;
    const closing = server.close();

    expect(await response).toEqual({ ok: true });
    await closing;
  });

  it("drops connections that have not sent a request when closing", async () => {
    const socketPath = join(directory, "a.sock");
    const server = await startInjectSocketServer({ socketPath, handle: async () => ({}) });
    const idle = connect(socketPath);
    idle.on("error", () => undefined);
    await new Promise<void>((resolve) => idle.once("connect", () => resolve()));

    const started = Date.now();
    await server.close();

    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("removes the socket file on close", async () => {
    const socketPath = join(directory, "a.sock");
    const server = await startInjectSocketServer({ socketPath, handle: async () => ({}) });

    await server.close();

    await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects socket paths too long for the platform", async () => {
    const socketPath = join(directory, `${"x".repeat(120)}.sock`);

    await expect(startInjectSocketServer({ socketPath, handle: async () => ({}) })).rejects.toThrow(
      /too long/,
    );
  });

  it("reports a clear error when no agent is listening", async () => {
    await expect(sendInjectRequest(join(directory, "missing.sock"), {})).rejects.toThrow(
      /not running/,
    );
  });
});
