import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppServerClient } from "../../src/app-server/client.js";
import { CodexAppServerProcess } from "../../src/app-server/process.js";
import {
  currentApprovalResponse,
  dynamicToolResponse,
  legacyApprovalResponse,
  legacyDeniedResponse,
  permissionGrantResponse,
} from "../../src/app-server/protocol.js";
import { BridgeError } from "../../src/domain/errors.js";
import { FakeAppServer } from "../fixtures/fake-app-server.js";

const clients: AppServerClient[] = [];
const servers: FakeAppServer[] = [];
const processes: CodexAppServerProcess[] = [];

function createClient(options: Partial<ConstructorParameters<typeof AppServerClient>[0]> = {}): {
  client: AppServerClient;
  server: FakeAppServer;
} {
  const server = new FakeAppServer();
  const client = new AppServerClient({
    input: server.clientStdout,
    output: server.clientStdin,
    defaultRequestTimeoutMs: 250,
    ...options,
  });
  clients.push(client);
  servers.push(server);
  return { client, server };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(async () => {
  vi.useRealTimers();
  for (const client of clients.splice(0)) {
    client.close();
  }
  for (const server of servers.splice(0)) {
    server.close();
  }
  await Promise.all(processes.splice(0).map((process) => process.stop().catch(() => undefined)));
});

describe("AppServerClient", () => {
  it("initializes before sending initialized and never adds jsonrpc", async () => {
    const { client, server } = createClient();
    const initialization = client.initialize("1.2.3");
    const request = await server.waitForMessage((message) => message.method === "initialize");

    expect(request).toEqual({
      method: "initialize",
      id: 1,
      params: {
        clientInfo: {
          name: "codex-discord-bridge",
          title: "Codex Discord Bridge",
          version: "1.2.3",
        },
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
    });
    expect(server.messages).toHaveLength(1);

    server.send({
      id: request.id,
      result: {
        codexHome: "/tmp/codex",
        platformFamily: "unix",
        platformOs: "macos",
        userAgent: "codex-cli/0.145.0",
      },
    });
    await initialization;

    await expect(
      server.waitForMessage((message) => message.method === "initialized"),
    ).resolves.toEqual({ method: "initialized" });
    expect(server.messages.every((message) => !("jsonrpc" in message))).toBe(true);
  });

  it("correlates concurrent requests completed out of order", async () => {
    const { client, server } = createClient();
    const first = client.request("thread/read", { threadId: "thread-a" });
    const second = client.request("thread/read", { threadId: "thread-b" });
    const firstWire = await server.waitForMessage((message) => message.id === 1);
    const secondWire = await server.waitForMessage((message) => message.id === 2);

    server.send({ id: secondWire.id, result: { thread: { id: "thread-b" } } });
    server.send({ id: firstWire.id, result: { thread: { id: "thread-a" } } });

    await expect(first).resolves.toMatchObject({ thread: { id: "thread-a" } });
    await expect(second).resolves.toMatchObject({ thread: { id: "thread-b" } });
    expect(client.pendingRequestCount).toBe(0);
  });

  it("forwards known notifications and safely logs unknown methods", async () => {
    const debug = vi.fn();
    const { client, server } = createClient({ debugLogger: debug });
    const listener = vi.fn();
    client.onNotification("item/agentMessage/delta", listener);

    server.send({
      method: "item/agentMessage/delta",
      params: { delta: "hello", itemId: "i", threadId: "t", turnId: "u" },
    });
    server.send({ method: "future/notification", params: { secret: "do-not-log" } });
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(debug).toHaveBeenCalledOnce());

    expect(listener).toHaveBeenCalledWith({
      delta: "hello",
      itemId: "i",
      threadId: "t",
      turnId: "u",
    });
    expect(JSON.stringify(debug.mock.calls)).toContain("future/notification");
    expect(JSON.stringify(debug.mock.calls)).not.toContain("do-not-log");
  });

  it("keeps server requests pending without blocking later messages", async () => {
    const { client, server } = createClient();
    const approval = deferred<"accept">();
    const delta = vi.fn();
    client.handleApprovalRequest("item/commandExecution/requestApproval", () => approval.promise);
    client.onNotification("item/agentMessage/delta", delta);

    server.send({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: {
        availableDecisions: ["accept"],
        itemId: "i",
        startedAtMs: 1,
        threadId: "t",
        turnId: "u",
      },
    });
    server.send({
      method: "item/agentMessage/delta",
      params: { delta: "still moving", itemId: "i", threadId: "t", turnId: "u" },
    });
    await vi.waitFor(() => expect(delta).toHaveBeenCalledOnce());
    expect(server.messages).toHaveLength(0);

    approval.resolve("accept");
    await expect(server.waitForMessage((message) => message.id === "approval-1")).resolves.toEqual(
      currentApprovalResponse("approval-1", "accept"),
    );
  });

  it("rejects approval registration through the generic handler API", () => {
    const { client } = createClient();
    expect(() =>
      (client.handleRequest as (method: string, handler: () => unknown) => () => void)(
        "item/commandExecution/requestApproval",
        () => ({ decision: "acceptForSession" }),
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });

  it("answers unknown server requests with method-not-supported", async () => {
    const { server } = createClient();
    server.send({ id: 9, method: "future/request", params: {} });

    await expect(server.waitForMessage((message) => message.id === 9)).resolves.toEqual({
      id: 9,
      error: { code: -32601, message: "Method not supported" },
    });
  });

  it("answers an unknown request without params and continues processing", async () => {
    const { client, server } = createClient();
    const delta = vi.fn();
    client.onNotification("item/agentMessage/delta", delta);
    const pending = client.request("thread/read", { threadId: "thread-a" });
    await server.waitForMessage((message) => message.id === 1);

    server.send({ id: "future-1", method: "future/request" });
    await expect(server.waitForMessage((message) => message.id === "future-1")).resolves.toEqual({
      id: "future-1",
      error: { code: -32601, message: "Method not supported" },
    });

    server.send({
      method: "item/agentMessage/delta",
      params: { delta: "after", itemId: "i", threadId: "t", turnId: "u" },
    });
    server.send({ id: 1, result: { thread: { id: "thread-a" } } });
    await expect(pending).resolves.toMatchObject({ thread: { id: "thread-a" } });
    await vi.waitFor(() => expect(delta).toHaveBeenCalledOnce());
    expect(client.closed).toBe(false);
  });

  it("fails closed when a known server request omits params", async () => {
    const { client, server } = createClient();
    server.send({ id: 10, method: "item/tool/call" });

    await vi.waitFor(() => expect(client.closed).toBe(true));
    expect(server.messages).toHaveLength(0);
  });

  it.each([
    ["maxLineBytes", Number.NaN],
    ["maxLineBytes", Number.POSITIVE_INFINITY],
    ["maxLineBytes", 0],
    ["maxLineBytes", -1],
    ["maxLineBytes", 1.5],
    ["maxLineBytes", Number.MAX_SAFE_INTEGER],
    ["defaultRequestTimeoutMs", Number.NaN],
    ["defaultRequestTimeoutMs", Number.POSITIVE_INFINITY],
    ["defaultRequestTimeoutMs", 0],
    ["defaultRequestTimeoutMs", -1],
    ["defaultRequestTimeoutMs", 1.5],
    ["defaultRequestTimeoutMs", Number.MAX_SAFE_INTEGER],
    ["writeStallTimeoutMs", 0],
    ["writeStallTimeoutMs", Number.MAX_SAFE_INTEGER],
    ["initialRequestId", Number.NaN],
    ["initialRequestId", Number.POSITIVE_INFINITY],
    ["initialRequestId", 0],
    ["initialRequestId", -1],
    ["initialRequestId", 1.5],
    ["maxQueuedWrites", Number.NaN],
    ["maxQueuedWrites", Number.POSITIVE_INFINITY],
    ["maxQueuedWrites", 0],
    ["maxQueuedWrites", -1],
    ["maxQueuedWrites", 1.5],
    ["maxQueuedWrites", Number.MAX_SAFE_INTEGER],
    ["maxPendingRequests", Number.NaN],
    ["maxPendingRequests", Number.POSITIVE_INFINITY],
    ["maxPendingRequests", 0],
    ["maxPendingRequests", -1],
    ["maxPendingRequests", 1.5],
    ["maxPendingRequests", Number.MAX_SAFE_INTEGER],
    ["maxMessageBytes", Number.NaN],
    ["maxMessageBytes", Number.POSITIVE_INFINITY],
    ["maxMessageBytes", 0],
    ["maxMessageBytes", -1],
    ["maxMessageBytes", 1.5],
    ["maxMessageBytes", Number.MAX_SAFE_INTEGER],
    ["maxQueuedWriteBytes", Number.NaN],
    ["maxQueuedWriteBytes", Number.POSITIVE_INFINITY],
    ["maxQueuedWriteBytes", 0],
    ["maxQueuedWriteBytes", -1],
    ["maxQueuedWriteBytes", 1.5],
    ["maxQueuedWriteBytes", Number.MAX_SAFE_INTEGER],
    ["maxRetiredRequestIds", Number.NaN],
    ["maxRetiredRequestIds", Number.POSITIVE_INFINITY],
    ["maxRetiredRequestIds", 0],
    ["maxRetiredRequestIds", -1],
    ["maxRetiredRequestIds", 1.5],
    ["maxRetiredRequestIds", Number.MAX_SAFE_INTEGER],
    ["maxActiveServerRequests", Number.NaN],
    ["maxActiveServerRequests", Number.POSITIVE_INFINITY],
    ["maxActiveServerRequests", 0],
    ["maxActiveServerRequests", -1],
    ["maxActiveServerRequests", 1.5],
    ["maxActiveServerRequests", Number.MAX_SAFE_INTEGER],
  ])("rejects invalid client option %s=%s before wiring streams", (key, value) => {
    const input = new PassThrough();
    const output = new PassThrough();

    expect(
      () =>
        new AppServerClient({
          input,
          output,
          [key]: value,
        }),
    ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("error")).toBe(0);
    expect(output.listenerCount("error")).toBe(0);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5, Number.MAX_SAFE_INTEGER])(
    "rejects invalid per-request timeout %s without consuming an ID",
    async (timeoutMs) => {
      const { client, server } = createClient();
      await expect(
        client.request("thread/read", { threadId: "invalid" }, { timeoutMs }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

      const valid = client.request("thread/read", { threadId: "valid" });
      void valid.catch(() => undefined);
      await expect(server.waitForMessage((message) => message.id === 1)).resolves.toMatchObject({
        id: 1,
      });
    },
  );

  it("writes exact current, legacy, permission, and dynamic-tool response envelopes", async () => {
    const { client, server } = createClient();
    client.handleApprovalRequest("item/fileChange/requestApproval", () => "decline");
    client.handleApprovalRequest("execCommandApproval", () => "accept");
    client.handleApprovalRequest("applyPatchApproval", () => "decline");
    client.handleApprovalRequest("item/permissions/requestApproval", () => "accept");
    client.handleRequest("item/tool/call", async () => ({
      success: true,
      contentItems: [{ type: "inputText", text: "done" }],
    }));

    server.send({
      id: 1,
      method: "item/fileChange/requestApproval",
      params: { itemId: "i", startedAtMs: 1, threadId: "t", turnId: "u" },
    });
    server.send({
      id: 2,
      method: "execCommandApproval",
      params: { callId: "c", command: ["pwd"], conversationId: "t", cwd: "/tmp", parsedCmd: [] },
    });
    server.send({
      id: 3,
      method: "applyPatchApproval",
      params: { callId: "c", conversationId: "t", fileChanges: {} },
    });
    server.send({
      id: 4,
      method: "item/permissions/requestApproval",
      params: {
        cwd: "/tmp",
        itemId: "i",
        permissions: { network: { enabled: true } },
        startedAtMs: 1,
        threadId: "t",
        turnId: "u",
      },
    });
    server.send({
      id: 5,
      method: "item/tool/call",
      params: { arguments: { q: 1 }, callId: "c", threadId: "t", tool: "lookup", turnId: "u" },
    });

    await expect(server.waitForMessage((message) => message.id === 1)).resolves.toEqual(
      currentApprovalResponse(1, "decline"),
    );
    await expect(server.waitForMessage((message) => message.id === 2)).resolves.toEqual(
      legacyApprovalResponse(2, "approved"),
    );
    await expect(server.waitForMessage((message) => message.id === 3)).resolves.toEqual(
      legacyDeniedResponse(3, "Denied in Discord"),
    );
    await expect(server.waitForMessage((message) => message.id === 4)).resolves.toEqual(
      permissionGrantResponse(4, { network: { enabled: true } }),
    );
    await expect(server.waitForMessage((message) => message.id === 5)).resolves.toEqual(
      dynamicToolResponse(5, true, [{ type: "inputText", text: "done" }]),
    );
  });

  it("constructs approval responses from parsed requests and one-shot actions", async () => {
    const { client, server } = createClient();
    client.handleApprovalRequest("item/commandExecution/requestApproval", (request) =>
      request.itemId === "malicious" ? ("acceptForSession" as never) : "accept",
    );
    client.handleApprovalRequest("item/fileChange/requestApproval", () => "accept");
    client.handleApprovalRequest("applyPatchApproval", () => "accept");

    const commandBase = { startedAtMs: 1, threadId: "t", turnId: "u" };
    server.send({
      id: 20,
      method: "item/commandExecution/requestApproval",
      params: { ...commandBase, availableDecisions: ["accept"], itemId: "plain" },
    });
    server.send({
      id: 21,
      method: "item/commandExecution/requestApproval",
      params: { ...commandBase, itemId: "missing-decision" },
    });
    server.send({
      id: 22,
      method: "item/commandExecution/requestApproval",
      params: {
        ...commandBase,
        additionalPermissions: { network: { enabled: true } },
        availableDecisions: ["accept"],
        itemId: "privileged",
      },
    });
    server.send({
      id: 23,
      method: "item/commandExecution/requestApproval",
      params: { ...commandBase, availableDecisions: ["accept"], itemId: "malicious" },
    });
    server.send({
      id: 24,
      method: "item/fileChange/requestApproval",
      params: { grantRoot: "/repo", itemId: "file", ...commandBase },
    });
    server.send({
      id: 25,
      method: "applyPatchApproval",
      params: { callId: "call", conversationId: "t", fileChanges: {}, grantRoot: "/repo" },
    });

    await expect(server.waitForMessage((message) => message.id === 20)).resolves.toEqual(
      currentApprovalResponse(20, "accept"),
    );
    for (const id of [21, 22, 23]) {
      await expect(server.waitForMessage((message) => message.id === id)).resolves.toEqual(
        currentApprovalResponse(id, "decline"),
      );
    }
    await expect(server.waitForMessage((message) => message.id === 24)).resolves.toEqual(
      currentApprovalResponse(24, "decline"),
    );
    await expect(server.waitForMessage((message) => message.id === 25)).resolves.toEqual(
      legacyDeniedResponse(25),
    );
  });

  it("does not allow approval handlers to inject broader permission grants", async () => {
    const { client, server } = createClient();
    client.handleApprovalRequest("item/permissions/requestApproval", (async () => ({
      permissions: { network: { enabled: true } },
      scope: "session",
    })) as never);
    server.send({
      id: 26,
      method: "item/permissions/requestApproval",
      params: {
        cwd: "/tmp",
        itemId: "i",
        permissions: { network: { enabled: false } },
        startedAtMs: 1,
        threadId: "t",
        turnId: "u",
      },
    });

    await expect(server.waitForMessage((message) => message.id === 26)).resolves.toEqual({
      id: 26,
      error: { code: -32_000, message: "Permission request declined" },
    });
  });

  it("returns a safe error when a server request handler rejects", async () => {
    const { client, server } = createClient();
    client.handleRequest("item/tool/call", async () => {
      throw new Error("secret prompt content");
    });
    server.send({
      id: 7,
      method: "item/tool/call",
      params: { arguments: {}, callId: "c", threadId: "t", tool: "lookup", turnId: "u" },
    });

    const response = await server.waitForMessage((message) => message.id === 7);
    expect(response).toEqual({ id: 7, error: { code: -32603, message: "Request failed" } });
    expect(JSON.stringify(response)).not.toContain("secret prompt content");
  });

  it("rejects pending requests on stdout EOF", async () => {
    const { client, server } = createClient();
    const pending = client.request("thread/read", { threadId: "thread-a" });
    await server.waitForMessage((message) => message.id === 1);
    server.endStdout();

    await expect(pending).rejects.toMatchObject({ code: "RUNTIME" });
    expect(client.closed).toBe(true);
    await expect(client.request("thread/read", { threadId: "thread-b" })).rejects.toBeInstanceOf(
      BridgeError,
    );
  });

  it.each([
    ["malformed JSON", "not-json\n"],
    ["malformed envelope", '{"wat":true}\n'],
    ["response with result and error", '{"id":1,"result":{},"error":{"code":1,"message":"x"}}\n'],
  ])("fails closed on %s", async (_label, line) => {
    const { client, server } = createClient();
    server.sendRaw(line);
    await vi.waitFor(() => expect(client.closed).toBe(true));
  });

  it("fails closed on invalid UTF-8", async () => {
    const { client, server } = createClient();
    server.sendRaw(Buffer.from([0xc3, 0x28, 0x0a]));
    await vi.waitFor(() => expect(client.closed).toBe(true));
  });

  it.each([
    "turn/started",
    "item/agentMessage/delta",
    "error",
    "turn/plan/updated",
    "turn/diff/updated",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/commandExecution/outputDelta",
    "warning",
  ])(
    "drops malformed optional %s telemetry and keeps authoritative completion usable",
    async (method) => {
      const debug = vi.fn();
      const { client, server } = createClient({ debugLogger: debug });
      const itemCompleted = vi.fn();
      const turnCompleted = vi.fn();
      client.onNotification("item/completed", itemCompleted);
      client.onNotification("turn/completed", turnCompleted);

      server.send({ method, params: { secret: "must-not-be-logged" } });
      server.send({
        method: "item/completed",
        params: {
          completedAtMs: 1,
          item: { id: "item-1", text: "final", type: "agentMessage" },
          threadId: "thread-1",
          turnId: "turn-1",
        },
      });
      server.send({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", items: [], status: "completed" },
        },
      });

      await vi.waitFor(() => expect(itemCompleted).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(turnCompleted).toHaveBeenCalledOnce());
      await vi.waitFor(() =>
        expect(debug).toHaveBeenCalledWith({
          direction: "inbound",
          kind: "invalid-progress-notification",
          method,
        }),
      );
      expect(client.closed).toBe(false);
      expect(JSON.stringify(debug.mock.calls)).not.toContain("must-not-be-logged");
    },
  );

  it.each(["item/started", "item/completed", "turn/completed"])(
    "fails closed on malformed required %s parameters",
    async (method) => {
      const { client, server } = createClient();
      server.send({ method, params: { secret: "must-not-be-logged" } });
      await vi.waitFor(() => expect(client.closed).toBe(true));
    },
  );

  it.each([
    ["terminated", `${"x".repeat(40)}\n`],
    ["unterminated", "x".repeat(40)],
  ])("bounds %s oversized lines", async (_label, data) => {
    const { client, server } = createClient({ maxLineBytes: 16 });
    server.sendRaw(data);
    await vi.waitFor(() => expect(client.closed).toBe(true));
  });

  it("ignores one late timed-out response while another request succeeds", async () => {
    const debug = vi.fn();
    const { client, server } = createClient({ defaultRequestTimeoutMs: 10, debugLogger: debug });
    const request = client.request("thread/read", { threadId: "thread-a" });
    await server.waitForMessage((message) => message.id === 1);
    await expect(request).rejects.toMatchObject({
      code: "TIMEOUT",
      delivery: "sent-unconfirmed",
    });
    expect(client.pendingRequestCount).toBe(0);

    const other = client.request("thread/read", { threadId: "thread-b" }, { timeoutMs: 100 });
    await server.waitForMessage((message) => message.id === 2);
    server.send({ id: 1, result: { thread: { id: "thread-a" } } });
    server.send({ id: 2, result: { thread: { id: "thread-b" } } });
    await expect(other).resolves.toMatchObject({ thread: { id: "thread-b" } });
    expect(client.closed).toBe(false);
    expect(debug).toHaveBeenCalledWith({
      direction: "inbound",
      idType: "number",
      kind: "late-response",
    });
  });

  it("ignores one late aborted response and removes AbortSignal listeners", async () => {
    const debug = vi.fn();
    const { client, server } = createClient({ debugLogger: debug });
    const controller = new AbortController();
    const request = client.request(
      "thread/read",
      { threadId: "thread-a" },
      { signal: controller.signal },
    );
    await server.waitForMessage((message) => message.id === 1);
    controller.abort();

    await expect(request).rejects.toMatchObject({ code: "RUNTIME" });
    expect(client.pendingRequestCount).toBe(0);
    const other = client.request("thread/read", { threadId: "thread-b" });
    await server.waitForMessage((message) => message.id === 2);
    server.send({ id: 1, result: { thread: { id: "thread-a" } } });
    server.send({ id: 2, result: { thread: { id: "thread-b" } } });
    await expect(other).resolves.toMatchObject({ thread: { id: "thread-b" } });
    expect(client.closed).toBe(false);
    expect(debug).toHaveBeenCalledWith({
      direction: "inbound",
      idType: "number",
      kind: "late-response",
    });
  });

  it("treats a duplicate late response as a protocol error", async () => {
    const { client, server } = createClient({ defaultRequestTimeoutMs: 10 });
    const request = client.request("thread/read", { threadId: "thread-a" });
    await server.waitForMessage((message) => message.id === 1);
    await expect(request).rejects.toMatchObject({ code: "TIMEOUT" });
    server.send({ id: 1, result: { thread: { id: "thread-a" } } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(client.closed).toBe(false);
    server.send({ id: 1, result: { thread: { id: "thread-a" } } });
    await vi.waitFor(() => expect(client.closed).toBe(true));
  });

  it("closes deterministically when the retired response ID cap is exhausted", async () => {
    const { client } = createClient({ defaultRequestTimeoutMs: 10, maxRetiredRequestIds: 1 });
    const first = client.request("thread/read", { threadId: "thread-a" });
    const second = client.request("thread/read", { threadId: "thread-b" });
    await expect(first).rejects.toBeInstanceOf(BridgeError);
    await expect(second).rejects.toBeInstanceOf(BridgeError);
    expect(client.closed).toBe(true);
    expect(client.retiredRequestCount).toBeLessThanOrEqual(1);
  });

  it("fails pending and future requests on write errors", async () => {
    const input = new PassThrough();
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("write failed"));
      },
    });
    const client = new AppServerClient({ input, output });
    clients.push(client);

    await expect(client.request("thread/read", { threadId: "thread-a" })).rejects.toMatchObject({
      code: "RUNTIME",
    });
    expect(client.closed).toBe(true);
  });

  it("classifies definite remote rejection separately from uncertain delivery", async () => {
    const { client, server } = createClient();
    const request = client.request("thread/start", { cwd: "/repo" });
    const wire = await server.waitForMessage((message) => message.method === "thread/start");

    server.send({
      id: wire.id,
      error: { code: -32_000, message: "Rejected" },
    });

    await expect(request).rejects.toMatchObject({
      code: "RUNTIME",
      delivery: "remote-rejected",
    });
  });

  it("classifies transport loss and malformed matching success after handoff as sent-unconfirmed", async () => {
    const lost = createClient();
    const lostRequest = lost.client.request("thread/start", { cwd: "/repo" });
    await lost.server.waitForMessage((message) => message.method === "thread/start");
    lost.server.endStdout();
    await expect(lostRequest).rejects.toMatchObject({
      code: "RUNTIME",
      delivery: "sent-unconfirmed",
    });

    const malformed = createClient();
    const malformedRequest = malformed.client.request("thread/start", { cwd: "/repo" });
    const wire = await malformed.server.waitForMessage(
      (message) => message.method === "thread/start",
    );
    malformed.server.send({ id: wire.id, result: { thread: { id: 1 } } });
    await expect(malformedRequest).rejects.toMatchObject({
      code: "RUNTIME",
      delivery: "sent-unconfirmed",
    });
  });

  it("fails closed when a write throws synchronously", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.write = (() => {
      throw new Error("synchronous write failure");
    }) as typeof output.write;
    const client = new AppServerClient({ input, output });
    clients.push(client);

    await expect(client.request("thread/start", { cwd: "/repo" })).rejects.toMatchObject({
      code: "RUNTIME",
      delivery: "not-sent",
    });
    expect(client.closed).toBe(true);
    await expect(client.request("thread/read", { threadId: "thread-a" })).rejects.toMatchObject({
      code: "RUNTIME",
      delivery: "not-sent",
    });
  });

  it("serializes complete lines across backpressure", async () => {
    const input = new PassThrough();
    const chunks: string[] = [];
    const output = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        setTimeout(callback, 5);
      },
    });
    const client = new AppServerClient({ input, output });
    clients.push(client);

    await Promise.all([
      client.notify("initialized"),
      client.notify("initialized"),
      client.notify("initialized"),
    ]);
    expect(chunks).toEqual([
      '{"method":"initialized"}\n',
      '{"method":"initialized"}\n',
      '{"method":"initialized"}\n',
    ]);
  });

  it("drops an aborted queued request before write and keeps later requests usable", async () => {
    const input = new PassThrough();
    const chunks: string[] = [];
    let releaseFirstWrite!: () => void;
    let firstWrite = true;
    const output = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        if (firstWrite) {
          firstWrite = false;
          releaseFirstWrite = callback;
          return;
        }
        callback();
      },
    });
    const client = new AppServerClient({
      defaultRequestTimeoutMs: 250,
      input,
      output,
    });
    clients.push(client);

    const blocker = client.notify("initialized");
    await vi.waitFor(() => expect(chunks).toHaveLength(1));
    const controller = new AbortController();
    const aborted = client.request(
      "turn/start",
      { input: [{ text: "mutate", type: "text" }], threadId: "thread-a" },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(client.queuedWriteCount).toBe(2));

    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: "RUNTIME", delivery: "not-sent" });
    expect(client.pendingRequestCount).toBe(0);
    expect(client.retiredRequestCount).toBe(0);
    expect(client.queuedWriteCount).toBe(1);

    releaseFirstWrite();
    await blocker;
    await new Promise((resolve) => setImmediate(resolve));
    expect(chunks).toEqual(['{"method":"initialized"}\n']);
    expect(client.queuedWriteCount).toBe(0);
    expect(client.queuedWriteByteCount).toBe(0);

    const later = client.request("thread/read", { threadId: "thread-b" });
    await vi.waitFor(() => expect(chunks).toHaveLength(2));
    const laterWire = JSON.parse(chunks[1] as string) as { id: number };
    expect(laterWire.id).toBe(2);
    input.write(`${JSON.stringify({ id: 2, result: { thread: { id: "thread-b" } } })}\n`);
    await expect(later).resolves.toMatchObject({ thread: { id: "thread-b" } });
  });

  it("times out a queued request from API entry without sending it", async () => {
    const input = new PassThrough();
    const chunks: string[] = [];
    let releaseFirstWrite!: () => void;
    let firstWrite = true;
    const output = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        if (firstWrite) {
          firstWrite = false;
          releaseFirstWrite = callback;
          return;
        }
        callback();
      },
    });
    const client = new AppServerClient({
      defaultRequestTimeoutMs: 10,
      input,
      output,
      writeStallTimeoutMs: 250,
    } as never);
    clients.push(client);

    const blocker = client.notify("initialized");
    await vi.waitFor(() => expect(chunks).toHaveLength(1));
    const queued = client.request("thread/read", { threadId: "thread-a" });
    const outcome = await Promise.race([
      queued.then(
        () => ({ resolved: true }) as const,
        (error: unknown) => ({ error }) as const,
      ),
      new Promise<{ pending: true }>((resolve) => setTimeout(() => resolve({ pending: true }), 30)),
    ]);

    releaseFirstWrite();
    await blocker;
    await queued.catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));

    expect(outcome).toMatchObject({ error: { code: "TIMEOUT", delivery: "not-sent" } });
    expect(chunks).toEqual(['{"method":"initialized"}\n']);
    expect(client.pendingRequestCount).toBe(0);
    expect(client.retiredRequestCount).toBe(0);
  });

  it("retires a writing request at its total deadline as sent-unconfirmed", async () => {
    const input = new PassThrough();
    const chunks: string[] = [];
    let releaseWrite!: () => void;
    const output = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        releaseWrite = callback;
      },
    });
    const client = new AppServerClient({
      defaultRequestTimeoutMs: 10,
      input,
      output,
      writeStallTimeoutMs: 250,
    } as never);
    clients.push(client);

    const request = client.request("thread/read", { threadId: "thread-a" });
    await vi.waitFor(() => expect(chunks).toHaveLength(1));
    await expect(request).rejects.toMatchObject({
      code: "TIMEOUT",
      delivery: "sent-unconfirmed",
    });
    expect(client.retiredRequestCount).toBe(1);
    expect(client.closed).toBe(false);

    releaseWrite();
    input.write(`${JSON.stringify({ id: 1, result: { thread: { id: "thread-a" } } })}\n`);
    await vi.waitFor(() => expect(client.retiredRequestCount).toBe(0));
    expect(client.closed).toBe(false);
  });

  it("closes the transport when any write makes no progress before its stall deadline", async () => {
    const input = new PassThrough();
    const output = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, _callback) {
        // Intentionally stall both callback and drain progress.
      },
    });
    const client = new AppServerClient({ input, output, writeStallTimeoutMs: 10 } as never);
    clients.push(client);

    const notification = client.notify("initialized");
    const outcome = await Promise.race([
      notification.then(
        () => ({ resolved: true }) as const,
        (error: unknown) => ({ error }) as const,
      ),
      new Promise<{ pending: true }>((resolve) => setTimeout(() => resolve({ pending: true }), 30)),
    ]);
    if ("pending" in outcome) {
      client.close();
      await notification.catch(() => undefined);
    }

    expect(outcome).toMatchObject({ error: { code: "TIMEOUT" } });
    expect(client.closed).toBe(true);
    expect(client.queuedWriteCount).toBe(0);
    expect(client.queuedWriteByteCount).toBe(0);
  });

  it("physically removes thousands of canceled heavy writes behind a stalled writer", async () => {
    const input = new PassThrough();
    const chunks: Buffer[] = [];
    const output = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, _callback) {
        chunks.push(Buffer.from(chunk));
      },
    });
    const client = new AppServerClient({
      defaultRequestTimeoutMs: 10_000,
      input,
      maxMessageBytes: 11 * 1024,
      maxQueuedWriteBytes: 11 * 1024,
      maxQueuedWrites: 2,
      output,
    });
    clients.push(client);

    const blocker = client.notify("initialized");
    void blocker.catch(() => undefined);
    await vi.waitFor(() => expect(chunks).toHaveLength(1));
    const retainedBytes = Buffer.byteLength('{"method":"initialized"}\n');

    for (let index = 0; index < 2_000; index += 1) {
      const controller = new AbortController();
      const request = client.request(
        "turn/start",
        {
          input: [{ text: `${index}:${"x".repeat(10_000)}`, type: "text" }],
          threadId: "thread-a",
        },
        { signal: controller.signal },
      );
      controller.abort();
      await expect(request).rejects.toMatchObject({ code: "RUNTIME" });

      if (index % 100 === 0) {
        expect(client.waitingWriteCount).toBe(0);
        expect(client.queuedWriteCount).toBe(1);
        expect(client.queuedWriteByteCount).toBe(retainedBytes);
        expect(client.pendingRequestCount).toBe(0);
        expect(client.retiredRequestCount).toBe(0);
        expect(client.closed).toBe(false);
      }
    }

    expect(client.waitingWriteCount).toBe(0);
    expect(client.queuedWriteCount).toBe(1);
    expect(client.queuedWriteByteCount).toBe(retainedBytes);
    expect(chunks).toHaveLength(1);
    client.close();
    await expect(blocker).rejects.toMatchObject({ code: "RUNTIME" });
    expect(client.waitingWriteCount).toBe(0);
    expect(client.queuedWriteCount).toBe(0);
    expect(client.queuedWriteByteCount).toBe(0);
  });

  it("rejects circular request params before allocating pending state or an ID", async () => {
    const { client, server } = createClient();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(
      client.request("turn/start", {
        input: [{ text: "hello", type: "text", circular }],
        threadId: "thread-a",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(client.pendingRequestCount).toBe(0);
    expect(client.closed).toBe(false);

    const valid = client.request("thread/read", { threadId: "thread-a" });
    await expect(server.waitForMessage((message) => message.id === 1)).resolves.toBeDefined();
    void valid.catch(() => undefined);
  });

  it("enforces pending request and single-message byte limits before allocation", async () => {
    const { client, server } = createClient({ maxMessageBytes: 160, maxPendingRequests: 1 });
    const first = client.request("thread/read", { threadId: "thread-a" });
    void first.catch(() => undefined);
    await server.waitForMessage((message) => message.id === 1);
    await expect(client.request("thread/read", { threadId: "thread-b" })).rejects.toMatchObject({
      code: "RUNTIME",
    });
    server.send({ id: 1, result: { thread: { id: "thread-a" } } });
    await expect(first).resolves.toMatchObject({ thread: { id: "thread-a" } });
    await expect(
      client.request("thread/read", { threadId: "x".repeat(200) }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(client.pendingRequestCount).toBe(0);
    expect(server.messages).toHaveLength(1);
  });

  it("enforces queued write bytes below the message-count cap and cleans counters", async () => {
    const input = new PassThrough();
    const output = new Writable({
      write(_chunk, _encoding, _callback) {
        // Keep the first write active to exercise queued byte accounting.
      },
    });
    const client = new AppServerClient({
      input,
      output,
      maxMessageBytes: 64,
      maxQueuedWriteBytes: 40,
      maxQueuedWrites: 10,
    });
    clients.push(client);

    const first = client.notify("initialized");
    void first.catch(() => undefined);
    const second = client.notify("initialized");
    await expect(second).rejects.toMatchObject({ code: "RUNTIME" });
    await expect(first).rejects.toMatchObject({ code: "RUNTIME" });
    expect(client.closed).toBe(true);
    expect(client.queuedWriteCount).toBe(0);
    expect(client.queuedWriteByteCount).toBe(0);
  });

  it("rejects before request ID overflow", async () => {
    const { client } = createClient({ initialRequestId: Number.MAX_SAFE_INTEGER });
    void client.request("thread/read", { threadId: "last" }).catch(() => undefined);
    await expect(client.request("thread/read", { threadId: "overflow" })).rejects.toMatchObject({
      code: "RUNTIME",
    });
  });

  it("fails closed on unknown or duplicate response and server-request IDs", async () => {
    const first = createClient();
    first.server.send({ id: 88, result: {} });
    await vi.waitFor(() => expect(first.client.closed).toBe(true));

    const second = createClient();
    const approval = deferred<{ decision: "accept" }>();
    second.client.handleApprovalRequest("item/fileChange/requestApproval", () =>
      approval.promise.then(({ decision }) => decision),
    );
    const request = {
      id: "duplicate",
      method: "item/fileChange/requestApproval",
      params: { itemId: "i", startedAtMs: 1, threadId: "t", turnId: "u" },
    };
    second.server.send(request);
    second.server.send(request);
    await vi.waitFor(() => expect(second.client.closed).toBe(true));
  });

  it("allows server request ID reuse after the prior response write settles", async () => {
    const { client, server } = createClient();
    client.handleApprovalRequest("item/fileChange/requestApproval", () => "decline");
    const request = {
      id: "reused",
      method: "item/fileChange/requestApproval",
      params: { itemId: "i", startedAtMs: 1, threadId: "t", turnId: "u" },
    };
    server.send(request);
    await server.waitForMessage((message) => message.id === "reused");
    await vi.waitFor(() => expect(client.activeServerRequestCount).toBe(0));
    server.messages.length = 0;
    server.send(request);
    await expect(server.waitForMessage((message) => message.id === "reused")).resolves.toEqual(
      currentApprovalResponse("reused", "decline"),
    );
    expect(client.closed).toBe(false);
  });

  it("handles more than 10,000 server requests without lifetime ID accumulation", async () => {
    const { client, server } = createClient();
    for (let batch = 0; batch < 101; batch += 1) {
      const lastResponse = server.waitForMessage((message) => message.id === 99);
      for (let id = 0; id < 100; id += 1) {
        server.send({ id, method: "future/request" });
      }
      await lastResponse;
      await new Promise((resolve) => setImmediate(resolve));
      expect(client.activeServerRequestCount).toBe(0);
      expect(server.messages).toHaveLength(100);
      server.messages.length = 0;
    }
    expect(client.closed).toBe(false);
    expect(client.activeServerRequestCount).toBe(0);
  });

  it("bounds unresolved known server request handlers", async () => {
    const { client, server } = createClient({ maxActiveServerRequests: 2 });
    const never = deferred<{ contentItems: []; success: true }>();
    client.handleRequest("item/tool/call", () => never.promise);
    const params = {
      arguments: {},
      callId: "call",
      threadId: "thread",
      tool: "lookup",
      turnId: "turn",
    };

    server.send({ id: 1, method: "item/tool/call", params });
    server.send({ id: 2, method: "item/tool/call", params });
    await vi.waitFor(() => expect(client.activeServerRequestCount).toBe(2));
    server.send({ id: 3, method: "item/tool/call", params });

    await vi.waitFor(() => expect(client.closed).toBe(true));
    expect(client.activeServerRequestCount).toBe(0);
    expect(client.queuedWriteCount).toBe(0);
    expect(client.queuedWriteByteCount).toBe(0);
    never.resolve({ contentItems: [], success: true });
  });

  it("applies the active server request cap to stalled unknown responses", async () => {
    const input = new PassThrough();
    const output = new Writable({
      write(_chunk, _encoding, _callback) {
        // Permanently stall the first method-not-supported response.
      },
    });
    const client = new AppServerClient({ input, maxActiveServerRequests: 1, output });
    clients.push(client);

    input.write(`${JSON.stringify({ id: "unknown-1", method: "future/request" })}\n`);
    await vi.waitFor(() => expect(client.activeServerRequestCount).toBe(1));
    expect(client.closed).toBe(false);

    input.write(`${JSON.stringify({ id: "unknown-2", method: "future/request" })}\n`);
    await vi.waitFor(() => expect(client.closed).toBe(true));
    expect(client.activeServerRequestCount).toBe(0);
    expect(client.waitingWriteCount).toBe(0);
    expect(client.queuedWriteCount).toBe(0);
    expect(client.queuedWriteByteCount).toBe(0);
  });

  it("declines unrepresentable permission grants instead of broadening access", async () => {
    const { client, server } = createClient();
    client.handleApprovalRequest("item/permissions/requestApproval", (async () => ({
      permissions: { futurePermission: true },
      scope: "turn",
    })) as never);
    server.send({
      id: 17,
      method: "item/permissions/requestApproval",
      params: {
        cwd: "/tmp",
        itemId: "i",
        permissions: { network: { enabled: true } },
        startedAtMs: 1,
        threadId: "t",
        turnId: "u",
      },
    });

    await expect(server.waitForMessage((message) => message.id === 17)).resolves.toEqual({
      id: 17,
      error: { code: -32_000, message: "Permission request declined" },
    });
  });

  it("cleans pending timers and stream listeners on close", async () => {
    vi.useFakeTimers();
    const { client, server } = createClient({ defaultRequestTimeoutMs: 10_000 });
    const pending = client.request("thread/read", { threadId: "thread-a" });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.pendingRequestCount).toBe(1);

    client.close();
    await expect(pending).rejects.toMatchObject({ code: "RUNTIME" });
    expect(client.pendingRequestCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(server.clientStdout.listenerCount("data")).toBe(0);
  });
});

class FakeChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn<(signal?: NodeJS.Signals | number) => boolean>(() => true);
  pid = 1234;
}

function processOptions(
  spawnProcess: (...args: unknown[]) => FakeChildProcess,
  overrides: Record<string, unknown> = {},
) {
  return {
    spawnProcess,
    startTimeoutMs: 20,
    startupStabilityMs: 2,
    stopGraceMs: 5,
    killWaitMs: 5,
    ...overrides,
  };
}

describe("CodexAppServerProcess", () => {
  it.each([
    ["startTimeoutMs", Number.NaN],
    ["startTimeoutMs", Number.POSITIVE_INFINITY],
    ["startTimeoutMs", 0],
    ["startTimeoutMs", -1],
    ["startTimeoutMs", 1.5],
    ["startTimeoutMs", Number.MAX_SAFE_INTEGER],
    ["startupStabilityMs", Number.NaN],
    ["startupStabilityMs", Number.POSITIVE_INFINITY],
    ["startupStabilityMs", 0],
    ["startupStabilityMs", -1],
    ["startupStabilityMs", 1.5],
    ["startupStabilityMs", Number.MAX_SAFE_INTEGER],
    ["stopGraceMs", Number.NaN],
    ["stopGraceMs", Number.POSITIVE_INFINITY],
    ["stopGraceMs", -1],
    ["stopGraceMs", 1.5],
    ["stopGraceMs", Number.MAX_SAFE_INTEGER],
    ["killWaitMs", Number.NaN],
    ["killWaitMs", Number.POSITIVE_INFINITY],
    ["killWaitMs", -1],
    ["killWaitMs", 1.5],
    ["killWaitMs", Number.MAX_SAFE_INTEGER],
    ["stderrLogLimitPerInterval", Number.NaN],
    ["stderrLogLimitPerInterval", Number.POSITIVE_INFINITY],
    ["stderrLogLimitPerInterval", -1],
    ["stderrLogLimitPerInterval", 1.5],
    ["stderrLogLimitPerInterval", Number.MAX_SAFE_INTEGER],
    ["stderrIntervalMs", Number.NaN],
    ["stderrIntervalMs", Number.POSITIVE_INFINITY],
    ["stderrIntervalMs", 0],
    ["stderrIntervalMs", -1],
    ["stderrIntervalMs", 1.5],
    ["stderrIntervalMs", Number.MAX_SAFE_INTEGER],
    ["stderrMetadataByteLimit", Number.NaN],
    ["stderrMetadataByteLimit", Number.POSITIVE_INFINITY],
    ["stderrMetadataByteLimit", 0],
    ["stderrMetadataByteLimit", -1],
    ["stderrMetadataByteLimit", 1.5],
    ["stderrMetadataByteLimit", Number.MAX_SAFE_INTEGER],
  ])("rejects invalid process option %s=%s before spawning", (key, value) => {
    const spawnProcess = vi.fn(() => new FakeChildProcess());

    expect(() => new CodexAppServerProcess(processOptions(spawnProcess, { [key]: value }))).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("spawns exact argv with an allowlisted environment and exposes stable exit", async () => {
    const child = new FakeChildProcess();
    const spawnProcess = vi.fn((..._args: unknown[]) => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    const process = new CodexAppServerProcess(
      processOptions(spawnProcess, {
        codexPath: "/usr/local/bin/codex",
        sourceEnv: {
          HOME: "/Users/test",
          PATH: "/usr/bin",
          CODEX_HOME: "/Users/test/.codex",
          TMPDIR: "/tmp",
          LANG: "en_US.UTF-8",
          TERM: "xterm-256color",
          OPENAI_API_KEY: "openai-key",
          AZURE_OPENAI_API_KEY: "azure-key",
          CODEX_CA_CERTIFICATE: "/etc/codex-ca.pem",
          SSL_CERT_FILE: "/etc/ssl/cert.pem",
          SSL_CERT_DIR: "/etc/ssl/certs",
          HTTP_PROXY: "http://proxy.example",
          HTTPS_PROXY: "https://proxy.example",
          ALL_PROXY: "socks5://proxy.example",
          NO_PROXY: "localhost",
          http_proxy: "http://lower.example",
          https_proxy: "https://lower.example",
          all_proxy: "socks5://lower.example",
          no_proxy: "127.0.0.1",
          CODEX_API_KEY: "exec-only",
          DISCORD_BOT_TOKEN: "secret",
          DATABASE_PASSWORD: "secret",
        },
      }),
    );
    processes.push(process);
    const exitPromise = process.waitForExit();
    const client = await process.start();

    expect(client).toBe(process.client);
    expect(process.state).toBe("running");
    expect(spawnProcess).toHaveBeenCalledWith(
      "/usr/local/bin/codex",
      ["app-server", "--listen", "stdio://"],
      expect.objectContaining({
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          HOME: "/Users/test",
          PATH: "/usr/bin",
          CODEX_HOME: "/Users/test/.codex",
          TMPDIR: "/tmp",
          LANG: "en_US.UTF-8",
          TERM: "xterm-256color",
          OPENAI_API_KEY: "openai-key",
          AZURE_OPENAI_API_KEY: "azure-key",
          CODEX_CA_CERTIFICATE: "/etc/codex-ca.pem",
          SSL_CERT_FILE: "/etc/ssl/cert.pem",
          SSL_CERT_DIR: "/etc/ssl/certs",
          HTTP_PROXY: "http://proxy.example",
          HTTPS_PROXY: "https://proxy.example",
          ALL_PROXY: "socks5://proxy.example",
          NO_PROXY: "localhost",
          http_proxy: "http://lower.example",
          https_proxy: "https://lower.example",
          all_proxy: "socks5://lower.example",
          no_proxy: "127.0.0.1",
        },
      }),
    );

    child.emit("exit", 2, null);
    child.emit("close", 2, null);
    const exit = await exitPromise;
    expect(exit).toEqual({ code: 2, signal: null });
    await expect(process.waitForExit()).resolves.toBe(exit);
    expect(process.state).toBe("stopped");
  });

  it("allows only explicitly named provider environment variables", async () => {
    const child = new FakeChildProcess();
    child.kill.mockImplementation((signal) => {
      queueMicrotask(() => child.emit("close", null, signal));
      return true;
    });
    const spawnProcess = vi.fn((..._args: unknown[]) => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    const process = new CodexAppServerProcess(
      processOptions(spawnProcess, {
        additionalEnvNames: ["ANTHROPIC_API_KEY", "CUSTOM_MODEL_HOST", "ANTHROPIC_API_KEY"],
        sourceEnv: {
          ANTHROPIC_API_KEY: "provider-secret",
          CUSTOM_MODEL_HOST: "https://model.example",
          UNLISTED_SECRET: "not-forwarded",
        },
      }),
    );
    processes.push(process);
    await process.start();

    const spawnOptions = spawnProcess.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
    expect(spawnOptions?.env).toEqual({
      ANTHROPIC_API_KEY: "provider-secret",
      CUSTOM_MODEL_HOST: "https://model.example",
    });
    expect(JSON.stringify(spawnOptions)).not.toContain("UNLISTED_SECRET");
    await process.stop();
  });

  it.each(["1INVALID", "BAD-NAME", "DISCORD_BOT_TOKEN", "CODEX_DISCORD_BRIDGE_TOKEN"])(
    "rejects unsafe additional environment name %s before spawning",
    (name) => {
      const spawnProcess = vi.fn(() => new FakeChildProcess());
      expect(
        () =>
          new CodexAppServerProcess(
            processOptions(spawnProcess, {
              additionalEnvNames: [name],
              sourceEnv: { [name]: "sentinel-secret-value" },
            }),
          ),
      ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
      expect(spawnProcess).not.toHaveBeenCalled();
    },
  );

  it("prevents concurrent and double starts", async () => {
    const child = new FakeChildProcess();
    const process = new CodexAppServerProcess(processOptions(() => child));
    processes.push(process);
    const starting = process.start();
    await expect(process.start()).rejects.toMatchObject({ code: "CONFLICT" });
    child.emit("spawn");
    await starting;
    await expect(process.start()).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("does not fabricate an exit when spawn throws and permits a later retry", async () => {
    const child = new FakeChildProcess();
    const spawnProcess = vi.fn(() => {
      if (spawnProcess.mock.calls.length === 1) {
        throw new Error("ENOENT");
      }
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    const process = new CodexAppServerProcess(processOptions(spawnProcess));
    processes.push(process);

    const startFailure = await process.start().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(startFailure).toMatchObject({
      code: "CONFIGURATION",
      remediation: expect.stringContaining("protocol:check"),
    });
    expect(process.state).toBe("stopped");
    expect(process.process).toBeUndefined();
    await expect(process.waitForExit()).rejects.toBe(startFailure);
    await expect(process.stop()).resolves.toBeUndefined();

    await expect(process.start()).resolves.toBe(process.client);
    child.emit("close", 0, null);
    await expect(process.waitForExit()).resolves.toEqual({ code: 0, signal: null });
  });

  it("maps spawn errors, early exits, and start timeout to configuration errors", async () => {
    const spawnErrorChild = new FakeChildProcess();
    const spawnError = new CodexAppServerProcess(
      processOptions(() => {
        queueMicrotask(() => spawnErrorChild.emit("error", new Error("ENOENT")));
        return spawnErrorChild;
      }),
    );
    processes.push(spawnError);
    await expect(spawnError.start()).rejects.toMatchObject({ code: "CONFIGURATION" });

    const earlyChild = new FakeChildProcess();
    const early = new CodexAppServerProcess(
      processOptions(() => {
        queueMicrotask(() => earlyChild.emit("close", 1, null));
        return earlyChild;
      }),
    );
    processes.push(early);
    await expect(early.start()).rejects.toMatchObject({ code: "CONFIGURATION" });

    const timeoutChild = new FakeChildProcess();
    const timeout = new CodexAppServerProcess(processOptions(() => timeoutChild));
    processes.push(timeout);
    await expect(timeout.start()).rejects.toMatchObject({ code: "CONFIGURATION" });
    expect(timeoutChild.kill).toHaveBeenCalled();
  });

  it.each([0, 1])("rejects an exit with code %s during startup stability", async (code) => {
    const child = new FakeChildProcess();
    const process = new CodexAppServerProcess(
      processOptions(
        () => {
          queueMicrotask(() => {
            child.emit("spawn");
            queueMicrotask(() => child.emit("close", code, null));
          });
          return child;
        },
        { startupStabilityMs: 5 },
      ),
    );
    processes.push(process);

    await expect(process.start()).rejects.toMatchObject({
      code: "CONFIGURATION",
      remediation: expect.stringContaining("protocol:check"),
    });
    await expect(process.waitForExit()).resolves.toEqual({ code, signal: null });
    expect(process.state).toBe("stopped");
    expect(process.client).toBeUndefined();
    expect(process.process).toBeUndefined();
  });

  it("cleans a spawned child when client construction fails and close arrives", async () => {
    const child = new FakeChildProcess();
    child.kill.mockImplementation((signal) => {
      if (signal === "SIGTERM") {
        queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      }
      return true;
    });
    const process = new CodexAppServerProcess(
      processOptions(() => child, { clientOptions: { maxLineBytes: Number.NaN } }),
    );
    processes.push(process);

    await expect(process.start()).rejects.toMatchObject({
      code: "CONFIGURATION",
      cause: expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    });
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    await expect(process.waitForExit()).resolves.toEqual({ code: null, signal: "SIGTERM" });
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(process.state).toBe("stopped");
    expect(process.client).toBeUndefined();
    expect(process.process).toBeUndefined();
    expect(child.listenerCount("close")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);
  });

  it("retains a spawned child when client construction cleanup times out", async () => {
    const child = new FakeChildProcess();
    const process = new CodexAppServerProcess(
      processOptions(() => child, { clientOptions: { maxLineBytes: Number.NaN } }),
    );
    processes.push(process);

    await expect(process.start()).rejects.toMatchObject({
      code: "CONFIGURATION",
      cause: expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    });
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(process.state).toBe("stopping");
    expect(process.process).toBe(child);
    expect(process.client).toBeUndefined();

    child.emit("close", null, "SIGKILL");
    await expect(process.waitForExit()).resolves.toEqual({ code: null, signal: "SIGKILL" });
    expect(process.state).toBe("stopped");
  });

  it("redacts and rate-bounds stderr logging", async () => {
    const child = new FakeChildProcess();
    const logger = vi.fn();
    const process = new CodexAppServerProcess(
      processOptions(
        () => {
          queueMicrotask(() => child.emit("spawn"));
          return child;
        },
        { logger, stderrLogLimitPerInterval: 1 },
      ),
    );
    processes.push(process);
    await process.start();
    child.stderr.write("prompt secret token\n");
    child.stderr.write("another secret\n");
    await vi.waitFor(() => expect(logger).toHaveBeenCalled());

    expect(JSON.stringify(logger.mock.calls)).not.toContain("prompt secret token");
    expect(JSON.stringify(logger.mock.calls)).not.toContain("another secret");
    expect(logger.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("rejects pending client requests when the child exits", async () => {
    const child = new FakeChildProcess();
    const process = new CodexAppServerProcess(
      processOptions(() => {
        queueMicrotask(() => child.emit("spawn"));
        return child;
      }),
    );
    processes.push(process);
    const client = await process.start();
    const pending = client.request("thread/read", { threadId: "thread-a" });
    child.emit("exit", 1, null);

    await expect(pending).rejects.toMatchObject({ code: "RUNTIME" });
    expect(client.closed).toBe(true);
    expect(process.process).toBe(child);
    child.emit("close", 1, null);
  });

  it("records exit provisionally and resolves waitForExit only after close", async () => {
    const child = new FakeChildProcess();
    const process = new CodexAppServerProcess(
      processOptions(() => {
        queueMicrotask(() => child.emit("spawn"));
        return child;
      }),
    );
    processes.push(process);
    await process.start();
    const settled = vi.fn();
    void process.waitForExit().then(settled);

    child.emit("exit", 3, null);
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).not.toHaveBeenCalled();
    expect(process.process).toBe(child);
    expect(process.state).toBe("running");

    child.emit("close", 3, null);
    await vi.waitFor(() => expect(settled).toHaveBeenCalledWith({ code: 3, signal: null }));
    expect(process.state).toBe("stopped");
  });

  it("stops gracefully with SIGTERM and is idempotent", async () => {
    const child = new FakeChildProcess();
    child.kill.mockImplementation((signal) => {
      if (signal === "SIGTERM") {
        queueMicrotask(() => {
          child.emit("exit", null, "SIGTERM");
          child.emit("close", null, "SIGTERM");
        });
      }
      return true;
    });
    const process = new CodexAppServerProcess(
      processOptions(() => {
        queueMicrotask(() => child.emit("spawn"));
        return child;
      }),
    );
    processes.push(process);
    await process.start();

    const first = process.stop();
    const second = process.stop();
    await expect(first).resolves.toEqual({ code: null, signal: "SIGTERM" });
    await expect(second).resolves.toEqual({ code: null, signal: "SIGTERM" });
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(process.state).toBe("stopped");
  });

  it("times out after SIGKILL without fabricating an exit and recovers on late close", async () => {
    const child = new FakeChildProcess();
    const replacement = new FakeChildProcess();
    replacement.kill.mockImplementation((signal) => {
      queueMicrotask(() => replacement.emit("close", null, signal));
      return true;
    });
    const children = [child, replacement];
    const process = new CodexAppServerProcess(
      processOptions(() => {
        const spawned = children.shift();
        if (spawned === undefined) {
          throw new Error("unexpected spawn");
        }
        queueMicrotask(() => spawned.emit("spawn"));
        return spawned;
      }),
    );
    processes.push(process);
    await process.start();

    await expect(process.stop()).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(process.state).toBe("stopping");
    expect(process.process).toBe(child);
    await expect(process.start()).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(process.restart()).rejects.toMatchObject({ code: "TIMEOUT" });

    child.emit("close", null, "SIGKILL");
    await expect(process.waitForExit()).resolves.toEqual({ code: null, signal: "SIGKILL" });
    expect(process.state).toBe("stopped");
    const restarted = await process.start();
    expect(restarted).toBe(process.client);
    expect(process.process).toBe(replacement);
    await process.stop();
  });

  it("cannot override child stdio through erased client options", async () => {
    const child = new FakeChildProcess();
    const rogueInput = new PassThrough();
    const rogueOutput = new PassThrough();
    child.kill.mockImplementation((signal) => {
      queueMicrotask(() => child.emit("close", null, signal));
      return true;
    });
    const process = new CodexAppServerProcess(
      processOptions(
        () => {
          queueMicrotask(() => child.emit("spawn"));
          return child;
        },
        { clientOptions: { input: rogueInput, output: rogueOutput } },
      ),
    );
    processes.push(process);
    const client = await process.start();
    const wire = deferred<Record<string, unknown>>();
    child.stdin.once("data", (chunk) => wire.resolve(JSON.parse(chunk.toString())));
    const pending = client.request("thread/read", { threadId: "thread-a" });
    const message = await wire.promise;
    expect(message).toMatchObject({ id: 1, method: "thread/read" });
    child.stdout.write(`${JSON.stringify({ id: 1, result: { thread: { id: "thread-a" } } })}\n`);
    await expect(pending).resolves.toMatchObject({ thread: { id: "thread-a" } });
    await process.stop();
  });

  it("restarts after fully cleaning the old process", async () => {
    const first = new FakeChildProcess();
    const second = new FakeChildProcess();
    first.kill.mockImplementation((signal) => {
      queueMicrotask(() => first.emit("close", null, signal));
      return true;
    });
    second.kill.mockImplementation((signal) => {
      queueMicrotask(() => second.emit("close", null, signal));
      return true;
    });
    const children = [first, second];
    const spawnProcess = vi.fn(() => {
      const child = children.shift();
      if (child === undefined) {
        throw new Error("unexpected spawn");
      }
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    const process = new CodexAppServerProcess(processOptions(spawnProcess));
    processes.push(process);
    const firstClient = await process.start();
    const secondClient = await process.restart();

    expect(secondClient).not.toBe(firstClient);
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(first.listenerCount("close")).toBe(0);
    expect(first.listenerCount("error")).toBe(0);
    expect(process.state).toBe("running");

    await process.stop();
    expect(second.kill).toHaveBeenCalledWith("SIGTERM");
    expect(process.state).toBe("stopped");
  });
});
