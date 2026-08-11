import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkInstalledCodexProtocol,
  checkProtocolSchemaBundle,
} from "../../src/app-server/check-protocol.js";
import { BridgeError } from "../../src/domain/errors.js";

type JsonSchema = Record<string, unknown>;

const temporaryDirectories: string[] = [];

function objectSchema(
  required: string[],
  properties: Record<string, unknown>,
  definitions?: Record<string, unknown>,
): JsonSchema {
  return {
    type: "object",
    required,
    properties,
    ...(definitions === undefined ? {} : { definitions }),
  };
}

function methodSchema(
  method: string,
  kind: "request" | "notification",
  params: unknown = { type: "object" },
): JsonSchema {
  const required = kind === "request" ? ["id", "method", "params"] : ["method", "params"];
  return objectSchema(required, {
    ...(kind === "request" ? { id: { $ref: "#/definitions/RequestId" } } : {}),
    method: { type: "string", enum: [method] },
    params,
  });
}

const clientRequestMethods = [
  "initialize",
  "thread/start",
  "thread/resume",
  "thread/list",
  "model/list",
  "thread/read",
  "thread/inject_items",
  "turn/start",
  "turn/interrupt",
];

const serverNotificationMethods = [
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "turn/plan/updated",
  "turn/diff/updated",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/commandExecution/outputDelta",
  "warning",
  "error",
];

const serverRequestMethods = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/call",
  "execCommandApproval",
  "applyPatchApproval",
];

function clientMethodParams(method: string): JsonSchema {
  switch (method) {
    case "initialize":
      return objectSchema(["clientInfo"], {
        clientInfo: objectSchema(["name", "version"], {
          name: { type: "string" },
          title: { type: ["string", "null"] },
          version: { type: "string" },
        }),
        capabilities: objectSchema([], {
          experimentalApi: { type: "boolean" },
          requestAttestation: { type: "boolean" },
        }),
      });
    case "thread/resume":
    case "thread/read":
      return objectSchema(["threadId"], { threadId: { type: "string" } });
    case "thread/inject_items":
      return objectSchema(["items", "threadId"], {
        items: { type: "array", items: true },
        threadId: { type: "string" },
      });
    case "thread/list":
      return objectSchema([], {
        cursor: { type: ["string", "null"] },
        limit: { type: ["integer", "null"], minimum: 0 },
      });
    case "model/list":
      return objectSchema([], {
        cursor: { type: ["string", "null"] },
        includeHidden: { type: ["boolean", "null"] },
        limit: { type: ["integer", "null"], minimum: 0 },
      });
    case "turn/start":
      return objectSchema(["input", "threadId"], {
        input: { type: "array" },
        threadId: { type: "string" },
      });
    case "turn/interrupt":
      return objectSchema(["threadId", "turnId"], {
        threadId: { type: "string" },
        turnId: { type: "string" },
      });
    default:
      return objectSchema([], {});
  }
}

function serverMethodParams(method: string): JsonSchema {
  const currentBase = {
    itemId: { type: "string" },
    startedAtMs: { type: "integer" },
    threadId: { type: "string" },
    turnId: { type: "string" },
  };
  switch (method) {
    case "item/commandExecution/requestApproval":
      return objectSchema(Object.keys(currentBase), {
        ...currentBase,
        command: { type: ["string", "null"] },
        cwd: { type: ["string", "null"] },
        reason: { type: ["string", "null"] },
      });
    case "item/fileChange/requestApproval":
      return objectSchema(Object.keys(currentBase), {
        ...currentBase,
        grantRoot: { type: ["string", "null"] },
        reason: { type: ["string", "null"] },
      });
    case "item/permissions/requestApproval":
      return objectSchema(["cwd", "itemId", "permissions", "startedAtMs", "threadId", "turnId"], {
        ...currentBase,
        cwd: { type: "string" },
        permissions: { type: "object" },
        reason: { type: ["string", "null"] },
      });
    case "item/tool/call":
      return objectSchema(["arguments", "callId", "threadId", "tool", "turnId"], {
        arguments: true,
        callId: { type: "string" },
        namespace: { type: ["string", "null"] },
        threadId: { type: "string" },
        tool: { type: "string" },
        turnId: { type: "string" },
      });
    case "execCommandApproval":
      return objectSchema(["callId", "command", "conversationId", "cwd", "parsedCmd"], {
        callId: { type: "string" },
        command: { type: "array", items: { type: "string" } },
        conversationId: { type: "string" },
        cwd: { type: "string" },
        parsedCmd: { type: "array" },
      });
    default:
      return objectSchema(["callId", "conversationId", "fileChanges"], {
        callId: { type: "string" },
        conversationId: { type: "string" },
        fileChanges: { type: "object" },
      });
  }
}

const threadDefinition = objectSchema(["id"], { id: { type: "string" } });
const turnDefinition = objectSchema(["id", "items", "status"], {
  id: { type: "string" },
  items: { type: "array" },
  status: {
    type: "string",
    enum: ["completed", "interrupted", "failed", "inProgress"],
  },
});

function currentDecisionDefinition(): JsonSchema {
  return {
    oneOf: ["accept", "acceptForSession", "decline", "cancel"].map((decision) => ({
      type: "string",
      enum: [decision],
    })),
  };
}

function legacyDecisionDefinition(): JsonSchema {
  return {
    oneOf: [
      ...["approved", "approved_for_session", "abort"].map((decision) => ({
        type: "string",
        enum: [decision],
      })),
      objectSchema(["denied"], {
        denied: objectSchema(["rejection"], { rejection: { type: "string" } }),
      }),
    ],
  };
}

function permissionDefinitions(profileName: string): Record<string, JsonSchema> {
  const fileSystemPath = {
    oneOf: [
      objectSchema(["path", "type"], {
        path: { type: "string" },
        type: { type: "string", enum: ["path"] },
      }),
      objectSchema(["pattern", "type"], {
        pattern: { type: "string" },
        type: { type: "string", enum: ["glob_pattern"] },
      }),
      objectSchema(["type", "value"], {
        type: { type: "string", enum: ["special"] },
        value: { type: "object" },
      }),
    ],
  };
  const fileSystemEntry = objectSchema(["access", "path"], {
    access: { type: "string", enum: ["read", "write", "deny"] },
    path: { $ref: "#/definitions/FileSystemPath" },
  });
  const fileSystem = objectSchema([], {
    entries: {
      type: ["array", "null"],
      items: { $ref: "#/definitions/FileSystemEntry" },
    },
    globScanMaxDepth: { type: ["integer", "null"], minimum: 1 },
    read: { type: ["array", "null"], items: { type: "string" } },
    write: { type: ["array", "null"], items: { type: "string" } },
  });
  const network = objectSchema([], { enabled: { type: ["boolean", "null"] } });
  return {
    [profileName]: objectSchema([], {
      fileSystem: {
        anyOf: [{ $ref: "#/definitions/FileSystemPermissions" }, { type: "null" }],
      },
      network: {
        anyOf: [{ $ref: "#/definitions/NetworkPermissions" }, { type: "null" }],
      },
    }),
    FileSystemPermissions: fileSystem,
    FileSystemEntry: fileSystemEntry,
    FileSystemPath: fileSystemPath,
    NetworkPermissions: network,
  };
}

