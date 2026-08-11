import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv, type ValidateFunction } from "ajv";
import { BridgeError } from "../domain/errors.js";

type JsonObject = Record<string, unknown>;
type PathSegment = string | number;

interface Mutation {
  path: readonly PathSegment[];
  remove?: true;
  value?: unknown;
}

interface RequestContract {
  method: string;
  schemaPath: string;
  contract: string;
  params: JsonObject;
  requiredParams: readonly string[];
  wrongParams: Readonly<Record<string, unknown>>;
  extraMutations?: readonly Mutation[];
  acceptedParams?: readonly JsonObject[];
}

interface NotificationContract {
  method: string;
  schemaPath: string;
  contract: string;
  params: JsonObject;
  mutations: readonly Mutation[];
}

export interface ProtocolCompatibilityResult {
  compatible: true;
}

export interface InstalledProtocolCompatibilityResult extends ProtocolCompatibilityResult {
  version: string;
}

export interface InstalledProtocolCheckOptions {
  codexPath?: string;
  tempParent?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

const MAX_SCHEMA_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_TIMER_MS = 2_147_483_647;
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const REMEDIATION = "Install a compatible Codex CLI version and rerun npm run protocol:check.";

const THREAD = {
  cliVersion: "0.145.0",
  createdAt: 1,
  cwd: "/tmp",
  ephemeral: false,
  id: "thread-1",
  modelProvider: "openai",
  preview: "",
  sessionId: "session-1",
  source: "appServer",
  status: { type: "idle" },
  turns: [],
  updatedAt: 1,
};

const TURN_IN_PROGRESS = { id: "turn-1", items: [], status: "inProgress" };
const TURN_COMPLETED = { id: "turn-1", items: [], status: "completed" };
const THREAD_ITEM = { id: "item-1", text: "hello", type: "agentMessage" };
const COMMAND_EXECUTION_ITEM = {
  command: "npm test",
  commandActions: [],
  cwd: "/tmp",
  id: "command-1",
  status: "completed",
  type: "commandExecution",
};
const FILE_CHANGE_ITEM = {
  changes: [{ diff: "@@", kind: { type: "update" }, path: "/tmp/example.ts" }],
  id: "file-1",
  status: "completed",
  type: "fileChange",
};
const MCP_TOOL_CALL_ITEM = {
  arguments: {},
  id: "mcp-1",
  server: "github",
  status: "completed",
  tool: "search",
  type: "mcpToolCall",
};
const DYNAMIC_TOOL_CALL_ITEM = {
  arguments: {},
  id: "dynamic-1",
  namespace: null,
  status: "completed",
  tool: "imagegen",
  type: "dynamicToolCall",
};
const COLLAB_AGENT_TOOL_CALL_ITEM = {
  agentsStates: {},
  id: "collab-1",
  receiverThreadIds: ["thread-2"],
  senderThreadId: "thread-1",
  status: "completed",
  tool: "spawnAgent",
  type: "collabAgentToolCall",
};
const SUB_AGENT_ACTIVITY_ITEM = {
  agentPath: "agent",
  agentThreadId: "thread-2",
  id: "sub-agent-1",
  kind: "started",
  type: "subAgentActivity",
};
const WEB_SEARCH_ITEM = {
  id: "web-1",
  query: "Codex App Server",
  type: "webSearch",
};
const PERMISSION_PROFILE = {
  fileSystem: {
    entries: [{ access: "read", path: { type: "path", path: "/tmp" } }],
    globScanMaxDepth: 1,
    read: ["/tmp"],
    write: ["/tmp"],
  },
  network: { enabled: true },
};
const INITIALIZE_RESULT = {
  codexHome: "/tmp/codex",
  platformFamily: "unix",
  platformOs: "macos",
  userAgent: "codex-cli/0.145.0",
};
const CONFIGURED_THREAD_RESULT = {
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  cwd: "/tmp",
  model: "gpt-5",
  modelProvider: "openai",
  sandbox: { type: "workspaceWrite" },
  thread: THREAD,
};
const THREAD_READ_RESULT = { thread: THREAD };
const THREAD_LIST_RESULT = { data: [THREAD] };
const MODEL_LIST_RESULT = {
  data: [
    {
      defaultReasoningEffort: "low",
      description: "Frontier agentic coding model",
      displayName: "GPT-5.6 Sol",
      hidden: false,
      id: "gpt-5.6-sol-id",
      isDefault: true,
      model: "gpt-5.6-sol",
      supportedReasoningEfforts: [
        { description: "Fast", reasoningEffort: "low" },
        { description: "Deeper", reasoningEffort: "high" },
      ],
    },
  ],
};
const TURN_START_RESULT = { turn: TURN_IN_PROGRESS };
const SUCCESS_ENVELOPE = { id: 1, result: {} };
const ERROR_ENVELOPE = { id: "request-1", error: { code: -32_601, message: "failed" } };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function incompatible(contract: string): never {
  throw new BridgeError(
    "CONFIGURATION",
    `Codex App Server protocol is incompatible: ${contract}.`,
    REMEDIATION,
  );
}

function operationalIncompatible(contract: string, cause: unknown): never {
  throw new BridgeError(
    "CONFIGURATION",
    `Codex App Server protocol is incompatible: ${contract}.`,
    REMEDIATION,
    { cause },
  );
}

function requirePositiveSafeInteger(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new BridgeError(
      "CONFIGURATION",
      `Codex protocol checker option ${name} is invalid.`,
      "Use a positive safe integer within the supported bound.",
    );
  }
  return value;
}

async function readSchema(
  bundleDirectory: string,
  relativePath: string,
  contract: string,
): Promise<JsonObject> {
  const path = join(bundleDirectory, relativePath);
  let source: string;
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > MAX_SCHEMA_BYTES) {
      incompatible(contract);
    }
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof BridgeError) {
      throw error;
    }
    operationalIncompatible(contract, error);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    incompatible(contract);
  }
  if (!isObject(parsed)) {
    incompatible(contract);
  }
  return parsed;
}

function compileSchema(schema: JsonObject, contract: string): ValidateFunction {
  const ajv = new Ajv({
    allErrors: true,
    allowUnionTypes: true,
    coerceTypes: false,
    removeAdditional: false,
    strictNumbers: true,
    strictRequired: false,
    strictSchema: false,
    strictTuples: false,
    strictTypes: false,
    useDefaults: false,
    validateFormats: false,
    validateSchema: true,
  });
  try {
    return ajv.compile(schema);
  } catch {
    incompatible(`${contract} schema references`);
  }
}

async function readValidator(
  bundleDirectory: string,
  relativePath: string,
  contract: string,
): Promise<ValidateFunction> {
  return compileSchema(await readSchema(bundleDirectory, relativePath, contract), contract);
}

function assertAccepts(validate: ValidateFunction, value: unknown, contract: string): void {
  if (!validationResult(validate, value, contract)) {
    incompatible(contract);
  }
}

function assertRejects(validate: ValidateFunction, value: unknown, contract: string): void {
  if (validationResult(validate, value, contract)) {
    incompatible(contract);
  }
}

function validationResult(validate: ValidateFunction, value: unknown, contract: string): boolean {
  let result: boolean | Promise<unknown>;
  try {
    result = validate(value);
  } catch {
    incompatible(contract);
  }
  if (typeof result !== "boolean") {
    incompatible(contract);
  }
  return result;
}

