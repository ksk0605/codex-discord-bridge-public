import { describe, expect, it } from "vitest";
import * as protocolChecker from "../../src/app-server/check-protocol.js";
import {
  clientRequestSchemas,
  commandApprovalResponse,
  ErrorResponseEnvelopeSchema,
  knownAgentMessagePhase,
  ModelListResponseSchema,
  permissionGrantResponse,
  SuccessResponseEnvelopeSchema,
  serverNotificationSchemas,
  serverRequestSchemas,
  ThreadListResponseSchema,
} from "../../src/app-server/protocol.js";

const commandApproval = {
  additionalPermissions: null,
  approvalId: "approval-1",
  availableDecisions: [
    "accept",
    "acceptForSession",
    "decline",
    "cancel",
    {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: ['prefix_rule(pattern=["git", "status"], decision="allow")'],
      },
    },
    {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: { action: "allow", host: "api.openai.com" },
      },
    },
  ],
  command: "git status",
  commandActions: [
    { command: "cat README.md", name: "README.md", path: "/repo/README.md", type: "read" },
    { command: "ls", path: "/repo", type: "listFiles" },
    { command: "rg token", path: "/repo", query: "token", type: "search" },
    { command: "custom", type: "unknown" },
  ],
  cwd: "/repo",
  environmentId: "local",
  itemId: "item-1",
  networkApprovalContext: null,
  proposedExecpolicyAmendment: null,
  proposedNetworkPolicyAmendments: null,
  reason: "Review command",
  startedAtMs: 1,
  threadId: "thread-1",
  turnId: "turn-1",
} as const;