function validBundle(): Record<string, JsonSchema> {
  const thread = structuredClone(threadDefinition);
  const turn = structuredClone(turnDefinition);
  const reasoningEffortOption = objectSchema(["description", "reasoningEffort"], {
    description: { type: "string" },
    reasoningEffort: { type: "string", minLength: 1 },
  });
  const modelDefinition = objectSchema(
    [
      "defaultReasoningEffort",
      "description",
      "displayName",
      "hidden",
      "id",
      "isDefault",
      "model",
      "supportedReasoningEfforts",
    ],
    {
      defaultReasoningEffort: { type: "string", minLength: 1 },
      description: { type: "string" },
      displayName: { type: "string" },
      hidden: { type: "boolean" },
      id: { type: "string" },
      isDefault: { type: "boolean" },
      model: { type: "string" },
      supportedReasoningEfforts: {
        type: "array",
        items: { $ref: "#/definitions/ReasoningEffortOption" },
      },
    },
  );
  const approvalParams = objectSchema(["itemId", "startedAtMs", "threadId", "turnId"], {
    command: { type: ["string", "null"] },
    cwd: { type: ["string", "null"] },
    grantRoot: { type: ["string", "null"] },
    itemId: { type: "string" },
    reason: { type: ["string", "null"] },
    startedAtMs: { type: "integer" },
    threadId: { type: "string" },
    turnId: { type: "string" },
  });
  const networkPolicyAmendment = objectSchema(["action", "host"], {
    action: { type: "string", enum: ["allow", "deny"] },
    host: { type: "string" },
  });
  const commandAction = {
    oneOf: [
      objectSchema(["command", "name", "path", "type"], {
        command: { type: "string" },
        name: { type: "string" },
        path: { type: "string" },
        type: { type: "string", enum: ["read"] },
      }),
      objectSchema(["command", "type"], {
        command: { type: "string" },
        path: { type: ["string", "null"] },
        type: { type: "string", enum: ["listFiles"] },
      }),
      objectSchema(["command", "type"], {
        command: { type: "string" },
        path: { type: ["string", "null"] },
        query: { type: ["string", "null"] },
        type: { type: "string", enum: ["search"] },
      }),
      objectSchema(["command", "type"], {
        command: { type: "string" },
        type: { type: "string", enum: ["unknown"] },
      }),
    ],
  };
  const parsedCommand = {
    oneOf: [
      objectSchema(["cmd", "name", "path", "type"], {
        cmd: { type: "string" },
        name: { type: "string" },
        path: { type: "string" },
        type: { type: "string", enum: ["read"] },
      }),
      objectSchema(["cmd", "type"], {
        cmd: { type: "string" },
        path: { type: ["string", "null"] },
        type: { type: "string", enum: ["list_files"] },
      }),
      objectSchema(["cmd", "type"], {
        cmd: { type: "string" },
        path: { type: ["string", "null"] },
        query: { type: ["string", "null"] },
        type: { type: "string", enum: ["search"] },
      }),
      objectSchema(["cmd", "type"], {
        cmd: { type: "string" },
        type: { type: "string", enum: ["unknown"] },
      }),
    ],
  };
  const fileChange = {
    oneOf: [
      objectSchema(["content", "type"], {
        content: { type: "string" },
        type: { type: "string", enum: ["add"] },
      }),
      objectSchema(["content", "type"], {
        content: { type: "string" },
        type: { type: "string", enum: ["delete"] },
      }),
      objectSchema(["type", "unified_diff"], {
        move_path: { type: ["string", "null"] },
        type: { type: "string", enum: ["update"] },
        unified_diff: { type: "string" },
      }),
    ],
  };
  const commandDecision = {
    oneOf: [
      ...["accept", "acceptForSession", "decline", "cancel"].map((decision) => ({
        type: "string",
        enum: [decision],
      })),
      objectSchema(["acceptWithExecpolicyAmendment"], {
        acceptWithExecpolicyAmendment: objectSchema(["execpolicy_amendment"], {
          execpolicy_amendment: { type: "array", items: { type: "string" } },
        }),
      }),
      objectSchema(["applyNetworkPolicyAmendment"], {
        applyNetworkPolicyAmendment: objectSchema(["network_policy_amendment"], {
          network_policy_amendment: { $ref: "#/definitions/NetworkPolicyAmendment" },
        }),
      }),
    ],
  };
  const commandApprovalParams = objectSchema(
    ["itemId", "startedAtMs", "threadId", "turnId"],
    {
      additionalPermissions: {
        anyOf: [{ $ref: "#/definitions/AdditionalPermissionProfile" }, { type: "null" }],
      },
      approvalId: { type: ["string", "null"] },
      availableDecisions: {
        type: ["array", "null"],
        items: { $ref: "#/definitions/CommandExecutionApprovalDecision" },
      },
      command: { type: ["string", "null"] },
      commandActions: {
        type: ["array", "null"],
        items: { $ref: "#/definitions/CommandAction" },
      },
      cwd: { type: ["string", "null"] },
      environmentId: { type: ["string", "null"] },
      itemId: { type: "string" },
      networkApprovalContext: {
        anyOf: [{ $ref: "#/definitions/NetworkApprovalContext" }, { type: "null" }],
      },
      proposedExecpolicyAmendment: {
        type: ["array", "null"],
        items: { type: "string" },
      },
      proposedNetworkPolicyAmendments: {
        type: ["array", "null"],
        items: { $ref: "#/definitions/NetworkPolicyAmendment" },
      },
      reason: { type: ["string", "null"] },
      startedAtMs: { type: "integer" },
      threadId: { type: "string" },
      turnId: { type: "string" },
    },
    {
      ...permissionDefinitions("AdditionalPermissionProfile"),
      CommandAction: commandAction,
      CommandExecutionApprovalDecision: commandDecision,
      NetworkApprovalContext: objectSchema(["host", "protocol"], {
        host: { type: "string" },
        protocol: { type: "string", enum: ["http", "https", "socks5Tcp", "socks5Udp"] },
      }),
      NetworkPolicyAmendment: networkPolicyAmendment,
    },
  );
  const currentApprovalResponse = objectSchema(
    ["decision"],
    { decision: { $ref: "#/definitions/Decision" } },
    { Decision: currentDecisionDefinition() },
  );
  const legacyApprovalResponse = objectSchema(
    ["decision"],
    { decision: { $ref: "#/definitions/ReviewDecision" } },
    { ReviewDecision: legacyDecisionDefinition() },
  );
  const progressStatus = {
    type: "string",
    enum: ["inProgress", "completed", "failed"],
  };
  const completionStatus = {
    type: "string",
    enum: ["inProgress", "completed", "failed", "declined"],
  };
  const threadItemDefinition = {
    oneOf: [
      objectSchema(["id", "text", "type"], {
        id: { type: "string" },
        phase: {
          anyOf: [{ type: "string", enum: ["commentary", "final_answer"] }, { type: "null" }],
        },
        text: { type: "string" },
        type: { type: "string", enum: ["agentMessage"] },
      }),
      objectSchema(["command", "commandActions", "cwd", "id", "status", "type"], {
        command: { type: "string" },
        commandActions: { type: "array", items: true },
        cwd: { type: "string" },
        id: { type: "string" },
        status: completionStatus,
        type: { type: "string", enum: ["commandExecution"] },
      }),
      objectSchema(["changes", "id", "status", "type"], {
        changes: {
          type: "array",
          items: objectSchema(["diff", "kind", "path"], {
            diff: { type: "string" },
            kind: objectSchema(["type"], {
              type: { type: "string", enum: ["add", "delete", "update"] },
            }),
            path: { type: "string" },
          }),
        },
        id: { type: "string" },
        status: completionStatus,
        type: { type: "string", enum: ["fileChange"] },
      }),
      objectSchema(["arguments", "id", "server", "status", "tool", "type"], {
        arguments: true,
        id: { type: "string" },
        server: { type: "string" },
        status: progressStatus,
        tool: { type: "string" },
        type: { type: "string", enum: ["mcpToolCall"] },
      }),
      objectSchema(["arguments", "id", "status", "tool", "type"], {
        arguments: true,
        id: { type: "string" },
        namespace: { type: ["string", "null"] },
        status: progressStatus,
        tool: { type: "string" },
        type: { type: "string", enum: ["dynamicToolCall"] },
      }),
      objectSchema(
        ["agentsStates", "id", "receiverThreadIds", "senderThreadId", "status", "tool", "type"],
        {
          agentsStates: { type: "object" },
          id: { type: "string" },
          receiverThreadIds: { type: "array", items: { type: "string" } },
          senderThreadId: { type: "string" },
          status: progressStatus,
          tool: {
            type: "string",
            enum: ["spawnAgent", "sendInput", "resumeAgent", "wait", "closeAgent"],
          },
          type: { type: "string", enum: ["collabAgentToolCall"] },
        },
      ),
      objectSchema(["agentPath", "agentThreadId", "id", "kind", "type"], {
        agentPath: { type: "string" },
        agentThreadId: { type: "string" },
        id: { type: "string" },
        kind: { type: "string", enum: ["started", "interacted", "interrupted"] },
        type: { type: "string", enum: ["subAgentActivity"] },
      }),
      objectSchema(["id", "query", "type"], {
        id: { type: "string" },
        query: { type: "string" },
        type: { type: "string", enum: ["webSearch"] },
      }),
    ],
  };
  const itemStartedNotification = objectSchema(
    ["item", "startedAtMs", "threadId", "turnId"],
    {
      item: { $ref: "#/definitions/ThreadItem" },
      startedAtMs: { type: "integer" },
      threadId: { type: "string" },
      turnId: { type: "string" },
    },
    { ThreadItem: threadItemDefinition },
  );
  const itemCompletedNotification = objectSchema(
    ["completedAtMs", "item", "threadId", "turnId"],
    {
      completedAtMs: { type: "integer" },
      item: { $ref: "#/definitions/ThreadItem" },
      threadId: { type: "string" },
      turnId: { type: "string" },
    },
    {
      ThreadItem: (itemStartedNotification.definitions as Record<string, JsonSchema>)
        .ThreadItem as JsonSchema,
    },
  );
  const turnNotification = objectSchema(
    ["threadId", "turn"],
    { threadId: { type: "string" }, turn: { $ref: "#/definitions/Turn" } },
    { Turn: turn },
  );
  const deltaNotification = objectSchema(["delta", "itemId", "threadId", "turnId"], {
    delta: { type: "string" },
    itemId: { type: "string" },
    threadId: { type: "string" },
    turnId: { type: "string" },
  });
  const errorNotification = objectSchema(["error", "threadId", "turnId", "willRetry"], {
    error: objectSchema(["message"], { message: { type: "string" } }),
    threadId: { type: "string" },
    turnId: { type: "string" },
    willRetry: { type: "boolean" },
  });
  const turnPlanUpdatedNotification = objectSchema(["plan", "threadId", "turnId"], {
    explanation: { type: ["string", "null"] },
    plan: {
      type: "array",
      items: objectSchema(["status", "step"], {
        status: { type: "string", enum: ["pending", "inProgress", "completed"] },
        step: { type: "string" },
      }),
    },
    threadId: { type: "string" },
    turnId: { type: "string" },
  });
  const turnDiffUpdatedNotification = objectSchema(["diff", "threadId", "turnId"], {
    diff: { type: "string" },
    threadId: { type: "string" },
    turnId: { type: "string" },
  });
  const reasoningSummaryTextDeltaNotification = objectSchema(
    ["delta", "itemId", "summaryIndex", "threadId", "turnId"],
    {
      delta: { type: "string" },
      itemId: { type: "string" },
      summaryIndex: { type: "integer" },
      threadId: { type: "string" },
      turnId: { type: "string" },
    },
  );
  const reasoningSummaryPartAddedNotification = objectSchema(
    ["itemId", "summaryIndex", "threadId", "turnId"],
    {
      itemId: { type: "string" },
      summaryIndex: { type: "integer" },
      threadId: { type: "string" },
      turnId: { type: "string" },
    },
  );
  const commandExecutionOutputDeltaNotification = objectSchema(
    ["delta", "itemId", "threadId", "turnId"],
    {
      delta: { type: "string" },
      itemId: { type: "string" },
      threadId: { type: "string" },
      turnId: { type: "string" },
    },
  );
  const warningNotification = objectSchema(["message"], {
    message: { type: "string" },
    threadId: { type: ["string", "null"] },
  });
  const notificationDefinitions: Record<string, JsonSchema> = {
    Turn: turn,
    ThreadItem: (itemStartedNotification.definitions as Record<string, JsonSchema>)
      .ThreadItem as JsonSchema,
    TurnStartedNotification: turnNotification,
    TurnCompletedNotification: turnNotification,
    ItemStartedNotification: itemStartedNotification,
    ItemCompletedNotification: itemCompletedNotification,
    AgentMessageDeltaNotification: deltaNotification,
    TurnPlanUpdatedNotification: turnPlanUpdatedNotification,
    TurnDiffUpdatedNotification: turnDiffUpdatedNotification,
    ReasoningSummaryTextDeltaNotification: reasoningSummaryTextDeltaNotification,
    ReasoningSummaryPartAddedNotification: reasoningSummaryPartAddedNotification,
    CommandExecutionOutputDeltaNotification: commandExecutionOutputDeltaNotification,
    WarningNotification: warningNotification,
    ErrorNotification: errorNotification,
  };
  const notificationDefinitionNames: Record<string, string> = {
    "turn/started": "TurnStartedNotification",
    "turn/completed": "TurnCompletedNotification",
    "item/started": "ItemStartedNotification",
    "item/completed": "ItemCompletedNotification",
    "item/agentMessage/delta": "AgentMessageDeltaNotification",
    "turn/plan/updated": "TurnPlanUpdatedNotification",
    "turn/diff/updated": "TurnDiffUpdatedNotification",
    "item/reasoning/summaryTextDelta": "ReasoningSummaryTextDeltaNotification",
    "item/reasoning/summaryPartAdded": "ReasoningSummaryPartAddedNotification",
    "item/commandExecution/outputDelta": "CommandExecutionOutputDeltaNotification",
    warning: "WarningNotification",
    error: "ErrorNotification",
  };

  return {
    "ClientRequest.json": {
      oneOf: clientRequestMethods.map((method) =>
        methodSchema(method, "request", clientMethodParams(method)),
      ),
      definitions: { RequestId: { anyOf: [{ type: "string" }, { type: "integer" }] } },
    },
    "ClientNotification.json": {
      oneOf: [
        objectSchema(["method"], {
          method: { type: "string", enum: ["initialized"] },
        }),
      ],
    },
    "ServerNotification.json": {
      oneOf: serverNotificationMethods.map((method) =>
        methodSchema(method, "notification", {
          $ref: `#/definitions/${notificationDefinitionNames[method] as string}`,
        }),
      ),
      definitions: notificationDefinitions,
    },
    "ServerRequest.json": {
      oneOf: serverRequestMethods.map((method) =>
        methodSchema(method, "request", serverMethodParams(method)),
      ),
      definitions: { RequestId: { anyOf: [{ type: "string" }, { type: "integer" }] } },
    },
    "RequestId.json": { anyOf: [{ type: "string" }, { type: "integer" }] },
    "JSONRPCResponse.json": objectSchema(
      ["id", "result"],
      {
        id: { $ref: "#/definitions/RequestId" },
        result: true,
      },
      { RequestId: { anyOf: [{ type: "string" }, { type: "integer" }] } },
    ),
    "JSONRPCError.json": objectSchema(
      ["id", "error"],
      {
        id: { $ref: "#/definitions/RequestId" },
        error: objectSchema(["code", "message"], {
          code: { type: "integer" },
          message: { type: "string" },
        }),
      },
      { RequestId: { anyOf: [{ type: "string" }, { type: "integer" }] } },
    ),
    "v1/InitializeParams.json": objectSchema(
      ["clientInfo"],
      {
        clientInfo: { $ref: "#/definitions/ClientInfo" },
        capabilities: { $ref: "#/definitions/InitializeCapabilities" },
      },
      {
        ClientInfo: objectSchema(["name", "version"], {
          name: { type: "string" },
          title: { type: ["string", "null"] },
          version: { type: "string" },
        }),
        InitializeCapabilities: objectSchema([], {
          experimentalApi: { type: "boolean" },
          requestAttestation: { type: "boolean" },
        }),
      },
    ),
    "v1/InitializeResponse.json": objectSchema(
      ["codexHome", "platformFamily", "platformOs", "userAgent"],
      {
        codexHome: { type: "string" },
        platformFamily: { type: "string" },
        platformOs: { type: "string" },
        userAgent: { type: "string" },
      },
    ),
    "v2/ThreadStartParams.json": objectSchema([], {
      cwd: { type: ["string", "null"] },
      approvalPolicy: {
        anyOf: [
          { type: "string", enum: ["untrusted", "on-request", "never"] },
          { type: "object" },
          { type: "null" },
        ],
      },
      sandbox: {
        type: ["string", "null"],
        enum: ["read-only", "workspace-write", "danger-full-access", null],
      },
      permissions: { type: ["string", "null"] },
      model: { type: ["string", "null"] },
      serviceTier: { type: ["string", "null"] },
      runtimeWorkspaceRoots: { type: ["array", "null"], items: { type: "string" } },
      developerInstructions: { type: ["string", "null"] },
      dynamicTools: {
        type: ["array", "null"],
        items: {
          oneOf: [
            objectSchema(["description", "inputSchema", "name", "type"], {
              type: { type: "string", enum: ["function"] },
              name: { type: "string" },
              description: { type: "string" },
              inputSchema: true,
              deferLoading: { type: "boolean" },
            }),
          ],
        },
      },
      ephemeral: { type: ["boolean", "null"] },
    }),
    "v2/ThreadStartResponse.json": objectSchema(
      ["thread"],
      { thread: { $ref: "#/definitions/Thread" } },
      { Thread: thread },
    ),
    "v2/ThreadResumeParams.json": objectSchema(["threadId"], {
      threadId: { type: "string" },
      cwd: { type: ["string", "null"] },
      approvalPolicy: {
        anyOf: [
          { type: "string", enum: ["untrusted", "on-request", "never"] },
          { type: "object" },
          { type: "null" },
        ],
      },
      sandbox: {
        type: ["string", "null"],
        enum: ["read-only", "workspace-write", "danger-full-access", null],
      },
      permissions: { type: ["string", "null"] },
      model: { type: ["string", "null"] },
      serviceTier: { type: ["string", "null"] },
      runtimeWorkspaceRoots: { type: ["array", "null"], items: { type: "string" } },
      developerInstructions: { type: ["string", "null"] },
    }),
    "v2/ThreadResumeResponse.json": objectSchema(
      ["thread"],
      { thread: { $ref: "#/definitions/Thread" } },
      { Thread: thread },
    ),
    "v2/ThreadListParams.json": objectSchema([], {
      cursor: { type: ["string", "null"] },
      limit: { type: ["integer", "null"], minimum: 0 },
      sourceKinds: {
        type: ["array", "null"],
        items: {
          type: "string",
          enum: [
            "cli",
            "vscode",
            "exec",
            "appServer",
            "subAgent",
            "subAgentReview",
            "subAgentCompact",
            "subAgentThreadSpawn",
            "subAgentOther",
            "unknown",
          ],
        },
      },
    }),
    "v2/ThreadListResponse.json": objectSchema(
      ["data"],
      {
        data: { type: "array", items: { $ref: "#/definitions/Thread" } },
        nextCursor: { type: ["string", "null"] },
      },
      { Thread: thread },
    ),
    "v2/ModelListParams.json": objectSchema([], {
      cursor: { type: ["string", "null"] },
      includeHidden: { type: ["boolean", "null"] },
      limit: { type: ["integer", "null"], minimum: 0 },
    }),
    "v2/ModelListResponse.json": objectSchema(
      ["data"],
      {
        data: { type: "array", items: { $ref: "#/definitions/Model" } },
        nextCursor: { type: ["string", "null"] },
      },
      { Model: modelDefinition, ReasoningEffortOption: reasoningEffortOption },
    ),
    "v2/ThreadReadParams.json": objectSchema(["threadId"], {
      threadId: { type: "string" },
      includeTurns: { type: "boolean" },
    }),
    "v2/ThreadReadResponse.json": objectSchema(
      ["thread"],
      { thread: { $ref: "#/definitions/Thread" } },
      { Thread: thread },
    ),
    "v2/ThreadInjectItemsParams.json": objectSchema(["items", "threadId"], {
      items: { type: "array", items: true },
      threadId: { type: "string" },
    }),
    "v2/ThreadInjectItemsResponse.json": objectSchema([], {}),
    "v2/TurnStartParams.json": objectSchema(["threadId", "input"], {
      threadId: { type: "string" },
      input: {
        type: "array",
        items: {
          oneOf: [
            objectSchema(["text", "type"], {
              text: { type: "string" },
              text_elements: { type: "array", items: { type: "object" } },
              type: { type: "string", enum: ["text"] },
            }),
            objectSchema(["type", "url"], {
              type: { type: "string", enum: ["image"] },
              url: { type: "string" },
            }),
            objectSchema(["path", "type"], {
              path: { type: "string" },
              type: { type: "string", enum: ["localImage"] },
            }),
            objectSchema(["type", "url"], {
              type: { type: "string", enum: ["audio"] },
              url: { type: "string" },
            }),
            objectSchema(["path", "type"], {
              path: { type: "string" },
              type: { type: "string", enum: ["localAudio"] },
            }),
            objectSchema(["name", "path", "type"], {
              name: { type: "string" },
              path: { type: "string" },
              type: { type: "string", enum: ["skill"] },
            }),
            objectSchema(["name", "path", "type"], {
              name: { type: "string" },
              path: { type: "string" },
              type: { type: "string", enum: ["mention"] },
            }),
          ],
        },
      },
      clientUserMessageId: { type: ["string", "null"] },
      model: { type: ["string", "null"] },
      effort: { type: ["string", "null"] },
      responsesapiClientMetadata: {
        type: ["object", "null"],
        additionalProperties: { type: "string" },
      },
    }),
    "v2/TurnStartResponse.json": objectSchema(
      ["turn"],
      { turn: { $ref: "#/definitions/Turn" } },
      { Turn: turn },
    ),
    "v2/TurnInterruptParams.json": objectSchema(["threadId", "turnId"], {
      threadId: { type: "string" },
      turnId: { type: "string" },
    }),
    "v2/TurnInterruptResponse.json": objectSchema([], {}),
    "v2/TurnStartedNotification.json": turnNotification,
    "v2/TurnCompletedNotification.json": turnNotification,
    "v2/ItemStartedNotification.json": itemStartedNotification,
    "v2/ItemCompletedNotification.json": itemCompletedNotification,
    "v2/AgentMessageDeltaNotification.json": deltaNotification,
    "v2/TurnPlanUpdatedNotification.json": turnPlanUpdatedNotification,
    "v2/TurnDiffUpdatedNotification.json": turnDiffUpdatedNotification,
    "v2/ReasoningSummaryTextDeltaNotification.json": reasoningSummaryTextDeltaNotification,
    "v2/ReasoningSummaryPartAddedNotification.json": reasoningSummaryPartAddedNotification,
    "v2/CommandExecutionOutputDeltaNotification.json": commandExecutionOutputDeltaNotification,
    "v2/WarningNotification.json": warningNotification,
    "v2/ErrorNotification.json": errorNotification,
    "CommandExecutionRequestApprovalParams.json": commandApprovalParams,
    "CommandExecutionRequestApprovalResponse.json": currentApprovalResponse,
    "FileChangeRequestApprovalParams.json": approvalParams,
    "FileChangeRequestApprovalResponse.json": currentApprovalResponse,
    "PermissionsRequestApprovalParams.json": objectSchema(
      ["cwd", "itemId", "permissions", "startedAtMs", "threadId", "turnId"],
      {
        cwd: { type: "string" },
        environmentId: { type: ["string", "null"] },
        itemId: { type: "string" },
        permissions: { $ref: "#/definitions/RequestPermissionProfile" },
        reason: { type: ["string", "null"] },
        startedAtMs: { type: "integer" },
        threadId: { type: "string" },
        turnId: { type: "string" },
      },
      permissionDefinitions("RequestPermissionProfile"),
    ),
    "PermissionsRequestApprovalResponse.json": objectSchema(
      ["permissions"],
      {
        permissions: { $ref: "#/definitions/GrantedPermissionProfile" },
        scope: { $ref: "#/definitions/PermissionGrantScope" },
        strictAutoReview: { type: ["boolean", "null"] },
      },
      {
        ...permissionDefinitions("GrantedPermissionProfile"),
        PermissionGrantScope: { type: "string", enum: ["turn", "session"] },
      },
    ),
    "DynamicToolCallParams.json": objectSchema(
      ["arguments", "callId", "threadId", "tool", "turnId"],
      {
        arguments: true,
        callId: { type: "string" },
        namespace: { type: ["string", "null"] },
        threadId: { type: "string" },
        tool: { type: "string" },
        turnId: { type: "string" },
      },
    ),
    "DynamicToolCallResponse.json": objectSchema(
      ["contentItems", "success"],
      {
        contentItems: { type: "array", items: { $ref: "#/definitions/ContentItem" } },
        success: { type: "boolean" },
      },
      {
        ContentItem: {
          oneOf: [
            objectSchema(["text", "type"], {
              text: { type: "string" },
              type: { type: "string", enum: ["inputText"] },
            }),
            objectSchema(["imageUrl", "type"], {
              imageUrl: { type: "string" },
              type: { type: "string", enum: ["inputImage"] },
            }),
            objectSchema(["audioUrl", "type"], {
              audioUrl: { type: "string" },
              type: { type: "string", enum: ["inputAudio"] },
            }),
          ],
        },
      },
    ),
    "ExecCommandApprovalParams.json": objectSchema(
      ["callId", "command", "conversationId", "cwd", "parsedCmd"],
      {
        approvalId: { type: ["string", "null"] },
        callId: { type: "string" },
        command: { type: "array", items: { type: "string" } },
        conversationId: { type: "string" },
        cwd: { type: "string" },
        parsedCmd: { type: "array", items: { $ref: "#/definitions/ParsedCommand" } },
        reason: { type: ["string", "null"] },
      },
      { ParsedCommand: parsedCommand },
    ),
    "ExecCommandApprovalResponse.json": legacyApprovalResponse,
    "ApplyPatchApprovalParams.json": objectSchema(
      ["callId", "conversationId", "fileChanges"],
      {
        callId: { type: "string" },
        conversationId: { type: "string" },
        fileChanges: {
          type: "object",
          additionalProperties: { $ref: "#/definitions/FileChange" },
        },
        grantRoot: { type: ["string", "null"] },
        reason: { type: ["string", "null"] },
      },
      { FileChange: fileChange },
    ),
    "ApplyPatchApprovalResponse.json": legacyApprovalResponse,
  };
}