function parentAt(
  value: unknown,
  path: readonly PathSegment[],
): [JsonObject | unknown[], PathSegment] {
  if (path.length === 0) {
    throw new Error("Mutation path cannot be empty");
  }
  let current: unknown = value;
  for (const segment of path.slice(0, -1)) {
    if (typeof segment === "number" && Array.isArray(current)) {
      current = current[segment];
    } else if (typeof segment === "string" && isObject(current)) {
      current = current[segment];
    } else {
      throw new Error("Mutation path does not exist");
    }
  }
  if (!isObject(current) && !Array.isArray(current)) {
    throw new Error("Mutation parent is not a container");
  }
  return [current, path[path.length - 1] as PathSegment];
}

function mutate<T>(witness: T, mutation: Mutation): T {
  const changed = structuredClone(witness);
  const [parent, key] = parentAt(changed, mutation.path);
  if (mutation.remove === true) {
    if (Array.isArray(parent) && typeof key === "number") {
      parent.splice(key, 1);
    } else if (isObject(parent) && typeof key === "string") {
      delete parent[key];
    }
  } else if (Array.isArray(parent) && typeof key === "number") {
    parent[key] = mutation.value;
  } else if (isObject(parent) && typeof key === "string") {
    parent[key] = mutation.value;
  }
  return changed;
}

function verifyWitness(
  validate: ValidateFunction,
  witness: unknown,
  mutations: readonly Mutation[],
  contract: string,
): void {
  assertAccepts(validate, witness, contract);
  for (const mutation of mutations) {
    assertRejects(validate, mutate(witness, mutation), contract);
  }
}

function removed(...path: PathSegment[]): Mutation {
  return { path, remove: true };
}

function replaced(value: unknown, ...path: PathSegment[]): Mutation {
  return { path, value };
}

function fieldMutations(
  required: readonly string[],
  wrong: Readonly<Record<string, unknown>>,
  prefix: readonly PathSegment[] = [],
): Mutation[] {
  return [
    ...required.map((field) => removed(...prefix, field)),
    ...Object.entries(wrong).map(([field, value]) => replaced(value, ...prefix, field)),
  ];
}

function requestEnvelopeMutations(contract: RequestContract): Mutation[] {
  const requiredWrongParams = Object.fromEntries(
    Object.entries(contract.wrongParams).filter(([field]) =>
      contract.requiredParams.includes(field),
    ),
  );
  return [
    removed("id"),
    removed("method"),
    removed("params"),
    replaced(false, "id"),
    replaced(`${contract.method}/wrong`, "method"),
    replaced([], "params"),
    ...fieldMutations(contract.requiredParams, requiredWrongParams, ["params"]),
  ];
}

const INITIALIZE_PARAMS = {
  clientInfo: {
    name: "codex-discord-bridge",
    title: "Codex Discord Bridge",
    version: "0.1.0",
  },
  capabilities: { experimentalApi: true, requestAttestation: false },
};

const THREAD_CONFIGURATION = {
  approvalPolicy: "on-request",
  cwd: "/tmp",
  developerInstructions: "",
  model: "gpt-5",
  permissions: null,
  runtimeWorkspaceRoots: ["/tmp"],
  sandbox: "workspace-write",
  serviceTier: "default",
};

const DISCORD_SEND_FILE_DYNAMIC_TOOL = {
  type: "function",
  name: "discord_send_file",
  description:
    "Attach an existing local file to the Discord message that started the current turn.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string" },
      message: { type: "string" },
    },
  },
};

const THREAD_MATERIALIZATION_ITEMS = [
  {
    type: "message",
    role: "assistant",
    content: [
      {
        type: "output_text",
        text: "Codex Discord Bridge session initialized.",
      },
    ],
  },
];

const NULL_THREAD_CONFIGURATION = {
  approvalPolicy: null,
  cwd: null,
  developerInstructions: null,
  model: null,
  permissions: null,
  runtimeWorkspaceRoots: null,
  sandbox: null,
  serviceTier: null,
};

const TURN_INPUT = [
  { text: "hello", text_elements: [], type: "text" },
  { type: "image", url: "https://example.invalid/image.png" },
  { path: "/tmp/image.png", type: "localImage" },
  { type: "audio", url: "https://example.invalid/audio.wav" },
  { path: "/tmp/audio.wav", type: "localAudio" },
  { name: "review", path: "/tmp/review/SKILL.md", type: "skill" },
  { name: "notes", path: "/tmp/notes.md", type: "mention" },
];

