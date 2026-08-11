import {
  type ApprovalRequestMethod,
  approvalResponseForRequest,
  currentApprovalResponse,
  legacyDeniedResponse,
  methodNotSupportedResponse,
  permissionDeclinedResponse,
  type RequestId,
  type ServerRequestParams,
  serverRequestSchemas,
} from "../app-server/protocol.js";
import { redactDiscordSecrets } from "../discord/format.js";

const MAX_PENDING = 128;
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_DISPLAY = 2_000;
const MAX_COMMAND_ARGUMENT = 512;
const MAX_ID = 256;

export interface ApprovalNotice {
  readonly ownerId: string;
  readonly requestId: RequestId;
  readonly method: ApprovalRequestMethod;
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly command?: string;
  readonly cwd?: string;
  readonly actions: readonly ["allow", "deny"];
}

export interface ApprovalDiscordPort {
  sendApproval(notice: ApprovalNotice): Promise<string>;
}

export interface ApprovalInteraction {
  readonly requestId: RequestId;
  readonly messageId: string;
  readonly userId: string;
  readonly action: "allow" | "deny";
}

export interface ApprovalRouterRequest<Method extends string = string> {
  readonly id: RequestId;
  readonly method: Method;
  readonly params: unknown;
}

export interface ApprovalRouterOptions {
  readonly ownerId: string;
  readonly discord: ApprovalDiscordPort;
  readonly timeoutMs?: number;
  readonly maxPending?: number;
}

interface PendingApproval {
  readonly request: ApprovalRouterRequest<ApprovalRequestMethod>;
  readonly method: ApprovalRequestMethod;
  readonly params: ServerRequestParams<ApprovalRequestMethod>;
  readonly resolve: (response: ApprovalResponse) => void;
  messageId?: string;
  readonly expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
  settled: boolean;
}

type ApprovalResponse = { id: RequestId; result: unknown } | { id: RequestId; error: object };

function idKey(id: RequestId): string {
  return `${typeof id}:${String(id)}`;
}

function boundedId(value: string, label: string): string {
  if (value.length === 0 || value.length > MAX_ID) throw new Error(`Invalid ${label}`);
  return value;
}

function boundedDisplay(value: unknown, maxOutputLength = MAX_DISPLAY): string {
  return redactDiscordSecrets(value, { maxOutputLength });
}

function boundText(value: string): string {
  if (value.length <= MAX_DISPLAY) return value;
  const suffix = "...[TRUNCATED]";
  return `${value.slice(0, MAX_DISPLAY - suffix.length)}${suffix}`;
}

function renderCommand(value: unknown): string | undefined {
  if (typeof value === "string") return boundedDisplay(value);
  if (!Array.isArray(value) || value.some((argument) => typeof argument !== "string")) {
    return undefined;
  }
  const redactedArguments = value.map((argument) => boundedDisplay(argument, MAX_COMMAND_ARGUMENT));
  return boundText(JSON.stringify(redactedArguments));
}

function responseFor(
  id: RequestId,
  method: ApprovalRequestMethod,
  params: ServerRequestParams<ApprovalRequestMethod>,
  action: "accept" | "decline",
  rejection?: string,
): ApprovalResponse {
  if (rejection !== undefined) {
    if (method === "execCommandApproval" || method === "applyPatchApproval") {
      return legacyDeniedResponse(id, rejection);
    }
    if (method === "item/permissions/requestApproval") return permissionDeclinedResponse(id);
    return currentApprovalResponse(id, "decline");
  }
  return approvalResponseForRequest(id, method, params as never, action);
}

export class ApprovalRouter {
  private readonly ownerId: string;
  private readonly discord: ApprovalDiscordPort;
  private readonly timeoutMs: number;
  private readonly maxPending: number;
  private readonly pending = new Map<string, PendingApproval>();