async function writeBundle(mutate?: (bundle: Record<string, JsonSchema>) => void): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-protocol-test-"));
  temporaryDirectories.push(directory);
  const bundle = validBundle();
  mutate?.(bundle);
  for (const [relativePath, schema] of Object.entries(bundle)) {
    const path = join(directory, relativePath);
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(join(path, ".."), { recursive: true }),
    );
    await writeFile(path, JSON.stringify(schema));
  }
  return directory;
}

async function expectIncompatible(
  mutate: (bundle: Record<string, JsonSchema>) => void,
  contract: string,
): Promise<void> {
  const directory = await writeBundle(mutate);
  try {
    await checkProtocolSchemaBundle(directory);
    throw new Error("expected protocol incompatibility");
  } catch (error) {
    expect(error).toBeInstanceOf(BridgeError);
    expect(error).toMatchObject({ code: "CONFIGURATION" });
    expect((error as Error).message).toContain(contract);
    expect((error as BridgeError).remediation).toContain("Codex CLI");
    expect((error as Error).message).not.toContain("properties");
  }
}

function inspectPublicErrorGraph(root: unknown): string {
  const seen = new Set<object>();
  const pending: unknown[] = [root];
  const fields: string[] = [];
  while (pending.length > 0) {
    const value = pending.pop();
    if ((typeof value !== "object" && typeof value !== "function") || value === null) {
      fields.push(String(value));
      continue;
    }
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      fields.push(String(key));
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && "value" in descriptor) {
        pending.push(descriptor.value);
      }
    }
  }

  const jsonSeen = new WeakSet<object>();
  const json = JSON.stringify(root, (_key, value: unknown) => {
    if (typeof value === "object" && value !== null) {
      if (jsonSeen.has(value)) return "[Circular]";
      jsonSeen.add(value);
    }
    return value;
  });
  return [String(root), inspect(root, { depth: 12 }), json ?? "", ...fields].join("\n");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("App Server protocol compatibility", () => {
  it("accepts the complete bridge-used contract and unrelated additive schemas", async () => {
    const directory = await writeBundle((bundle) => {
      bundle["UnrelatedFutureMethod.json"] = objectSchema(["future"], {
        future: { type: "string" },
      });
    });

    await expect(checkProtocolSchemaBundle(directory)).resolves.toMatchObject({
      compatible: true,
    });
  });

  it("accepts coherent alternative success and error envelope branches", async () => {
    const directory = await writeBundle((bundle) => {
      const success = bundle["JSONRPCResponse.json"] as JsonSchema;
      const failure = bundle["JSONRPCError.json"] as JsonSchema;
      bundle["JSONRPCResponse.json"] = {
        oneOf: [success, objectSchema(["event"], { event: { type: "string" } })],
        definitions: success.definitions,
      };
      bundle["JSONRPCError.json"] = {
        anyOf: [failure, objectSchema(["event"], { event: { type: "string" } })],
        definitions: failure.definitions,
      };
    });

    await expect(checkProtocolSchemaBundle(directory)).resolves.toEqual({ compatible: true });
  });

  it.each(["oneOf", "anyOf"] as const)(
    "rejects an envelope assembled from mutually exclusive %s branches",
    async (keyword) => {
      await expectIncompatible((bundle) => {
        bundle["JSONRPCResponse.json"] = {
          [keyword]: [
            objectSchema(["id"], { id: { type: ["string", "integer"] }, result: true }),
            objectSchema(["result"], { id: { type: ["string", "integer"] }, result: true }),
          ],
        };
      }, "success response envelope");
    },
  );

  it("rejects mutually contradictory allOf decision enums", async () => {
    await expectIncompatible((bundle) => {
      const schema = bundle["CommandExecutionRequestApprovalResponse.json"] as {
        definitions: { Decision: JsonSchema };
      };
      schema.definitions.Decision = {
        allOf: [
          { type: "string", enum: ["accept", "acceptForSession"] },
          { type: "string", enum: ["decline", "cancel"] },
        ],
      };
    }, "current approval decisions");
  });

  it("rejects unresolved external schema references without loading them", async () => {
    await expectIncompatible((bundle) => {
      bundle["RequestId.json"] = { $ref: "https://example.invalid/request-id.json" };
    }, "request ID string-or-number support schema references");
  });

  it("redacts unresolved schema references from the entire public error graph", async () => {
    const sentinel = "UNTRUSTED_SCHEMA_REF_SENTINEL";
    const sentinelPath = `/private/tmp/${sentinel}/request-id.json`;
    const directory = await writeBundle((bundle) => {
      bundle["RequestId.json"] = { $ref: `file://${sentinelPath}` };
    });

    let thrown: unknown;
    try {
      await checkProtocolSchemaBundle(directory);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BridgeError);
    expect(thrown).toMatchObject({
      code: "CONFIGURATION",
      remediation: expect.stringContaining("Codex CLI"),
    });
    expect((thrown as Error).message).toContain(
      "request ID string-or-number support schema references",
    );
    const publicErrorGraph = inspectPublicErrorGraph(thrown);
    expect(publicErrorGraph).not.toContain(sentinel);
    expect(publicErrorGraph).not.toContain(sentinelPath);
    expect(publicErrorGraph).toContain("CONFIGURATION");
    expect(publicErrorGraph).toContain("request ID string-or-number support schema references");
  });

  it("rejects initialized notifications that unexpectedly mandate params", async () => {
    await expectIncompatible((bundle) => {
      const schema = bundle["ClientNotification.json"] as { oneOf: JsonSchema[] };
      const initialized = schema.oneOf[0] as {
        required: string[];
        properties: Record<string, unknown>;
      };
      initialized.required.push("params");
      initialized.properties.params = { type: "object" };
    }, "client notification initialized");
  });

  it("rejects unconstrained thread resume configuration fields", async () => {
    await expectIncompatible((bundle) => {
      const schema = bundle["v2/ThreadResumeParams.json"] as {
        properties: Record<string, unknown>;
      };
      delete schema.properties.sandbox;
    }, "thread/resume parameters");
  });

  it("rejects incompatible thread/start persistence and dynamic tool fields", async () => {
    await expectIncompatible((bundle) => {
      const schema = bundle["v2/ThreadStartParams.json"] as {
        properties: Record<string, unknown>;
      };
      schema.properties.dynamicTools = { type: "string" };
      schema.properties.ephemeral = { type: "string" };
    }, "thread/start parameters");
  });

  it("rejects an unconstrained thread/list limit", async () => {
    await expectIncompatible((bundle) => {
      const schema = bundle["v2/ThreadListParams.json"] as {
        properties: Record<string, unknown>;
      };
      delete schema.properties.limit;
    }, "thread/list cursor");
  });

  it("rejects incompatible persisted thread source kinds", async () => {
    await expectIncompatible((bundle) => {
      const schema = bundle["v2/ThreadListParams.json"] as {
        properties: Record<string, unknown>;
      };
      schema.properties.sourceKinds = { type: "string" };
    }, "thread/list cursor");
  });

  it("rejects incompatible model/list request and response contracts", async () => {
    await expectIncompatible((bundle) => {
      const schema = bundle["v2/ModelListParams.json"] as {
        properties: Record<string, unknown>;
      };
      schema.properties.includeHidden = { type: "string" };
    }, "model/list parameters");

    await expectIncompatible((bundle) => {
      const schema = bundle["v2/ModelListResponse.json"] as {
        definitions: { Model: { required: string[] } };
      };
      schema.definitions.Model.required = schema.definitions.Model.required.filter(
        (field) => field !== "description",
      );
    }, "model/list response");

    await expectIncompatible((bundle) => {
      const schema = bundle["v2/ModelListResponse.json"] as {
        definitions: { ReasoningEffortOption: { required: string[] } };
      };
      schema.definitions.ReasoningEffortOption.required = [];
    }, "model/list response");
  });

  it("requires valid optional turn model and effort strings", async () => {
    await expectIncompatible((bundle) => {
      const schema = bundle["v2/TurnStartParams.json"] as {
        properties: Record<string, unknown>;
      };
      schema.properties.model = { type: "integer" };
      schema.properties.effort = { type: "array" };
    }, "turn/start parameters");
  });

  it("rejects a missing bridge-supported turn input variant", async () => {
    await expectIncompatible((bundle) => {
      const schema = bundle["v2/TurnStartParams.json"] as {
        properties: { input: { items: { oneOf: JsonSchema[] } } };
      };
      schema.properties.input.items.oneOf = schema.properties.input.items.oneOf.filter(
        (entry) =>
          ((entry.properties as Record<string, { enum?: string[] }>).type?.enum ?? [])[0] !==
          "localAudio",
      );
    }, "turn/start parameters");
  });

  it("rejects incompatible turn source metadata and text elements", async () => {
    await expectIncompatible((bundle) => {
      const schema = bundle["v2/TurnStartParams.json"] as {
        properties: {
          clientUserMessageId?: unknown;
          responsesapiClientMetadata?: unknown;
          input: { items: { oneOf: JsonSchema[] } };
        };
      };
      schema.properties.clientUserMessageId = { type: "integer" };
      schema.properties.responsesapiClientMetadata = { type: "array" };
      const textInput = schema.properties.input.items.oneOf[0] as {
        properties: Record<string, unknown>;
      };
      textInput.properties.text_elements = { type: "object" };
    }, "turn/start parameters");
  });

  it("rejects aggregate server requests with unconstrained required params", async () => {
    await expectIncompatible((bundle) => {
      const schema = bundle["ServerRequest.json"] as { oneOf: JsonSchema[] };
      const command = schema.oneOf.find(
        (entry) =>
          ((entry.properties as Record<string, { enum?: string[] }>).method?.enum ?? [])[0] ===
          "item/commandExecution/requestApproval",
      ) as { properties: Record<string, unknown> };
      command.properties.params = { type: "object" };
    }, "server request item/commandExecution/requestApproval");
  });

  it("rejects current approval responses with an optional decision", async () => {
    await expectIncompatible((bundle) => {
      const schema = bundle["FileChangeRequestApprovalResponse.json"] as {
        required: string[];
      };
      schema.required = schema.required.filter((field) => field !== "decision");
    }, "current approval decisions");
  });

  it("rejects legacy approval responses with an optional decision", async () => {
    await expectIncompatible((bundle) => {
      const schema = bundle["ExecCommandApprovalResponse.json"] as { required: string[] };
      schema.required = schema.required.filter((field) => field !== "decision");
    }, "legacy approval decisions");
  });

  it("rejects server notification entries without their required params", async () => {
    await expectIncompatible((bundle) => {
      const schema = bundle["ServerNotification.json"] as { oneOf: JsonSchema[] };
      const entry = schema.oneOf[0] as { required: string[]; properties: Record<string, unknown> };
      entry.required = entry.required.filter((field) => field !== "params");
      delete entry.properties.params;
    }, "server notification turn/started");
  });

  it("rejects server notification entries with the wrong params shape", async () => {
    await expectIncompatible((bundle) => {
      const schema = bundle["ServerNotification.json"] as { oneOf: JsonSchema[] };
      const entry = schema.oneOf.find(
        (candidate) =>
          ((candidate.properties as Record<string, { enum?: string[] }>).method?.enum ?? [])[0] ===
          "item/agentMessage/delta",
      ) as { properties: Record<string, unknown> };
      entry.properties.params = { type: "array" };
    }, "server notification item/agentMessage/delta");
  });

  it.each([
    "turn/plan/updated",
    "turn/diff/updated",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/commandExecution/outputDelta",
    "warning",
  ])("requires the selected %s server notification", async (method) => {
    await expectIncompatible((bundle) => {
      const schema = bundle["ServerNotification.json"] as { oneOf: JsonSchema[] };
      schema.oneOf = schema.oneOf.filter(
        (candidate) =>
          ((candidate.properties as Record<string, { enum?: string[] }>).method?.enum ?? [])[0] !==
          method,
      );
    }, `server notification ${method}`);
  });

  it.each([
    ["v2/TurnPlanUpdatedNotification.json", "plan", "turn plan update notification"],
    ["v2/TurnDiffUpdatedNotification.json", "diff", "turn diff update notification"],
    [
      "v2/ReasoningSummaryTextDeltaNotification.json",
      "summaryIndex",
      "reasoning summary text delta notification",
    ],
    [
      "v2/ReasoningSummaryPartAddedNotification.json",
      "summaryIndex",
      "reasoning summary part notification",
    ],
    [
      "v2/CommandExecutionOutputDeltaNotification.json",
      "delta",
      "command output delta notification",
    ],
    ["v2/WarningNotification.json", "message", "warning notification"],
  ])("checks the consumed %s field", async (schemaPath, field, contract) => {
    await expectIncompatible((bundle) => {
      bundle[schemaPath] = structuredClone(bundle[schemaPath] as JsonSchema);
      const schema = bundle[schemaPath] as { properties: Record<string, unknown> };
      schema.properties[field] = { type: "object" };
    }, contract);
  });

  it.each([
    ["agentMessage", "text"],
    ["commandExecution", "command"],
    ["fileChange", "changes"],
    ["mcpToolCall", "server"],
    ["dynamicToolCall", "tool"],
    ["collabAgentToolCall", "tool"],
    ["subAgentActivity", "kind"],
    ["webSearch", "query"],
  ])("checks consumed %s item field %s", async (type, field) => {
    await expectIncompatible((bundle) => {
      bundle["v2/ItemCompletedNotification.json"] = structuredClone(
        bundle["v2/ItemCompletedNotification.json"] as JsonSchema,
      );
      const schema = bundle["v2/ItemCompletedNotification.json"] as {
        definitions: { ThreadItem: { oneOf: JsonSchema[] } };
      };
      const item = schema.definitions.ThreadItem.oneOf.find(
        (candidate) =>
          ((candidate.properties as Record<string, { enum?: string[] }>).type?.enum ?? [])[0] ===
          type,
      ) as { properties: Record<string, unknown> };
      item.properties[field] = { type: "number" };
    }, "item/completed notification");
  });

  it.each([
    [
      "initialize client fields",
      "initialize client information",
      (bundle: Record<string, JsonSchema>) => {
        const schema = bundle["v1/InitializeParams.json"] as {
          definitions: { ClientInfo: { properties: Record<string, unknown> } };
        };
        schema.definitions.ClientInfo.properties.name = { type: "integer" };
      },
    ],
    [
      "thread request IDs",
      "thread/read parameters",
      (bundle: Record<string, JsonSchema>) => {
        const schema = bundle["v2/ThreadReadParams.json"] as {
          properties: Record<string, unknown>;
        };
        schema.properties.threadId = { type: "integer" };
      },
    ],
    [
      "thread response IDs",
      "thread/read response",
      (bundle: Record<string, JsonSchema>) => {
        bundle["v2/ThreadReadResponse.json"] = structuredClone(
          bundle["v2/ThreadReadResponse.json"] as JsonSchema,
        );
        const schema = bundle["v2/ThreadReadResponse.json"] as {
          definitions: { Thread: { properties: Record<string, unknown> } };
        };
        schema.definitions.Thread.properties.id = { type: "integer" };
      },
    ],
    [
      "turn input containers",
      "turn/start parameters",
      (bundle: Record<string, JsonSchema>) => {
        const schema = bundle["v2/TurnStartParams.json"] as {
          properties: Record<string, unknown>;
        };
        schema.properties.input = { type: "object" };
      },
    ],
    [
      "turn notification IDs",
      "turn/started notification",
      (bundle: Record<string, JsonSchema>) => {
        bundle["v2/TurnStartedNotification.json"] = structuredClone(
          bundle["v2/TurnStartedNotification.json"] as JsonSchema,
        );
        const schema = bundle["v2/TurnStartedNotification.json"] as {
          properties: Record<string, unknown>;
        };
        schema.properties.threadId = { type: "integer" };
      },
    ],
    [
      "item notification payloads",
      "item/started notification",
      (bundle: Record<string, JsonSchema>) => {
        bundle["v2/ItemStartedNotification.json"] = structuredClone(
          bundle["v2/ItemStartedNotification.json"] as JsonSchema,
        );
        const schema = bundle["v2/ItemStartedNotification.json"] as {
          properties: Record<string, unknown>;
        };
        schema.properties.item = { type: "null" };
      },
    ],
    [
      "agent message deltas",
      "item/agentMessage/delta notification",
      (bundle: Record<string, JsonSchema>) => {
        bundle["v2/AgentMessageDeltaNotification.json"] = structuredClone(
          bundle["v2/AgentMessageDeltaNotification.json"] as JsonSchema,
        );
        const schema = bundle["v2/AgentMessageDeltaNotification.json"] as {
          properties: Record<string, unknown>;
        };
        schema.properties.delta = { type: "integer" };
      },
    ],
    [
      "current approval IDs",
      "command approval parameters",
      (bundle: Record<string, JsonSchema>) => {
        const schema = bundle["CommandExecutionRequestApprovalParams.json"] as {
          properties: Record<string, unknown>;
        };
        schema.properties.itemId = { type: "integer" };
      },
    ],
    [
      "legacy approval commands",
      "legacy exec approval parameters",
      (bundle: Record<string, JsonSchema>) => {
        const schema = bundle["ExecCommandApprovalParams.json"] as {
          properties: Record<string, unknown>;
        };
        schema.properties.command = { type: "object" };
      },
    ],
    [
      "permission grant network fields",
      "permission approval grant",
      (bundle: Record<string, JsonSchema>) => {
        const schema = bundle["PermissionsRequestApprovalResponse.json"] as {
          definitions: { NetworkPermissions: { properties: Record<string, unknown> } };
        };
        schema.definitions.NetworkPermissions.properties.enabled = { type: "string" };
      },
    ],
    [
      "dynamic tool names",
      "dynamic tool call parameters",
      (bundle: Record<string, JsonSchema>) => {
        const schema = bundle["DynamicToolCallParams.json"] as {
          properties: Record<string, unknown>;
        };
        schema.properties.tool = { type: "integer" };
      },
    ],
    [
      "dynamic tool result containers",
      "dynamic tool call response",
      (bundle: Record<string, JsonSchema>) => {
        const schema = bundle["DynamicToolCallResponse.json"] as {
          properties: Record<string, unknown>;
        };
        schema.properties.contentItems = { type: "object" };
      },
    ],
    [
      "dynamic tool success flags",
      "dynamic tool call response",
      (bundle: Record<string, JsonSchema>) => {
        const schema = bundle["DynamicToolCallResponse.json"] as {
          properties: Record<string, unknown>;
        };
        schema.properties.success = { type: "null" };
      },
    ],
    [
      "protocol error fields",
      "error response envelope",
      (bundle: Record<string, JsonSchema>) => {
        const schema = bundle["JSONRPCError.json"] as {
          properties: { error: { properties: Record<string, unknown> } };
        };
        schema.properties.error.properties.code = { type: "string" };
      },
    ],
  ])("rejects incompatible %s", async (_group, contract, mutate) => {
    await expectIncompatible(mutate, contract);
  });

  it("removes its generated bundle when Codex schema generation fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-protocol-process-test-"));
    temporaryDirectories.push(directory);
    const executable = join(directory, "fake-codex");
    await writeFile(
      executable,
      `#!/usr/bin/env node
if (process.argv[2] === "--version") {
  process.stdout.write("codex-cli 0.145.0\\n");
} else {
  process.exitCode = 1;
}
`,
    );
    await chmod(executable, 0o700);

    await expect(
      checkInstalledCodexProtocol({ codexPath: executable, tempParent: directory }),
    ).rejects.toMatchObject({ code: "CONFIGURATION" });
    await expect(readdir(directory)).resolves.toEqual(["fake-codex"]);
  });

  it("reports timeout even when the child exits zero after SIGTERM", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-protocol-timeout-test-"));
    temporaryDirectories.push(directory);
    const executable = join(directory, "fake-codex");
    await writeFile(
      executable,
      `#!/usr/bin/env node
if (process.argv[2] === "--version") {
  process.stdout.write("codex-cli 0.145.0\\n");
} else {
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
}
`,
    );
    await chmod(executable, 0o700);

    await expect(
      checkInstalledCodexProtocol({
        codexPath: executable,
        tempParent: directory,
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    await expect(readdir(directory)).resolves.toEqual(["fake-codex"]);
  });

  it("bounds timeout settlement when the child ignores SIGTERM", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-protocol-timeout-test-"));
    temporaryDirectories.push(directory);
    const executable = join(directory, "fake-codex");
    await writeFile(
      executable,
      `#!/usr/bin/env node
if (process.argv[2] === "--version") {
  process.stdout.write("codex-cli 0.145.0\\n");
} else {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}
`,
    );
    await chmod(executable, 0o700);

    await expect(
      checkInstalledCodexProtocol({
        codexPath: executable,
        tempParent: directory,
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    await expect(readdir(directory)).resolves.toEqual(["fake-codex"]);
  });

  it("shares one retained output cap across checker stdout and stderr", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-protocol-output-test-"));
    temporaryDirectories.push(directory);
    const executable = join(directory, "fake-codex");
    await writeFile(
      executable,
      `#!/usr/bin/env node
if (process.argv[2] === "--version") {
  process.stdout.write("codex-cli 0.145.0\\n");
} else {
  process.stdout.write("o".repeat(40));
  process.stderr.write("e".repeat(40));
}
`,
    );
    await chmod(executable, 0o700);

    await expect(
      checkInstalledCodexProtocol({
        codexPath: executable,
        maxOutputBytes: 64,
        tempParent: directory,
      }),
    ).rejects.toMatchObject({
      code: "CONFIGURATION",
      message: expect.stringContaining("too much output"),
    });
    await expect(readdir(directory)).resolves.toEqual(["fake-codex"]);
  });

  it.each([
    ["timeoutMs", Number.NaN],
    ["timeoutMs", Number.POSITIVE_INFINITY],
    ["timeoutMs", 0],
    ["timeoutMs", -1],
    ["timeoutMs", 1.5],
    ["timeoutMs", Number.MAX_SAFE_INTEGER + 1],
    ["maxOutputBytes", Number.NaN],
    ["maxOutputBytes", Number.POSITIVE_INFINITY],
    ["maxOutputBytes", 0],
    ["maxOutputBytes", -1],
    ["maxOutputBytes", 1.5],
    ["maxOutputBytes", Number.MAX_SAFE_INTEGER + 1],
  ])("rejects invalid checker option %s=%s before creating a bundle", async (key, value) => {
    const directory = await mkdtemp(join(tmpdir(), "codex-protocol-option-test-"));
    temporaryDirectories.push(directory);

    await expect(
      checkInstalledCodexProtocol({ tempParent: directory, [key]: value }),
    ).rejects.toMatchObject({ code: "CONFIGURATION" });
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it("rejects a missing thread/read request", async () => {
    await expectIncompatible((bundle) => {
      const schema = bundle["ClientRequest.json"] as { oneOf: JsonSchema[] };
      schema.oneOf = schema.oneOf.filter(
        (entry) =>
          (entry.properties as Record<string, { enum: string[] }>).method?.enum[0] !==
          "thread/read",
      );
    }, "client request thread/read");
  });

  it("rejects a missing thread/inject_items request", async () => {
    await expectIncompatible((bundle) => {
      const schema = bundle["ClientRequest.json"] as { oneOf: JsonSchema[] };
      schema.oneOf = schema.oneOf.filter(
        (entry) =>
          (entry.properties as Record<string, { enum: string[] }>).method?.enum[0] !==
          "thread/inject_items",
      );
    }, "client request thread/inject_items");
  });

  it("rejects a missing permission approval request", async () => {
    await expectIncompatible((bundle) => {
      const schema = bundle["ServerRequest.json"] as { oneOf: JsonSchema[] };
      schema.oneOf = schema.oneOf.filter(
        (entry) =>
          (entry.properties as Record<string, { enum: string[] }>).method?.enum[0] !==
          "item/permissions/requestApproval",
      );
    }, "server request item/permissions/requestApproval");
  });

  it("rejects a missing dynamic tool call", async () => {
    await expectIncompatible((bundle) => {
      delete bundle["DynamicToolCallParams.json"];
    }, "dynamic tool call parameters");
  });

  it("rejects command approvals without command display context", async () => {
    await expectIncompatible((bundle) => {
      const schema = bundle["CommandExecutionRequestApprovalParams.json"] as {
        properties: Record<string, unknown>;
      };
      delete schema.properties.command;
    }, "command approval parameters");
  });

  it("rejects permission approvals without typed environment metadata", async () => {
    await expectIncompatible((bundle) => {
      const schema = bundle["PermissionsRequestApprovalParams.json"] as {
        properties: Record<string, unknown>;
      };
      delete schema.properties.environmentId;
    }, "permission approval parameters");
  });

  it("rejects legacy exec approvals without typed parsed commands", async () => {
    await expectIncompatible((bundle) => {
      const schema = bundle["ExecCommandApprovalParams.json"] as {
        properties: { parsedCmd: { items?: unknown } };
      };
      delete schema.properties.parsedCmd.items;
    }, "legacy exec approval parameters");
  });

  it("rejects legacy patch approvals without typed file changes", async () => {
    await expectIncompatible((bundle) => {
      const schema = bundle["ApplyPatchApprovalParams.json"] as {
        properties: { fileChanges: { additionalProperties?: unknown } };
      };
      delete schema.properties.fileChanges.additionalProperties;
    }, "legacy patch approval parameters");
  });

  it.each([
    ["CommandExecutionRequestApprovalParams.json", "environmentId", "command approval parameters"],
    ["FileChangeRequestApprovalParams.json", "grantRoot", "file approval parameters"],
    ["PermissionsRequestApprovalParams.json", "environmentId", "permission approval parameters"],
    ["ExecCommandApprovalParams.json", "approvalId", "legacy exec approval parameters"],
    ["ApplyPatchApprovalParams.json", "grantRoot", "legacy patch approval parameters"],
  ])("rejects %s when optional %s is made mandatory", async (path, field, contract) => {
    await expectIncompatible((bundle) => {
      const schema = bundle[path] as { required: string[] };
      schema.required.push(field);
    }, contract);
  });

  it.each([
    ["network approval hosts", "NetworkApprovalContext", 0, "host"],
    ["read command names", "CommandAction", 0, "name"],
    ["network amendment hosts", "NetworkPolicyAmendment", 0, "host"],
  ])("rejects unconstrained command approval %s", async (_name, definition, branch, field) => {
    await expectIncompatible((bundle) => {
      const schema = bundle["CommandExecutionRequestApprovalParams.json"] as {
        definitions: Record<
          string,
          {
            oneOf?: Array<{ properties: Record<string, unknown> }>;
            properties?: Record<string, unknown>;
          }
        >;
      };
      const target = schema.definitions[definition];
      const properties = target?.oneOf?.[branch]?.properties ?? target?.properties;
      if (properties !== undefined) {
        properties[field] = true;
      }
    }, "command approval parameters");
  });

  it("rejects unconstrained permission grant filesystem paths", async () => {
    await expectIncompatible((bundle) => {
      const schema = bundle["PermissionsRequestApprovalResponse.json"] as {
        definitions: { FileSystemPath: { oneOf: Array<{ properties: Record<string, unknown> }> } };
      };
      const pathBranch = schema.definitions.FileSystemPath.oneOf[0];
      if (pathBranch === undefined) {
        throw new Error("missing fake filesystem path branch");
      }
      pathBranch.properties.path = true;
    }, "permission approval grant");
  });

  it("rejects dynamic tool results without typed content items", async () => {
    await expectIncompatible((bundle) => {
      const schema = bundle["DynamicToolCallResponse.json"] as {
        properties: Record<string, { items?: unknown }>;
      };
      delete schema.properties.contentItems?.items;
    }, "dynamic tool call response");
  });

  it("rejects permission grants without network enablement", async () => {
    await expectIncompatible((bundle) => {
      const schema = bundle["PermissionsRequestApprovalResponse.json"] as {
        definitions: { NetworkPermissions: { properties: Record<string, unknown> } };
      };
      delete schema.definitions.NetworkPermissions.properties.enabled;
    }, "permission approval grant");
  });

  it("rejects a success envelope with an error arm", async () => {
    await expectIncompatible((bundle) => {
      const schema = bundle["JSONRPCResponse.json"] as {
        required: string[];
        properties: Record<string, unknown>;
      };
      schema.required.push("error");
      schema.properties.error = { type: "object" };
    }, "success response envelope");
  });

  it("rejects an error envelope with a mandatory jsonrpc member", async () => {
    await expectIncompatible((bundle) => {
      const schema = bundle["JSONRPCError.json"] as {
        required: string[];
        properties: Record<string, unknown>;
      };
      schema.required.push("jsonrpc");
      schema.properties.jsonrpc = { enum: ["2.0"] };
    }, "error response envelope");
  });

  it("rejects incorrect current approval decisions", async () => {
    await expectIncompatible((bundle) => {
      const schema = bundle["FileChangeRequestApprovalResponse.json"] as {
        definitions: { Decision: { oneOf: Array<{ enum: string[] }> } };
      };
      schema.definitions.Decision.oneOf[1] = { enum: ["approveForSession"] };
    }, "current approval decisions");
  });

  it("rejects incorrect legacy approval decisions", async () => {
    await expectIncompatible((bundle) => {
      const schema = bundle["ExecCommandApprovalResponse.json"] as {
        definitions: { ReviewDecision: { oneOf: Array<{ enum?: string[] }> } };
      };
      schema.definitions.ReviewDecision.oneOf = schema.definitions.ReviewDecision.oneOf.filter(
        (entry) => entry.enum?.[0] !== "abort",
      );
    }, "legacy approval decisions");
  });

  it("rejects request IDs that support only one type", async () => {
    await expectIncompatible((bundle) => {
      bundle["RequestId.json"] = { type: "string" };
    }, "request ID string-or-number support");
  });

  it("rejects a thread/list request without a cursor", async () => {
    await expectIncompatible((bundle) => {
      const schema = bundle["v2/ThreadListParams.json"] as {
        properties: Record<string, unknown>;
      };
      delete schema.properties.cursor;
    }, "thread/list cursor");
  });

  it("rejects a thread/list page without data", async () => {
    await expectIncompatible((bundle) => {
      const schema = bundle["v2/ThreadListResponse.json"] as {
        properties: Record<string, unknown>;
      };
      delete schema.properties.data;
    }, "thread/list page");
  });

  it("rejects a thread/list page without nullable nextCursor", async () => {
    await expectIncompatible((bundle) => {
      const schema = bundle["v2/ThreadListResponse.json"] as {
        properties: Record<string, unknown>;
      };
      schema.properties.nextCursor = { type: "string" };
    }, "thread/list next cursor");
  });
});