const CLIENT_REQUESTS: readonly RequestContract[] = [
  {
    method: "initialize",
    schemaPath: "v1/InitializeParams.json",
    contract: "initialize client information",
    params: INITIALIZE_PARAMS,
    requiredParams: ["clientInfo"],
    wrongParams: { clientInfo: [], capabilities: [] },
    extraMutations: [
      removed("clientInfo", "name"),
      removed("clientInfo", "version"),
      replaced(1, "clientInfo", "name"),
      replaced(1, "clientInfo", "title"),
      replaced(1, "clientInfo", "version"),
      replaced("yes", "capabilities", "experimentalApi"),
      replaced("no", "capabilities", "requestAttestation"),
    ],
  },
  {
    method: "thread/start",
    schemaPath: "v2/ThreadStartParams.json",
    contract: "thread/start parameters",
    params: {
      ...THREAD_CONFIGURATION,
      dynamicTools: [DISCORD_SEND_FILE_DYNAMIC_TOOL],
      ephemeral: false,
    },
    requiredParams: [],
    wrongParams: {
      approvalPolicy: "sometimes",
      cwd: 1,
      developerInstructions: 1,
      model: 1,
      permissions: 1,
      runtimeWorkspaceRoots: {},
      sandbox: "partial",
      serviceTier: 1,
    },
    extraMutations: [
      replaced(1, "runtimeWorkspaceRoots", 0),
      replaced("false", "ephemeral"),
      replaced({}, "dynamicTools"),
      replaced("future", "dynamicTools", 0, "type"),
      removed("dynamicTools", 0, "name"),
      removed("dynamicTools", 0, "description"),
      removed("dynamicTools", 0, "inputSchema"),
    ],
    acceptedParams: [
      NULL_THREAD_CONFIGURATION,
      {
        ...NULL_THREAD_CONFIGURATION,
        approvalPolicy: "untrusted",
        sandbox: "read-only",
      },
      {
        ...NULL_THREAD_CONFIGURATION,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      },
      {
        ...NULL_THREAD_CONFIGURATION,
        approvalPolicy: {
          granular: {
            mcp_elicitations: true,
            request_permissions: true,
            rules: true,
            sandbox_approval: true,
            skill_approval: true,
          },
        },
      },
    ],
  },
  {
    method: "thread/resume",
    schemaPath: "v2/ThreadResumeParams.json",
    contract: "thread/resume parameters",
    params: { threadId: "thread-1", ...THREAD_CONFIGURATION },
    requiredParams: ["threadId"],
    wrongParams: {
      approvalPolicy: "sometimes",
      cwd: 1,
      developerInstructions: 1,
      model: 1,
      permissions: 1,
      runtimeWorkspaceRoots: {},
      sandbox: "partial",
      serviceTier: 1,
      threadId: 1,
    },
    extraMutations: [replaced(1, "runtimeWorkspaceRoots", 0)],
    acceptedParams: [
      { threadId: "thread-1", ...NULL_THREAD_CONFIGURATION },
      {
        threadId: "thread-1",
        ...NULL_THREAD_CONFIGURATION,
        approvalPolicy: "untrusted",
        sandbox: "read-only",
      },
      {
        threadId: "thread-1",
        ...NULL_THREAD_CONFIGURATION,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      },
    ],
  },
  {
    method: "thread/list",
    schemaPath: "v2/ThreadListParams.json",
    contract: "thread/list cursor",
    params: {
      cursor: null,
      limit: 10,
      sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
    },
    requiredParams: [],
    wrongParams: { cursor: 1, limit: "10" },
    extraMutations: [
      replaced(1.5, "limit"),
      replaced(-1, "limit"),
      replaced({}, "sourceKinds"),
      replaced("future", "sourceKinds", 0),
    ],
    acceptedParams: [{ cursor: "next", limit: null }],
  },
  {
    method: "model/list",
    schemaPath: "v2/ModelListParams.json",
    contract: "model/list parameters",
    params: { cursor: null, includeHidden: true, limit: 100 },
    requiredParams: [],
    wrongParams: { cursor: 1, includeHidden: "true", limit: "100" },
    extraMutations: [replaced(1.5, "limit"), replaced(-1, "limit")],
    acceptedParams: [{ cursor: "next", includeHidden: null, limit: null }],
  },
  {
    method: "thread/read",
    schemaPath: "v2/ThreadReadParams.json",
    contract: "thread/read parameters",
    params: { includeTurns: true, threadId: "thread-1" },
    requiredParams: ["threadId"],
    wrongParams: { includeTurns: "yes", threadId: 1 },
  },
  {
    method: "thread/inject_items",
    schemaPath: "v2/ThreadInjectItemsParams.json",
    contract: "thread/inject_items parameters",
    params: { threadId: "thread-1", items: THREAD_MATERIALIZATION_ITEMS },
    requiredParams: ["threadId", "items"],
    wrongParams: { threadId: 1, items: {} },
  },
  {
    method: "turn/start",
    schemaPath: "v2/TurnStartParams.json",
    contract: "turn/start parameters",
    params: {
      clientUserMessageId: "100",
      effort: "high",
      input: TURN_INPUT,
      model: "gpt-5.6-sol",
      responsesapiClientMetadata: {
        discord_author_id: "300",
        discord_channel_id: "200",
        discord_message_id: "100",
      },
      threadId: "thread-1",
    },
    requiredParams: ["input", "threadId"],
    wrongParams: { effort: [], input: {}, model: 1, threadId: 1 },
    extraMutations: [
      replaced(100, "clientUserMessageId"),
      replaced([], "responsesapiClientMetadata"),
      replaced(100, "responsesapiClientMetadata", "discord_message_id"),
      replaced({}, "input", 0, "text_elements"),
      ...TURN_INPUT.flatMap((input, index) => [
        removed("input", index, "type"),
        replaced("unknown", "input", index, "type"),
        ...Object.keys(input)
          .filter((field) => field !== "type" && field !== "text_elements")
          .flatMap((field) => [removed("input", index, field), replaced(1, "input", index, field)]),
      ]),
    ],
    acceptedParams: [{ input: TURN_INPUT, threadId: "thread-1" }],
  },
  {
    method: "turn/interrupt",
    schemaPath: "v2/TurnInterruptParams.json",
    contract: "turn/interrupt parameters",
    params: { threadId: "thread-1", turnId: "turn-1" },
    requiredParams: ["threadId", "turnId"],
    wrongParams: { threadId: 1, turnId: 1 },
  },
];