describe("App Server protocol", () => {
  it("parses exact 0.145.0 Task 5 thread and turn request fields", () => {
    const dynamicTool = {
      type: "function",
      name: "discord_send_file",
      description: "Attach a file.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: { path: { type: "string" } },
      },
    } as const;
    expect(
      clientRequestSchemas["thread/start"].params.parse({
        cwd: "/repo",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        runtimeWorkspaceRoots: ["/repo", "/inbox"],
        ephemeral: false,
        dynamicTools: [dynamicTool],
      }),
    ).toMatchObject({ ephemeral: false, dynamicTools: [dynamicTool] });
    expect(
      clientRequestSchemas["thread/list"].params.parse({
        cursor: null,
        limit: 100,
        sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
      }),
    ).toBeDefined();
    expect(
      clientRequestSchemas["thread/inject_items"].params.parse({
        threadId: "thread-1",
        items: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "session initialized" }],
          },
        ],
      }),
    ).toBeDefined();
    expect(
      clientRequestSchemas["model/list"].params.parse({
        cursor: null,
        limit: 100,
        includeHidden: true,
      }),
    ).toBeDefined();
    expect(
      clientRequestSchemas["turn/start"].params.parse({
        threadId: "thread-1",
        input: [{ type: "text", text: "hello", text_elements: [] }],
        clientUserMessageId: "100",
        responsesapiClientMetadata: {
          discord_message_id: "100",
          discord_channel_id: "200",
        },
        model: "gpt-5.6-sol",
        effort: "high",
      }),
    ).toMatchObject({ model: "gpt-5.6-sol", effort: "high" });
    expect(
      ModelListResponseSchema.parse({
        data: [
          {
            id: "gpt-5.6-sol-id",
            model: "gpt-5.6-sol",
            displayName: "GPT-5.6 Sol",
            description: "Frontier agentic coding model",
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: "low",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Fast" },
              { reasoningEffort: "high", description: "Deeper" },
            ],
          },
        ],
        nextCursor: null,
      }),
    ).toBeDefined();
  });

  it("rejects malformed Task 5 dynamic tools, source kinds, and turn metadata", () => {
    expect(
      clientRequestSchemas["thread/start"].params.safeParse({
        dynamicTools: [{ type: "function", name: "file", description: "missing schema" }],
      }).success,
    ).toBe(false);
    expect(
      clientRequestSchemas["thread/list"].params.safeParse({ sourceKinds: ["future-source"] })
        .success,
    ).toBe(false);
    expect(
      clientRequestSchemas["thread/inject_items"].params.safeParse({
        threadId: "thread-1",
        items: [],
      }).success,
    ).toBe(false);
    expect(
      clientRequestSchemas["model/list"].params.safeParse({ includeHidden: "true" }).success,
    ).toBe(false);
    expect(
      ModelListResponseSchema.safeParse({
        data: [
          {
            id: "gpt-5.6-sol-id",
            model: "gpt-5.6-sol",
            displayName: "GPT-5.6 Sol",
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: "low",
            supportedReasoningEfforts: [],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      clientRequestSchemas["turn/start"].params.safeParse({
        threadId: "thread-1",
        input: [{ type: "text", text: "hello", text_elements: {} }],
        clientUserMessageId: 100,
        responsesapiClientMetadata: { discord_message_id: 100 },
      }).success,
    ).toBe(false);
    expect(
      clientRequestSchemas["turn/start"].params.safeParse({
        threadId: "thread-1",
        input: [],
        model: 42,
        effort: ["high"],
      }).success,
    ).toBe(false);
  });

  it("parses the complete 0.145.0 command approval surface", () => {
    expect(
      serverRequestSchemas["item/commandExecution/requestApproval"].params.parse(commandApproval),
    ).toEqual(commandApproval);

    expect(
      serverRequestSchemas["item/commandExecution/requestApproval"].params.parse({
        ...commandApproval,
        additionalPermissions: {
          fileSystem: {
            entries: [{ access: "write", path: { path: "/repo/out", type: "path" } }],
            globScanMaxDepth: 2,
            read: ["/repo"],
            write: ["/repo/out"],
          },
          network: { enabled: true },
        },
        networkApprovalContext: { host: "api.openai.com", protocol: "https" },
        proposedExecpolicyAmendment: ["allow git status"],
        proposedNetworkPolicyAmendments: [
          { action: "allow", host: "api.openai.com" },
          { action: "deny", host: "example.invalid" },
        ],
      }),
    ).toBeDefined();
  });

  it.each([
    ["network protocol", { networkApprovalContext: { host: "host", protocol: "ftp" } }],
    ["additional permission", { additionalPermissions: { futurePrivilege: true } }],
    ["command action", { commandActions: [{ command: "x", type: "execute" }] }],
    ["execpolicy amendment", { proposedExecpolicyAmendment: [1] }],
    ["network amendment", { proposedNetworkPolicyAmendments: [{ action: "prompt", host: "h" }] }],
    ["available decision", { availableDecisions: ["approve"] }],
  ])("rejects an unrepresentable %s", (_name, change) => {
    expect(
      serverRequestSchemas["item/commandExecution/requestApproval"].params.safeParse({
        ...commandApproval,
        ...change,
      }).success,
    ).toBe(false);
  });

  it("fails closed when MVP command approval cannot represent requested privileges", () => {
    const parsed =
      serverRequestSchemas["item/commandExecution/requestApproval"].params.parse(commandApproval);
    expect(commandApprovalResponse(1, parsed, "accept")).toEqual({
      id: 1,
      result: { decision: "accept" },
    });
    expect(
      commandApprovalResponse(2, { ...parsed, availableDecisions: ["decline"] }, "accept"),
    ).toEqual({ id: 2, result: { decision: "decline" } });
    expect(
      commandApprovalResponse(2, { ...parsed, availableDecisions: undefined }, "accept"),
    ).toEqual({ id: 2, result: { decision: "decline" } });

    for (const privilege of [
      { additionalPermissions: { network: { enabled: true } } },
      { networkApprovalContext: { host: "api.openai.com", protocol: "https" as const } },
      { proposedExecpolicyAmendment: [] },
      { proposedNetworkPolicyAmendments: [] },
    ]) {
      expect(commandApprovalResponse(3, { ...parsed, ...privilege }, "accept")).toEqual({
        id: 3,
        result: { decision: "decline" },
      });
    }
    expect(
      commandApprovalResponse(
        4,
        { ...parsed, additionalPermissions: { network: { enabled: true } } },
        "decline",
      ),
    ).toEqual({ id: 4, result: { decision: "decline" } });
    expect(
      commandApprovalResponse(5, { ...parsed, futurePrivilege: true } as never, "accept"),
    ).toEqual({ id: 5, result: { decision: "decline" } });
  });

  it("rejects unknown permission structures instead of passing them through", () => {
    const permissionParams = serverRequestSchemas["item/permissions/requestApproval"].params;
    const base = {
      cwd: "/repo",
      itemId: "item-1",
      permissions: { network: { enabled: true } },
      startedAtMs: 1,
      threadId: "thread-1",
      turnId: "turn-1",
    };
    expect(permissionParams.safeParse(base).success).toBe(true);
    expect(
      permissionParams.safeParse({ ...base, permissions: { futurePrivilege: true } }).success,
    ).toBe(false);
    expect(
      permissionParams.safeParse({
        ...base,
        permissions: { fileSystem: { entries: [{ access: "execute", path: "/repo" }] } },
      }).success,
    ).toBe(false);
    expect(permissionGrantResponse(6, { futurePrivilege: true } as never)).toEqual({
      id: 6,
      error: { code: -32_000, message: "Permission request declined" },
    });
  });

  it("matches nullable optional permission approval metadata", () => {
    const schema = serverRequestSchemas["item/permissions/requestApproval"].params;
    const required = {
      cwd: "/repo",
      itemId: "item-1",
      permissions: { network: { enabled: true } },
      startedAtMs: 1,
      threadId: "thread-1",
      turnId: "turn-1",
    };
    expect(schema.safeParse(required).success).toBe(true);
    expect(schema.safeParse({ ...required, environmentId: null, reason: null }).success).toBe(true);
    expect(
      schema.safeParse({ ...required, environmentId: "container-1", reason: "network" }).success,
    ).toBe(true);
    expect(schema.safeParse({ ...required, environmentId: 1 }).success).toBe(false);
    expect(schema.safeParse({ ...required, reason: false }).success).toBe(false);
  });

  it("parses the exact legacy command approval wire and rejects privilege passthrough", () => {
    const schema = serverRequestSchemas.execCommandApproval.params;
    const required = {
      callId: "call-1",
      command: ["rg", "token"],
      conversationId: "thread-1",
      cwd: "/repo",
      parsedCmd: [
        { cmd: "cat README.md", name: "README.md", path: "/repo/README.md", type: "read" },
        { cmd: "ls", path: null, type: "list_files" },
        { cmd: "rg token", path: "/repo", query: "token", type: "search" },
        { cmd: "custom", type: "unknown" },
      ],
    };
    expect(schema.safeParse(required).success).toBe(true);
    expect(schema.safeParse({ ...required, approvalId: null, reason: null }).success).toBe(true);
    expect(
      schema.safeParse({ ...required, approvalId: "approval-1", reason: "read" }).success,
    ).toBe(true);
    for (const invalid of [
      { approvalId: 1 },
      { reason: false },
      { parsedCmd: [{ cmd: "x", type: "execute" }] },
      { parsedCmd: [{ cmd: "x", name: 1, path: "/x", type: "read" }] },
      { parsedCmd: [{ cmd: "x", path: 1, type: "list_files" }] },
      { parsedCmd: [{ cmd: "x", query: 1, type: "search" }] },
      { additionalPermissions: { network: { enabled: true } } },
    ]) {
      expect(schema.safeParse({ ...required, ...invalid }).success).toBe(false);
    }
  });

  it("parses exact legacy patch changes and rejects unsafe record keys", () => {
    const schema = serverRequestSchemas.applyPatchApproval.params;
    const required = {
      callId: "call-1",
      conversationId: "thread-1",
      fileChanges: {
        "/repo/new.txt": { content: "new", type: "add" },
        "/repo/old.txt": { content: "old", type: "delete" },
        "/repo/moved.txt": {
          move_path: null,
          type: "update",
          unified_diff: "@@ -1 +1 @@",
        },
      },
    };
    expect(schema.safeParse(required).success).toBe(true);
    expect(schema.safeParse({ ...required, grantRoot: null, reason: null }).success).toBe(true);
    expect(schema.safeParse({ ...required, grantRoot: "/repo", reason: "write" }).success).toBe(
      true,
    );
    for (const invalid of [
      { grantRoot: 1 },
      { reason: false },
      { fileChanges: { "/x": { type: "add" } } },
      { fileChanges: { "/x": { content: "x", type: "remove" } } },
      { fileChanges: { "/x": { move_path: 1, type: "update", unified_diff: "x" } } },
      { fileChanges: { "/x": { type: "update", unified_diff: 1 } } },
    ]) {
      expect(schema.safeParse({ ...required, ...invalid }).success).toBe(false);
    }
    const unsafeChanges = JSON.parse('{"__proto__":{"content":"x","type":"add"}}') as Record<
      string,
      unknown
    >;
    expect(schema.safeParse({ ...required, fileChanges: unsafeChanges }).success).toBe(false);
  });

  it("normalizes an omitted thread/list cursor and permits harmless response metadata", () => {
    expect(ThreadListResponseSchema.parse({ data: [{ id: "thread-1" }] })).toEqual({
      data: [{ id: "thread-1" }],
      nextCursor: null,
    });
    expect(
      SuccessResponseEnvelopeSchema.parse({ id: 1, result: {}, metadata: { elapsedMs: 1 } }),
    ).toMatchObject({ id: 1, result: {}, metadata: { elapsedMs: 1 } });
    expect(
      ErrorResponseEnvelopeSchema.parse({
        id: "1",
        error: { code: -1, message: "failed" },
        metadata: true,
      }),
    ).toMatchObject({ id: "1", error: { code: -1, message: "failed" }, metadata: true });
  });

  it("keeps success and error response envelopes mutually exclusive", () => {
    expect(
      SuccessResponseEnvelopeSchema.safeParse({
        id: 1,
        result: {},
        error: { code: -1, message: "failed" },
      }).success,
    ).toBe(false);
    expect(
      ErrorResponseEnvelopeSchema.safeParse({
        id: 1,
        result: {},
        error: { code: -1, message: "failed" },
      }).success,
    ).toBe(false);
  });

  it.each([
    [
      "turn/plan/updated",
      {
        explanation: null,
        plan: [
          { status: "pending", step: "Inspect the code" },
          { status: "inProgress", step: "Implement the change" },
          { status: "completed", step: "Run tests" },
        ],
        threadId: "thread-1",
        turnId: "turn-1",
      },
    ],
    [
      "turn/diff/updated",
      { diff: "@@ -1 +1 @@\n-old\n+new", threadId: "thread-1", turnId: "turn-1" },
    ],
    [
      "item/reasoning/summaryTextDelta",
      {
        delta: "Checking the runtime boundary.",
        itemId: "item-1",
        summaryIndex: 0,
        threadId: "thread-1",
        turnId: "turn-1",
      },
    ],
    [
      "item/reasoning/summaryPartAdded",
      {
        itemId: "item-1",
        summaryIndex: 1,
        threadId: "thread-1",
        turnId: "turn-1",
      },
    ],
    [
      "item/commandExecution/outputDelta",
      {
        delta: "tests passed",
        itemId: "item-1",
        threadId: "thread-1",
        turnId: "turn-1",
      },
    ],
    ["warning", { message: "Context is almost full.", threadId: null }],
  ] as const)("parses bounded %s progress notifications with additive fields", (method, params) => {
    const schema = serverNotificationSchemas[method];
    expect(schema.parse({ ...params, additive: { future: true } })).toMatchObject(params);
  });

  it("rejects malformed or unbounded progress notification fields", () => {
    expect(
      serverNotificationSchemas["turn/plan/updated"].safeParse({
        plan: [{ status: "unknown", step: "x" }],
        threadId: "thread-1",
        turnId: "turn-1",
      }).success,
    ).toBe(false);
    expect(
      serverNotificationSchemas["turn/plan/updated"].safeParse({
        plan: Array.from({ length: 129 }, () => ({ status: "pending", step: "x" })),
        threadId: "thread-1",
        turnId: "turn-1",
      }).success,
    ).toBe(false);
    expect(
      serverNotificationSchemas["item/reasoning/summaryTextDelta"].safeParse({
        delta: "x".repeat(65_537),
        itemId: "item-1",
        summaryIndex: -1,
        threadId: "thread-1",
        turnId: "turn-1",
      }).success,
    ).toBe(false);
    expect(
      serverNotificationSchemas.warning.safeParse({
        message: "x".repeat(65_537),
        threadId: 1,
      }).success,
    ).toBe(false);
  });

  it.each([
    ["commentary", "commentary"],
    ["final_answer", "final_answer"],
    [undefined, undefined],
    [null, undefined],
    ["future_phase", undefined],
    [42, undefined],
  ] as const)("keeps completed agent text with phase %s", (phase, expectedKnownPhase) => {
    const parsed = serverNotificationSchemas["item/completed"].parse({
      completedAtMs: 1,
      item: {
        id: "item-1",
        text: "authoritative text",
        type: "agentMessage",
        ...(phase === undefined ? {} : { phase }),
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(parsed.item).toMatchObject({ id: "item-1", text: "authoritative text" });
    expect(knownAgentMessagePhase(parsed.item)).toBe(expectedKnownPhase);
  });

  it.each([
    [
      "commandExecution",
      { command: "npm test", cwd: "/repo", status: "inProgress" },
      { command: 1 },
    ],
    [
      "fileChange",
      {
        changes: [{ diff: "@@", kind: { type: "update" }, path: "/repo/src/a.ts" }],
        status: "completed",
      },
      { changes: [{ diff: "@@", kind: { type: "update" }, path: 1 }] },
    ],
    ["mcpToolCall", { server: "github", status: "inProgress", tool: "search" }, { server: 1 }],
    ["dynamicToolCall", { namespace: null, status: "completed", tool: "imagegen" }, { tool: 1 }],
    ["collabAgentToolCall", { status: "inProgress", tool: "spawnAgent" }, { status: "unknown" }],
    [
      "subAgentActivity",
      { agentPath: "agent", agentThreadId: "thread-2", kind: "started" },
      { kind: "unknown" },
    ],
    ["webSearch", { query: "Codex App Server" }, { query: 1 }],
  ] as const)("validates consumed %s item display fields", (type, fields, malformed) => {
    const schema = serverNotificationSchemas["item/completed"];
    const base = {
      completedAtMs: 1,
      item: { id: "item-1", type, ...fields, additive: true },
      threadId: "thread-1",
      turnId: "turn-1",
    };
    expect(schema.safeParse(base).success).toBe(true);
    expect(
      schema.safeParse({
        ...base,
        item: { ...base.item, ...malformed },
      }).success,
    ).toBe(false);
  });

  it("rejects agent messages without text but keeps unknown future items compatible", () => {
    const schema = serverNotificationSchemas["item/completed"];
    const envelope = {
      completedAtMs: 1,
      threadId: "thread-1",
      turnId: "turn-1",
    };
    expect(
      schema.safeParse({
        ...envelope,
        item: { id: "item-1", type: "agentMessage" },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...envelope,
        item: { id: "item-1", text: 1, type: "agentMessage" },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...envelope,
        item: { id: "item-1", future: { nested: true }, type: "futureItem" },
      }).success,
    ).toBe(true);
  });

  it("parses every checker canonical inbound witness with the runtime schemas", () => {
    const witnesses = (
      protocolChecker as typeof protocolChecker & {
        CANONICAL_INBOUND_WIRE_WITNESSES?: {
          clientResults: Record<string, unknown>;
          responseEnvelopes: { error: unknown; success: unknown };
          serverNotifications: Record<string, unknown>;
          serverRequests: Record<string, unknown>;
        };
      }
    ).CANONICAL_INBOUND_WIRE_WITNESSES;
    if (witnesses === undefined) {
      expect(witnesses).toBeDefined();
      return;
    }

    for (const [method, result] of Object.entries(witnesses.clientResults)) {
      const knownMethod = method as keyof typeof clientRequestSchemas;
      expect(clientRequestSchemas[knownMethod].result.safeParse(result).success, method).toBe(true);
    }
    for (const [method, params] of Object.entries(witnesses.serverNotifications)) {
      const knownMethod = method as keyof typeof serverNotificationSchemas;
      expect(serverNotificationSchemas[knownMethod].safeParse(params).success, method).toBe(true);
    }
    for (const [method, params] of Object.entries(witnesses.serverRequests)) {
      const knownMethod = method as keyof typeof serverRequestSchemas;
      expect(serverRequestSchemas[knownMethod].params.safeParse(params).success, method).toBe(true);
    }
    expect(
      SuccessResponseEnvelopeSchema.safeParse(witnesses.responseEnvelopes.success).success,
    ).toBe(true);
    expect(ErrorResponseEnvelopeSchema.safeParse(witnesses.responseEnvelopes.error).success).toBe(
      true,
    );
  });
});