  constructor(options: ApprovalRouterOptions) {
    this.ownerId = boundedId(options.ownerId, "owner ID");
    this.discord = options.discord;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxPending = options.maxPending ?? MAX_PENDING;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs <= 0 ||
      this.timeoutMs > MAX_TIMEOUT_MS
    ) {
      throw new Error("Invalid approval timeout");
    }
    if (
      !Number.isSafeInteger(this.maxPending) ||
      this.maxPending <= 0 ||
      this.maxPending > MAX_PENDING
    ) {
      throw new Error("Invalid approval pending limit");
    }
  }

  register(request: ApprovalRouterRequest): Promise<ApprovalResponse> {
    if (!Object.hasOwn(serverRequestSchemas, request.method)) {
      return Promise.resolve(methodNotSupportedResponse(request.id));
    }
    if (request.method === "item/tool/call") {
      return Promise.resolve(methodNotSupportedResponse(request.id));
    }
    const method = request.method as ApprovalRequestMethod;
    const parsed = serverRequestSchemas[method].params.safeParse(request.params);
    if (!parsed.success || this.pending.size >= this.maxPending) {
      if (request.method === "item/permissions/requestApproval")
        return Promise.resolve(permissionDeclinedResponse(request.id));
      return Promise.resolve({
        id: request.id,
        error: { code: -32_603, message: "Request failed" },
      });
    }
    const params = parsed.data as ServerRequestParams<ApprovalRequestMethod>;
    const key = idKey(request.id);
    if (this.pending.has(key))
      return Promise.resolve({
        id: request.id,
        error: { code: -32_603, message: "Request failed" },
      });

    return new Promise<ApprovalResponse>((resolve) => {
      const record: PendingApproval = {
        request: request as ApprovalRouterRequest<ApprovalRequestMethod>,
        method,
        params,
        resolve,
        expiresAt: Date.now() + this.timeoutMs,
        settled: false,
      };
      this.pending.set(key, record);
      record.timer = setTimeout(
        () => this.complete(key, "decline", "Approval timed out"),
        this.timeoutMs,
      );
      void this.send(record, key);
    });
  }

  handleInteraction(interaction: ApprovalInteraction): boolean {
    if (interaction.userId !== this.ownerId || interaction.messageId.length > MAX_ID) return false;
    const record = this.pending.get(idKey(interaction.requestId));
    if (record === undefined || record.messageId !== interaction.messageId) return false;
    this.complete(
      idKey(interaction.requestId),
      interaction.action === "allow" ? "accept" : "decline",
    );
    return true;
  }

  cancelAll(): void {
    for (const key of [...this.pending.keys()]) this.complete(key, "decline", "Approval cancelled");
  }

  pendingCount(): number {
    return this.pending.size;
  }

  private async send(record: PendingApproval, key: string): Promise<void> {
    try {
      const params = record.params as Record<string, unknown>;
      const command = renderCommand(params.command);
      const messageId = boundedId(
        await this.discord.sendApproval({
          ownerId: this.ownerId,
          requestId: record.request.id,
          method: record.method,
          threadId: boundedId(String(params.threadId ?? params.conversationId), "thread ID"),
          turnId: boundedId(String(params.turnId ?? params.callId), "turn ID"),
          itemId: boundedId(String(params.itemId ?? params.callId), "item ID"),
          ...(command === undefined ? {} : { command }),
          ...(typeof params.cwd === "string" ? { cwd: boundedDisplay(params.cwd) } : {}),
          actions: ["allow", "deny"],
        }),
        "message ID",
      );
      const current = this.pending.get(key);
      if (current === undefined || current.settled) return;
      current.messageId = messageId;
    } catch {
      this.complete(key, "decline", "Approval delivery failed");
    }
  }

  private complete(key: string, action: "accept" | "decline", rejection?: string): void {
    const record = this.pending.get(key);
    if (record === undefined || record.settled) return;
    record.settled = true;
    this.pending.delete(key);
    if (record.timer !== undefined) clearTimeout(record.timer);
    record.resolve(responseFor(record.request.id, record.method, record.params, action, rejection));
  }
}