const SERVER_REQUESTS: readonly RequestContract[] = [
  {
    method: "item/commandExecution/requestApproval",
    schemaPath: "CommandExecutionRequestApprovalParams.json",
    contract: "command approval parameters",
    params: {
      additionalPermissions: {
        fileSystem: {
          entries: [{ access: "write", path: { path: "/tmp/out", type: "path" } }],
          globScanMaxDepth: 2,
          read: ["/tmp"],
          write: ["/tmp/out"],
        },
        network: { enabled: true },
      },
      approvalId: "approval-1",
      availableDecisions: [
        "accept",
        "acceptForSession",
        {
          acceptWithExecpolicyAmendment: { execpolicy_amendment: ["allow pwd"] },
        },
        {
          applyNetworkPolicyAmendment: {
            network_policy_amendment: { action: "allow", host: "api.openai.com" },
          },
        },
        "decline",
        "cancel",
      ],
      command: "pwd",
      commandActions: [
        { command: "cat file", name: "file", path: "/tmp/file", type: "read" },
        { command: "ls", path: "/tmp", type: "listFiles" },
        { command: "rg x", path: "/tmp", query: "x", type: "search" },
        { command: "custom", type: "unknown" },
      ],
      cwd: "/tmp",
      environmentId: "local",
      itemId: "item-1",
      networkApprovalContext: { host: "api.openai.com", protocol: "https" },
      proposedExecpolicyAmendment: ["allow pwd"],
      proposedNetworkPolicyAmendments: [
        { action: "allow", host: "api.openai.com" },
        { action: "deny", host: "example.invalid" },
      ],
      reason: "required",
      startedAtMs: 1,
      threadId: "thread-1",
      turnId: "turn-1",
    },
    requiredParams: ["itemId", "startedAtMs", "threadId", "turnId"],
    wrongParams: {
      additionalPermissions: [],
      approvalId: 1,
      availableDecisions: {},
      command: 1,
      commandActions: {},
      cwd: [],
      environmentId: 1,
      itemId: 1,
      networkApprovalContext: [],
      proposedExecpolicyAmendment: {},
      proposedNetworkPolicyAmendments: {},
      reason: false,
      startedAtMs: "1",
      threadId: 1,
      turnId: 1,
    },
    extraMutations: [
      removed("networkApprovalContext", "host"),
      replaced(1, "networkApprovalContext", "host"),
      removed("networkApprovalContext", "protocol"),
      replaced("ftp", "networkApprovalContext", "protocol"),
      replaced("yes", "additionalPermissions", "network", "enabled"),
      removed("additionalPermissions", "fileSystem", "entries", 0, "access"),
      removed("additionalPermissions", "fileSystem", "entries", 0, "path"),
      replaced("execute", "additionalPermissions", "fileSystem", "entries", 0, "access"),
      replaced(1, "additionalPermissions", "fileSystem", "entries", 0, "path", "path"),
      ...[0, 1, 2, 3].flatMap((index) => [
        removed("commandActions", index, "command"),
        replaced(1, "commandActions", index, "command"),
        removed("commandActions", index, "type"),
        replaced("execute", "commandActions", index, "type"),
      ]),
      removed("commandActions", 0, "name"),
      replaced(1, "commandActions", 0, "name"),
      removed("commandActions", 0, "path"),
      replaced(1, "commandActions", 0, "path"),
      replaced(1, "commandActions", 1, "path"),
      replaced(1, "commandActions", 2, "path"),
      replaced(1, "commandActions", 2, "query"),
      replaced(1, "proposedExecpolicyAmendment", 0),
      removed("proposedNetworkPolicyAmendments", 0, "action"),
      removed("proposedNetworkPolicyAmendments", 0, "host"),
      replaced("prompt", "proposedNetworkPolicyAmendments", 0, "action"),
      replaced(1, "proposedNetworkPolicyAmendments", 0, "host"),
      replaced("approve", "availableDecisions", 0),
      removed("availableDecisions", 2, "acceptWithExecpolicyAmendment"),
      removed("availableDecisions", 2, "acceptWithExecpolicyAmendment", "execpolicy_amendment"),
      replaced(
        1,
        "availableDecisions",
        2,
        "acceptWithExecpolicyAmendment",
        "execpolicy_amendment",
        0,
      ),
      removed("availableDecisions", 3, "applyNetworkPolicyAmendment"),
      removed("availableDecisions", 3, "applyNetworkPolicyAmendment", "network_policy_amendment"),
      replaced(
        "prompt",
        "availableDecisions",
        3,
        "applyNetworkPolicyAmendment",
        "network_policy_amendment",
        "action",
      ),
      replaced(
        1,
        "availableDecisions",
        3,
        "applyNetworkPolicyAmendment",
        "network_policy_amendment",
        "host",
      ),
    ],
    acceptedParams: [
      {
        additionalPermissions: null,
        approvalId: null,
        availableDecisions: null,
        command: null,
        commandActions: null,
        cwd: null,
        environmentId: null,
        itemId: "item-1",
        networkApprovalContext: null,
        proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: null,
        reason: null,
        startedAtMs: 1,
        threadId: "thread-1",
        turnId: "turn-1",
      },
      {
        itemId: "item-1",
        startedAtMs: 1,
        threadId: "thread-1",
        turnId: "turn-1",
      },
    ],
  },
  {
    method: "item/fileChange/requestApproval",
    schemaPath: "FileChangeRequestApprovalParams.json",
    contract: "file approval parameters",
    params: {
      grantRoot: "/tmp",
      itemId: "item-1",
      reason: "required",
      startedAtMs: 1,
      threadId: "thread-1",
      turnId: "turn-1",
    },
    requiredParams: ["itemId", "startedAtMs", "threadId", "turnId"],
    wrongParams: {
      grantRoot: [],
      itemId: 1,
      reason: false,
      startedAtMs: "1",
      threadId: 1,
      turnId: 1,
    },
    acceptedParams: [
      {
        grantRoot: null,
        itemId: "item-1",
        reason: null,
        startedAtMs: 1,
        threadId: "thread-1",
        turnId: "turn-1",
      },
      { itemId: "item-1", startedAtMs: 1, threadId: "thread-1", turnId: "turn-1" },
    ],
  },
  {
    method: "item/permissions/requestApproval",
    schemaPath: "PermissionsRequestApprovalParams.json",
    contract: "permission approval parameters",
    params: {
      cwd: "/tmp",
      environmentId: "local",
      itemId: "item-1",
      permissions: PERMISSION_PROFILE,
      reason: "required",
      startedAtMs: 1,
      threadId: "thread-1",
      turnId: "turn-1",
    },
    requiredParams: ["cwd", "itemId", "permissions", "startedAtMs", "threadId", "turnId"],
    wrongParams: {
      cwd: [],
      environmentId: 1,
      itemId: 1,
      permissions: [],
      reason: false,
      startedAtMs: "1",
      threadId: 1,
      turnId: 1,
    },
    extraMutations: [
      replaced("yes", "permissions", "network", "enabled"),
      replaced({}, "permissions", "fileSystem", "entries"),
      removed("permissions", "fileSystem", "entries", 0, "access"),
      removed("permissions", "fileSystem", "entries", 0, "path"),
      replaced("execute", "permissions", "fileSystem", "entries", 0, "access"),
      replaced(1, "permissions", "fileSystem", "entries", 0, "path", "path"),
      replaced(0, "permissions", "fileSystem", "globScanMaxDepth"),
      replaced({}, "permissions", "fileSystem", "read"),
      replaced({}, "permissions", "fileSystem", "write"),
    ],
    acceptedParams: [
      {
        cwd: "/tmp",
        environmentId: null,
        itemId: "item-1",
        permissions: { fileSystem: null, network: null },
        reason: null,
        startedAtMs: 1,
        threadId: "thread-1",
        turnId: "turn-1",
      },
      {
        cwd: "/tmp",
        itemId: "item-1",
        permissions: PERMISSION_PROFILE,
        startedAtMs: 1,
        threadId: "thread-1",
        turnId: "turn-1",
      },
    ],
  },
  {
    method: "item/tool/call",
    schemaPath: "DynamicToolCallParams.json",
    contract: "dynamic tool call parameters",
    params: {
      arguments: { query: "hello" },
      callId: "call-1",
      namespace: null,
      threadId: "thread-1",
      tool: "lookup",
      turnId: "turn-1",
    },
    requiredParams: ["arguments", "callId", "threadId", "tool", "turnId"],
    wrongParams: { callId: 1, namespace: 1, threadId: 1, tool: 1, turnId: 1 },
    acceptedParams: [
      {
        arguments: null,
        callId: "call-1",
        namespace: "tools",
        threadId: "thread-1",
        tool: "lookup",
        turnId: "turn-1",
      },
    ],
  },
  {
    method: "execCommandApproval",
    schemaPath: "ExecCommandApprovalParams.json",
    contract: "legacy exec approval parameters",
    params: {
      approvalId: "approval-1",
      callId: "call-1",
      command: ["pwd"],
      conversationId: "thread-1",
      cwd: "/tmp",
      parsedCmd: [
        { cmd: "cat file", name: "file", path: "/tmp/file", type: "read" },
        { cmd: "ls", path: null, type: "list_files" },
        { cmd: "rg x", path: "/tmp", query: "x", type: "search" },
        { cmd: "custom", type: "unknown" },
      ],
      reason: "required",
    },
    requiredParams: ["callId", "command", "conversationId", "cwd", "parsedCmd"],
    wrongParams: {
      approvalId: 1,
      callId: 1,
      command: {},
      conversationId: 1,
      cwd: [],
      parsedCmd: {},
      reason: false,
    },
    extraMutations: [
      replaced(1, "command", 0),
      ...[0, 1, 2, 3].flatMap((index) => [
        removed("parsedCmd", index, "cmd"),
        replaced(1, "parsedCmd", index, "cmd"),
        removed("parsedCmd", index, "type"),
        replaced("execute", "parsedCmd", index, "type"),
      ]),
      removed("parsedCmd", 0, "name"),
      replaced(1, "parsedCmd", 0, "name"),
      removed("parsedCmd", 0, "path"),
      replaced(1, "parsedCmd", 0, "path"),
      replaced(1, "parsedCmd", 1, "path"),
      replaced(1, "parsedCmd", 2, "path"),
      replaced(1, "parsedCmd", 2, "query"),
    ],
    acceptedParams: [
      {
        approvalId: null,
        callId: "call-1",
        command: ["pwd"],
        conversationId: "thread-1",
        cwd: "/tmp",
        parsedCmd: [],
        reason: null,
      },
      {
        callId: "call-1",
        command: ["pwd"],
        conversationId: "thread-1",
        cwd: "/tmp",
        parsedCmd: [],
      },
    ],
  },
  {
    method: "applyPatchApproval",
    schemaPath: "ApplyPatchApprovalParams.json",
    contract: "legacy patch approval parameters",
    params: {
      callId: "call-1",
      conversationId: "thread-1",
      fileChanges: {
        "/tmp/add": { content: "new", type: "add" },
        "/tmp/delete": { content: "old", type: "delete" },
        "/tmp/update": { move_path: null, type: "update", unified_diff: "@@ -1 +1 @@" },
      },
      grantRoot: "/tmp",
      reason: "required",
    },
    requiredParams: ["callId", "conversationId", "fileChanges"],
    wrongParams: {
      callId: 1,
      conversationId: 1,
      fileChanges: [],
      grantRoot: 1,
      reason: false,
    },
    extraMutations: [
      ...["/tmp/add", "/tmp/delete"].flatMap((path) => [
        removed("fileChanges", path, "content"),
        replaced(1, "fileChanges", path, "content"),
        removed("fileChanges", path, "type"),
        replaced("remove", "fileChanges", path, "type"),
      ]),
      removed("fileChanges", "/tmp/update", "unified_diff"),
      replaced(1, "fileChanges", "/tmp/update", "unified_diff"),
      removed("fileChanges", "/tmp/update", "type"),
      replaced("move", "fileChanges", "/tmp/update", "type"),
      replaced(1, "fileChanges", "/tmp/update", "move_path"),
    ],
    acceptedParams: [
      {
        callId: "call-1",
        conversationId: "thread-1",
        fileChanges: {},
        grantRoot: null,
        reason: null,
      },
      { callId: "call-1", conversationId: "thread-1", fileChanges: {} },
    ],
  },
];

const NOTIFICATIONS: readonly NotificationContract[] = [
  {
    method: "turn/started",
    schemaPath: "v2/TurnStartedNotification.json",
    contract: "turn/started notification",
    params: { threadId: "thread-1", turn: TURN_IN_PROGRESS },
    mutations: [
      ...fieldMutations(["threadId", "turn"], { threadId: 1, turn: [] }),
      ...fieldMutations(["id", "items", "status"], { id: 1, items: {}, status: "unknown" }, [
        "turn",
      ]),
    ],
  },
  {
    method: "turn/completed",
    schemaPath: "v2/TurnCompletedNotification.json",
    contract: "turn/completed notification",
    params: { threadId: "thread-1", turn: TURN_COMPLETED },
    mutations: [
      ...fieldMutations(["threadId", "turn"], { threadId: 1, turn: [] }),
      ...fieldMutations(["id", "items", "status"], { id: 1, items: {}, status: "unknown" }, [
        "turn",
      ]),
    ],
  },
  {
    method: "item/started",
    schemaPath: "v2/ItemStartedNotification.json",
    contract: "item/started notification",
    params: { item: THREAD_ITEM, startedAtMs: 1, threadId: "thread-1", turnId: "turn-1" },
    mutations: [
      ...fieldMutations(["item", "startedAtMs", "threadId", "turnId"], {
        item: [],
        startedAtMs: "1",
        threadId: 1,
        turnId: 1,
      }),
      ...fieldMutations(["id", "text", "type"], { id: 1, text: 1, type: "unknown" }, ["item"]),
    ],
  },
  {
    method: "item/completed",
    schemaPath: "v2/ItemCompletedNotification.json",
    contract: "item/completed notification",
    params: { completedAtMs: 1, item: THREAD_ITEM, threadId: "thread-1", turnId: "turn-1" },
    mutations: [
      ...fieldMutations(["completedAtMs", "item", "threadId", "turnId"], {
        completedAtMs: "1",
        item: [],
        threadId: 1,
        turnId: 1,
      }),
      ...fieldMutations(["id", "text", "type"], { id: 1, text: 1, type: "unknown" }, ["item"]),
    ],
  },
  {
    method: "item/completed",
    schemaPath: "v2/ItemCompletedNotification.json",
    contract: "item/completed notification",
    params: {
      completedAtMs: 1,
      item: COMMAND_EXECUTION_ITEM,
      threadId: "thread-1",
      turnId: "turn-1",
    },
    mutations: fieldMutations(
      ["command", "cwd", "status"],
      { command: 1, cwd: 1, status: "unknown" },
      ["item"],
    ),
  },
  {
    method: "item/completed",
    schemaPath: "v2/ItemCompletedNotification.json",
    contract: "item/completed notification",
    params: {
      completedAtMs: 1,
      item: FILE_CHANGE_ITEM,
      threadId: "thread-1",
      turnId: "turn-1",
    },
    mutations: [
      ...fieldMutations(["changes", "status"], { changes: {}, status: "unknown" }, ["item"]),
      replaced(1, "item", "changes", 0, "path"),
      replaced("unknown", "item", "changes", 0, "kind", "type"),
    ],
  },
  {
    method: "item/completed",
    schemaPath: "v2/ItemCompletedNotification.json",
    contract: "item/completed notification",
    params: {
      completedAtMs: 1,
      item: MCP_TOOL_CALL_ITEM,
      threadId: "thread-1",
      turnId: "turn-1",
    },
    mutations: fieldMutations(
      ["server", "status", "tool"],
      { server: 1, status: "unknown", tool: 1 },
      ["item"],
    ),
  },
  {
    method: "item/completed",
    schemaPath: "v2/ItemCompletedNotification.json",
    contract: "item/completed notification",
    params: {
      completedAtMs: 1,
      item: DYNAMIC_TOOL_CALL_ITEM,
      threadId: "thread-1",
      turnId: "turn-1",
    },
    mutations: fieldMutations(["status", "tool"], { namespace: 1, status: "unknown", tool: 1 }, [
      "item",
    ]),
  },
  {
    method: "item/completed",
    schemaPath: "v2/ItemCompletedNotification.json",
    contract: "item/completed notification",
    params: {
      completedAtMs: 1,
      item: COLLAB_AGENT_TOOL_CALL_ITEM,
      threadId: "thread-1",
      turnId: "turn-1",
    },
    mutations: fieldMutations(["status", "tool"], { status: "unknown", tool: "unknown" }, ["item"]),
  },
  {
    method: "item/completed",
    schemaPath: "v2/ItemCompletedNotification.json",
    contract: "item/completed notification",
    params: {
      completedAtMs: 1,
      item: SUB_AGENT_ACTIVITY_ITEM,
      threadId: "thread-1",
      turnId: "turn-1",
    },
    mutations: fieldMutations(
      ["agentPath", "agentThreadId", "kind"],
      { agentPath: 1, agentThreadId: 1, kind: "unknown" },
      ["item"],
    ),
  },
  {
    method: "item/completed",
    schemaPath: "v2/ItemCompletedNotification.json",
    contract: "item/completed notification",
    params: {
      completedAtMs: 1,
      item: WEB_SEARCH_ITEM,
      threadId: "thread-1",
      turnId: "turn-1",
    },
    mutations: fieldMutations(["query"], { query: 1 }, ["item"]),
  },
  {
    method: "item/agentMessage/delta",
    schemaPath: "v2/AgentMessageDeltaNotification.json",
    contract: "item/agentMessage/delta notification",
    params: { delta: "hello", itemId: "item-1", threadId: "thread-1", turnId: "turn-1" },
    mutations: fieldMutations(["delta", "itemId", "threadId", "turnId"], {
      delta: 1,
      itemId: 1,
      threadId: 1,
      turnId: 1,
    }),
  },
  {
    method: "turn/plan/updated",
    schemaPath: "v2/TurnPlanUpdatedNotification.json",
    contract: "turn plan update notification",
    params: {
      explanation: null,
      plan: [{ status: "inProgress", step: "Implement progress reporting" }],
      threadId: "thread-1",
      turnId: "turn-1",
    },
    mutations: [
      ...fieldMutations(["plan", "threadId", "turnId"], {
        explanation: 1,
        plan: {},
        threadId: 1,
        turnId: 1,
      }),
      ...fieldMutations(["status", "step"], { status: "unknown", step: 1 }, ["plan", 0]),
    ],
  },
  {
    method: "turn/diff/updated",
    schemaPath: "v2/TurnDiffUpdatedNotification.json",
    contract: "turn diff update notification",
    params: { diff: "@@ -1 +1 @@", threadId: "thread-1", turnId: "turn-1" },
    mutations: fieldMutations(["diff", "threadId", "turnId"], {
      diff: 1,
      threadId: 1,
      turnId: 1,
    }),
  },
  {
    method: "item/reasoning/summaryTextDelta",
    schemaPath: "v2/ReasoningSummaryTextDeltaNotification.json",
    contract: "reasoning summary text delta notification",
    params: {
      delta: "Inspecting the runtime.",
      itemId: "item-1",
      summaryIndex: 0,
      threadId: "thread-1",
      turnId: "turn-1",
    },
    mutations: fieldMutations(["delta", "itemId", "summaryIndex", "threadId", "turnId"], {
      delta: 1,
      itemId: 1,
      summaryIndex: "0",
      threadId: 1,
      turnId: 1,
    }),
  },
  {
    method: "item/reasoning/summaryPartAdded",
    schemaPath: "v2/ReasoningSummaryPartAddedNotification.json",
    contract: "reasoning summary part notification",
    params: {
      itemId: "item-1",
      summaryIndex: 0,
      threadId: "thread-1",
      turnId: "turn-1",
    },
    mutations: fieldMutations(["itemId", "summaryIndex", "threadId", "turnId"], {
      itemId: 1,
      summaryIndex: "0",
      threadId: 1,
      turnId: 1,
    }),
  },
  {
    method: "item/commandExecution/outputDelta",
    schemaPath: "v2/CommandExecutionOutputDeltaNotification.json",
    contract: "command output delta notification",
    params: {
      delta: "tests passed",
      itemId: "command-1",
      threadId: "thread-1",
      turnId: "turn-1",
    },
    mutations: fieldMutations(["delta", "itemId", "threadId", "turnId"], {
      delta: 1,
      itemId: 1,
      threadId: 1,
      turnId: 1,
    }),
  },
  {
    method: "warning",
    schemaPath: "v2/WarningNotification.json",
    contract: "warning notification",
    params: { message: "Context is almost full.", threadId: null },
    mutations: [...fieldMutations(["message"], { message: 1 }), replaced(1, "threadId")],
  },
  {
    method: "error",
    schemaPath: "v2/ErrorNotification.json",
    contract: "error notification",
    params: {
      error: { message: "failed" },
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry: false,
    },
    mutations: [
      ...fieldMutations(["error", "threadId", "turnId", "willRetry"], {
        error: [],
        threadId: 1,
        turnId: 1,
        willRetry: "no",
      }),
      removed("error", "message"),
      replaced(1, "error", "message"),
    ],
  },
];

export const CANONICAL_INBOUND_WIRE_WITNESSES = Object.freeze({
  clientResults: Object.freeze({
    initialize: INITIALIZE_RESULT,
    "thread/start": CONFIGURED_THREAD_RESULT,
    "thread/resume": CONFIGURED_THREAD_RESULT,
    "thread/list": THREAD_LIST_RESULT,
    "model/list": MODEL_LIST_RESULT,
    "thread/read": THREAD_READ_RESULT,
    "thread/inject_items": {},
    "turn/start": TURN_START_RESULT,
    "turn/interrupt": {},
  }),
  responseEnvelopes: Object.freeze({ error: ERROR_ENVELOPE, success: SUCCESS_ENVELOPE }),
  serverNotifications: Object.freeze(
    Object.fromEntries(NOTIFICATIONS.map(({ method, params }) => [method, params])),
  ),
  serverRequests: Object.freeze(
    Object.fromEntries(SERVER_REQUESTS.map(({ method, params }) => [method, params])),
  ),
});

async function checkRequestContracts(bundleDirectory: string): Promise<void> {
  const aggregate = await readValidator(
    bundleDirectory,
    "ClientRequest.json",
    "client request definitions",
  );
  for (const contract of CLIENT_REQUESTS) {
    const envelope = { id: 1, method: contract.method, params: contract.params };
    verifyWitness(
      aggregate,
      envelope,
      requestEnvelopeMutations(contract),
      `client request ${contract.method}`,
    );
    assertAccepts(aggregate, { ...envelope, id: "request-1" }, `client request ${contract.method}`);
    for (const acceptedParams of contract.acceptedParams ?? []) {
      assertAccepts(
        aggregate,
        { ...envelope, params: acceptedParams },
        `client request ${contract.method}`,
      );
    }

    const params = await readValidator(bundleDirectory, contract.schemaPath, contract.contract);
    verifyWitness(
      params,
      contract.params,
      [
        ...fieldMutations(contract.requiredParams, contract.wrongParams),
        ...(contract.extraMutations ?? []),
      ],
      contract.contract,
    );
    for (const acceptedParams of contract.acceptedParams ?? []) {
      assertAccepts(params, acceptedParams, contract.contract);
    }
  }

  const initializeResponse = await readValidator(
    bundleDirectory,
    "v1/InitializeResponse.json",
    "initialize response",
  );
  verifyWitness(
    initializeResponse,
    INITIALIZE_RESULT,
    fieldMutations(Object.keys(INITIALIZE_RESULT), {
      codexHome: 1,
      platformFamily: 1,
      platformOs: 1,
      userAgent: 1,
    }),
    "initialize response",
  );

  for (const [path, contract, result] of [
    ["v2/ThreadStartResponse.json", "thread/start response", CONFIGURED_THREAD_RESULT],
    ["v2/ThreadResumeResponse.json", "thread/resume response", CONFIGURED_THREAD_RESULT],
    ["v2/ThreadReadResponse.json", "thread/read response", THREAD_READ_RESULT],
  ] as const) {
    const validate = await readValidator(bundleDirectory, path, contract);
    verifyWitness(
      validate,
      result,
      [removed("thread"), replaced([], "thread"), replaced(1, "thread", "id")],
      contract,
    );
  }

  const threadList = await readValidator(
    bundleDirectory,
    "v2/ThreadListResponse.json",
    "thread/list page",
  );
  verifyWitness(
    threadList,
    THREAD_LIST_RESULT,
    [removed("data"), replaced({}, "data"), replaced(1, "data", 0, "id")],
    "thread/list page",
  );
  assertAccepts(threadList, { ...THREAD_LIST_RESULT, nextCursor: null }, "thread/list next cursor");
  assertAccepts(
    threadList,
    { ...THREAD_LIST_RESULT, nextCursor: "next" },
    "thread/list next cursor",
  );
  assertRejects(threadList, { ...THREAD_LIST_RESULT, nextCursor: 1 }, "thread/list next cursor");

  const modelList = await readValidator(
    bundleDirectory,
    "v2/ModelListResponse.json",
    "model/list response",
  );
  verifyWitness(
    modelList,
    MODEL_LIST_RESULT,
    [
      removed("data"),
      replaced({}, "data"),
      ...fieldMutations(
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
          defaultReasoningEffort: 1,
          description: 1,
          displayName: 1,
          hidden: "false",
          id: 1,
          isDefault: "true",
          model: 1,
          supportedReasoningEfforts: {},
        },
        ["data", 0],
      ),
      ...fieldMutations(
        ["description", "reasoningEffort"],
        { description: 1, reasoningEffort: 1 },
        ["data", 0, "supportedReasoningEfforts", 0],
      ),
    ],
    "model/list response",
  );
  assertAccepts(modelList, { ...MODEL_LIST_RESULT, nextCursor: null }, "model/list response");
  assertAccepts(modelList, { ...MODEL_LIST_RESULT, nextCursor: "next" }, "model/list response");
  assertRejects(modelList, { ...MODEL_LIST_RESULT, nextCursor: 1 }, "model/list response");

  const turnStart = await readValidator(
    bundleDirectory,
    "v2/TurnStartResponse.json",
    "turn/start response",
  );
  verifyWitness(
    turnStart,
    TURN_START_RESULT,
    [
      removed("turn"),
      replaced([], "turn"),
      ...fieldMutations(["id", "items", "status"], { id: 1, items: {}, status: "unknown" }, [
        "turn",
      ]),
    ],
    "turn/start response",
  );

  const interrupt = await readValidator(
    bundleDirectory,
    "v2/TurnInterruptResponse.json",
    "turn/interrupt response",
  );
  assertAccepts(interrupt, {}, "turn/interrupt response");

  const injectItems = await readValidator(
    bundleDirectory,
    "v2/ThreadInjectItemsResponse.json",
    "thread/inject_items response",
  );
  assertAccepts(injectItems, {}, "thread/inject_items response");
}

async function checkNotificationContracts(bundleDirectory: string): Promise<void> {
  const clientNotifications = await readValidator(
    bundleDirectory,
    "ClientNotification.json",
    "client notification definitions",
  );
  verifyWitness(
    clientNotifications,
    { method: "initialized" },
    [removed("method"), replaced("initialized/wrong", "method")],
    "client notification initialized",
  );

  const serverNotifications = await readValidator(
    bundleDirectory,
    "ServerNotification.json",
    "server notification definitions",
  );
  for (const notification of NOTIFICATIONS) {
    const envelope = { method: notification.method, params: notification.params };
    verifyWitness(
      serverNotifications,
      envelope,
      [
        removed("method"),
        removed("params"),
        replaced(`${notification.method}/wrong`, "method"),
        replaced([], "params"),
        ...notification.mutations.map((mutation) => ({
          ...mutation,
          path: ["params", ...mutation.path],
        })),
      ],
      `server notification ${notification.method}`,
    );

    const params = await readValidator(
      bundleDirectory,
      notification.schemaPath,
      notification.contract,
    );
    verifyWitness(params, notification.params, notification.mutations, notification.contract);
  }
}

async function checkServerRequestContracts(bundleDirectory: string): Promise<void> {
  const aggregate = await readValidator(
    bundleDirectory,
    "ServerRequest.json",
    "server request definitions",
  );
  for (const contract of SERVER_REQUESTS) {
    const envelope = { id: 1, method: contract.method, params: contract.params };
    verifyWitness(
      aggregate,
      envelope,
      requestEnvelopeMutations(contract),
      `server request ${contract.method}`,
    );
    assertAccepts(aggregate, { ...envelope, id: "request-1" }, `server request ${contract.method}`);
    for (const acceptedParams of contract.acceptedParams ?? []) {
      assertAccepts(
        aggregate,
        { ...envelope, params: acceptedParams },
        `server request ${contract.method}`,
      );
    }

    const params = await readValidator(bundleDirectory, contract.schemaPath, contract.contract);
    verifyWitness(
      params,
      contract.params,
      [
        ...fieldMutations(contract.requiredParams, contract.wrongParams),
        ...(contract.extraMutations ?? []),
      ],
      contract.contract,
    );
    for (const acceptedParams of contract.acceptedParams ?? []) {
      assertAccepts(params, acceptedParams, contract.contract);
    }
  }
}

async function checkApprovalAndToolResponses(bundleDirectory: string): Promise<void> {
  for (const path of [
    "CommandExecutionRequestApprovalResponse.json",
    "FileChangeRequestApprovalResponse.json",
  ]) {
    const validate = await readValidator(bundleDirectory, path, "current approval decisions");
    for (const decision of ["accept", "acceptForSession", "decline", "cancel"]) {
      assertAccepts(validate, { decision }, "current approval decisions");
    }
    assertRejects(validate, {}, "current approval decisions");
    assertRejects(validate, { decision: "approved" }, "current approval decisions");
  }

  for (const path of ["ExecCommandApprovalResponse.json", "ApplyPatchApprovalResponse.json"]) {
    const validate = await readValidator(bundleDirectory, path, "legacy approval decisions");
    for (const decision of ["approved", "approved_for_session", "abort"]) {
      assertAccepts(validate, { decision }, "legacy approval decisions");
    }
    assertAccepts(
      validate,
      { decision: { denied: { rejection: "Denied in Discord" } } },
      "legacy approval decisions",
    );
    assertRejects(validate, {}, "legacy approval decisions");
    assertRejects(validate, { decision: "accept" }, "legacy approval decisions");
    assertRejects(validate, { decision: { denied: {} } }, "legacy approval decisions");
    assertRejects(
      validate,
      { decision: { denied: { rejection: 1 } } },
      "legacy approval decisions",
    );
  }

  const permissions = await readValidator(
    bundleDirectory,
    "PermissionsRequestApprovalResponse.json",
    "permission approval response",
  );
  const permissionResult = {
    permissions: PERMISSION_PROFILE,
    scope: "turn",
    strictAutoReview: false,
  };
  verifyWitness(
    permissions,
    permissionResult,
    [
      removed("permissions"),
      replaced([], "permissions"),
      replaced("forever", "scope"),
      replaced("yes", "strictAutoReview"),
      replaced("yes", "permissions", "network", "enabled"),
      replaced({}, "permissions", "fileSystem", "entries"),
      removed("permissions", "fileSystem", "entries", 0, "access"),
      removed("permissions", "fileSystem", "entries", 0, "path"),
      replaced("execute", "permissions", "fileSystem", "entries", 0, "access"),
      replaced(1, "permissions", "fileSystem", "entries", 0, "path", "path"),
      replaced(0, "permissions", "fileSystem", "globScanMaxDepth"),
      replaced({}, "permissions", "fileSystem", "read"),
      replaced({}, "permissions", "fileSystem", "write"),
    ],
    "permission approval grant",
  );
  assertAccepts(
    permissions,
    { ...permissionResult, scope: "session" },
    "permission approval grant scope",
  );

  const dynamic = await readValidator(
    bundleDirectory,
    "DynamicToolCallResponse.json",
    "dynamic tool call response",
  );
  const dynamicResult = {
    contentItems: [
      { text: "done", type: "inputText" },
      { imageUrl: "https://example.invalid/image.png", type: "inputImage" },
      { audioUrl: "https://example.invalid/audio.wav", type: "inputAudio" },
    ],
    success: true,
  };
  verifyWitness(
    dynamic,
    dynamicResult,
    [
      removed("contentItems"),
      removed("success"),
      replaced({}, "contentItems"),
      replaced("yes", "success"),
      replaced("unknown", "contentItems", 0, "type"),
      replaced(1, "contentItems", 0, "text"),
      replaced(1, "contentItems", 1, "imageUrl"),
      replaced(1, "contentItems", 2, "audioUrl"),
    ],
    "dynamic tool call response",
  );
  assertAccepts(dynamic, { ...dynamicResult, success: false }, "dynamic tool call response");
}

async function checkEnvelopes(bundleDirectory: string): Promise<void> {
  const requestId = await readValidator(
    bundleDirectory,
    "RequestId.json",
    "request ID string-or-number support",
  );
  assertAccepts(requestId, 1, "request ID string-or-number support");
  assertAccepts(requestId, "request-1", "request ID string-or-number support");
  for (const invalid of [false, null, {}, [], 1.5]) {
    assertRejects(requestId, invalid, "request ID string-or-number support");
  }

  const success = await readValidator(
    bundleDirectory,
    "JSONRPCResponse.json",
    "success response envelope",
  );
  const failure = await readValidator(
    bundleDirectory,
    "JSONRPCError.json",
    "error response envelope",
  );
  verifyWitness(
    success,
    SUCCESS_ENVELOPE,
    [removed("id"), removed("result"), replaced(false, "id")],
    "success response envelope",
  );
  verifyWitness(
    failure,
    ERROR_ENVELOPE,
    [
      removed("id"),
      removed("error"),
      removed("error", "code"),
      removed("error", "message"),
      replaced(false, "id"),
      replaced("-32601", "error", "code"),
      replaced(1, "error", "message"),
    ],
    "error response envelope",
  );
  assertRejects(success, ERROR_ENVELOPE, "success response envelope");
  assertRejects(failure, SUCCESS_ENVELOPE, "error response envelope");
  assertAccepts(success, { ...SUCCESS_ENVELOPE, id: "request-1" }, "success response envelope");
  assertAccepts(failure, { ...ERROR_ENVELOPE, id: 1 }, "error response envelope");
}

export async function checkProtocolSchemaBundle(
  bundleDirectory: string,
): Promise<ProtocolCompatibilityResult> {
  await checkEnvelopes(bundleDirectory);
  await checkRequestContracts(bundleDirectory);
  await checkNotificationContracts(bundleDirectory);
  await checkServerRequestContracts(bundleDirectory);
  await checkApprovalAndToolResponses(bundleDirectory);
  return { compatible: true };
}

interface CapturedProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

async function runCapturedProcess(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<CapturedProcessResult> {
  if (command.length === 0 || command.includes("\0")) {
    throw new BridgeError("CONFIGURATION", "The Codex executable path is invalid.", REMEDIATION);
  }

  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let retainedOutputBytes = 0;
    let settled = false;
    let exceededOutputLimit = false;
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let killTimeout: NodeJS.Timeout | undefined;
    let settlementTimeout: NodeJS.Timeout | undefined;

    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (killTimeout !== undefined) clearTimeout(killTimeout);
      if (settlementTimeout !== undefined) clearTimeout(settlementTimeout);
      child.removeAllListeners();
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      callback();
    };

    const capture = (target: Buffer[], chunk: Buffer) => {
      const remaining = maxOutputBytes - retainedOutputBytes;
      if (remaining > 0) {
        const retained = chunk.subarray(0, remaining);
        target.push(retained);
        retainedOutputBytes += retained.byteLength;
      }
      if (chunk.byteLength > remaining) {
        exceededOutputLimit = true;
        child.kill("SIGTERM");
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      capture(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      capture(stderr, chunk);
    });
    child.once("error", (error) => {
      settle(() => {
        reject(
          timedOut
            ? new BridgeError("TIMEOUT", "Codex CLI protocol verification timed out.", REMEDIATION)
            : new BridgeError(
                "CONFIGURATION",
                "Unable to start the Codex CLI for protocol verification.",
                REMEDIATION,
                { cause: error },
              ),
        );
      });
    });
    child.once("close", (code, signal) => {
      settle(() => {
        if (timedOut) {
          reject(
            new BridgeError("TIMEOUT", "Codex CLI protocol verification timed out.", REMEDIATION),
          );
          return;
        }
        if (exceededOutputLimit) {
          reject(
            new BridgeError(
              "CONFIGURATION",
              "Codex CLI protocol verification produced too much output.",
              REMEDIATION,
            ),
          );
          return;
        }
        resolvePromise({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          code,
          signal,
        });
      });
    });

    timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    killTimeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs + 250);
    settlementTimeout = setTimeout(() => {
      settle(() =>
        reject(
          new BridgeError("TIMEOUT", "Codex CLI protocol verification timed out.", REMEDIATION),
        ),
      );
    }, timeoutMs + 750);
  });
}

export function parseCodexVersion(output: string): string {
  const candidates = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("codex-cli "));
  if (
    candidates.length !== 1 ||
    !/^codex-cli [0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(candidates[0] ?? "")
  ) {
    throw new BridgeError(
      "CONFIGURATION",
      "Unable to determine the installed Codex CLI version.",
      REMEDIATION,
    );
  }
  return candidates[0] as string;
}

export async function checkInstalledCodexProtocol(
  options: InstalledProtocolCheckOptions = {},
): Promise<InstalledProtocolCompatibilityResult> {
  const codexPath = options.codexPath ?? "codex";
  if (codexPath.length === 0 || codexPath.includes("\0")) {
    throw new BridgeError("CONFIGURATION", "The Codex executable path is invalid.", REMEDIATION);
  }
  const timeoutMs = requirePositiveSafeInteger(
    "timeoutMs",
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    MAX_TIMER_MS - 750,
  );
  const maxOutputBytes = requirePositiveSafeInteger(
    "maxOutputBytes",
    options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    MAX_CAPTURE_BYTES,
  );
  const tempDirectory = await mkdtemp(
    join(resolve(options.tempParent ?? tmpdir()), "codex-discord-protocol-"),
  );
  try {
    const versionProcess = await runCapturedProcess(
      codexPath,
      ["--version"],
      timeoutMs,
      maxOutputBytes,
    );
    if (versionProcess.code !== 0) {
      throw new BridgeError("CONFIGURATION", "Codex CLI version detection failed.", REMEDIATION);
    }
    const version = parseCodexVersion(`${versionProcess.stdout}\n${versionProcess.stderr}`);

    const generation = await runCapturedProcess(
      codexPath,
      ["app-server", "generate-json-schema", "--experimental", "--out", tempDirectory],
      timeoutMs,
      maxOutputBytes,
    );
    if (generation.code !== 0) {
      throw new BridgeError(
        "CONFIGURATION",
        "Codex App Server schema generation failed.",
        REMEDIATION,
      );
    }
    await checkProtocolSchemaBundle(tempDirectory);
    return { compatible: true, version };
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

export async function main(): Promise<void> {
  try {
    const result = await checkInstalledCodexProtocol();
    process.stdout.write(`Codex App Server protocol compatible: ${result.version}\n`);
  } catch (error) {
    if (error instanceof BridgeError) {
      process.stderr.write(
        `${error.message}${error.remediation === undefined ? "" : ` ${error.remediation}`}\n`,
      );
      process.exitCode = 1;
      return;
    }
    process.stderr.write("Codex App Server protocol verification failed.\n");
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && resolve(entryPath) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
