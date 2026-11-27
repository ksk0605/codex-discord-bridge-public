// Owner override for Codex Auto Review (guardian) denials.
//
// When the guardian denies an escalated action, the owner gets a Discord DM with the exact
// action and the guardian's reasoning plus a one-time button. A click by the owner (Discord
// authenticates who clicked) calls the official `thread/approveGuardianDeniedAction`, which is
// what the Codex TUI's /approve does. That records the approval natively in the thread, so the
// guardian sees an authenticated approval when the agent retries the same action. Nothing else is
// relaxed: the guardian still reviews the retry, and `critical` denials never get a button.
import { appendFile } from "node:fs/promises";

import type { AutoApprovalReviewCompleted } from "../app-server/protocol.js";
import { redactDiscordSecrets } from "../discord/format.js";

export const GUARDIAN_REQUEST_PREFIX = "guardian:";
const DEFAULT_TTL_MS = 30 * 60_000;
const MAX_PENDING = 32;
const MAX_TEXT = 1_500;

export interface GuardianOverrideNotice {
  readonly ownerId: string;
  readonly requestId: string;
  readonly botName: string;
  readonly actionType: string;
  readonly summary: string;
  readonly cwd?: string;
  readonly riskLevel?: string;
  readonly userAuthorization?: string;
  readonly rationale?: string;
  readonly expiresInMinutes: number;
}

export interface GuardianOverrideInteraction {
  readonly requestId: string | number;
  readonly messageId: string;
  readonly userId: string;
  readonly action: "allow" | "deny";
}

export interface GuardianOverridePorts {
  sendNotice(notice: GuardianOverrideNotice): Promise<string>;
  // Jump link to the posted notice, so the chief can hand the owner a direct link.
  noticeLink?(messageId: string): string | undefined;
  notifyOwner(text: string): Promise<void>;
  approve(threadId: string, event: Record<string, unknown>): Promise<void>;
  // The bot's current Codex thread, to check a retry would land in the approved thread.
  currentThreadId(): string | undefined;
  // Discord channel of a running turn, when the runtime still knows it.
  channelForTurn(turnId: string): string | undefined;
  retry(channelId: string, text: string): Promise<void>;
}

export interface GuardianOverrideOptions {
  readonly ownerId: string;
  readonly botName: string;
  readonly ports: GuardianOverridePorts;
  readonly logPath?: string;
  readonly ttlMs?: number;
  readonly autoRetry?: boolean;
  readonly fallbackChannelId?: string;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

interface PendingOverride {
  readonly reviewId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly channelId?: string;
  readonly summary: string;
  readonly event: Record<string, unknown>;
  readonly expiresAt: number;
  messageId?: string;
  timer?: ReturnType<typeof setTimeout>;
}

function snake(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

// The notification uses the v2 camelCase wire shape; the request wants the core event
// (snake_case keys, snake_case enum tags), as accepted by Codex 0.167's serde schema.
const SNAKE_VALUE_KEYS = new Set(["type", "source", "protocol"]);
export function toCoreValue(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => toCoreValue(entry));
  if (typeof value === "string")
    return key !== undefined && SNAKE_VALUE_KEYS.has(key) ? snake(value) : value;
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(value)) out[snake(name)] = toCoreValue(entry, name);
  return out;
}

export function denialEvent(review: AutoApprovalReviewCompleted): Record<string, unknown> {
  return {
    id: review.reviewId,
    target_item_id: review.targetItemId ?? null,
    turn_id: review.turnId,
    status: "denied",
    risk_level: review.review.riskLevel ?? null,
    user_authorization: review.review.userAuthorization ?? null,
    rationale: review.review.rationale ?? null,
    decision_source: review.decisionSource === undefined ? "agent" : snake(review.decisionSource),
    action: toCoreValue(review.action),
  };
}

function clip(value: unknown): string {
  return redactDiscordSecrets(value, { maxOutputLength: MAX_TEXT });
}

export function summarizeAction(action: Record<string, unknown>): string {
  switch (action.type) {
    case "command":
      return clip(action.command);
    case "execve":
      return clip(
        Array.isArray(action.argv) ? JSON.stringify(action.argv) : String(action.program),
      );
    case "applyPatch":
      return clip(`파일 수정: ${Array.isArray(action.files) ? action.files.join(", ") : ""}`);
    case "networkAccess":
      return clip(`네트워크 접속: ${String(action.target ?? action.host)}`);
    case "mcpToolCall":
      return clip(`도구 호출: ${String(action.server)} / ${String(action.toolName)}`);
    case "requestPermissions":
      return clip(`권한 요청: ${String(action.reason ?? "")}`);
    default:
      return clip(JSON.stringify(action));
  }
}

export class GuardianOverrideRouter {
  private readonly options: GuardianOverrideOptions;
  private readonly pending = new Map<string, PendingOverride>();
  private readonly seen = new Set<string>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: GuardianOverrideOptions) {
    this.options = options;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  handleReview(review: AutoApprovalReviewCompleted): void {
    if (review.review.status !== "denied") return;
    if (this.seen.has(review.reviewId)) return;
    this.seen.add(review.reviewId);
    if (this.seen.size > 1_000) this.seen.delete(this.seen.values().next().value as string);
    const summary = summarizeAction(review.action);
    if (review.review.riskLevel === "critical") {
      void this.log({ result: "critical-no-button", reviewId: review.reviewId, summary });
      return;
    }
    if (this.pending.size >= MAX_PENDING) {
      void this.log({ result: "dropped-too-many", reviewId: review.reviewId, summary });
      return;
    }
    const channelId = this.options.ports.channelForTurn(review.turnId);
    const record: PendingOverride = {
      reviewId: review.reviewId,
      threadId: review.threadId,
      turnId: review.turnId,
      ...(channelId === undefined ? {} : { channelId }),
      summary,
      event: denialEvent(review),
      expiresAt: this.now() + this.ttlMs,
    };
    const key = `${GUARDIAN_REQUEST_PREFIX}${review.reviewId}`;
    this.pending.set(key, record);
    record.timer = setTimeout(() => {
      if (this.pending.delete(key)) void this.log({ result: "expired", reviewId: record.reviewId });
    }, this.ttlMs);
    record.timer.unref?.();
    const cwd = typeof review.action.cwd === "string" ? clip(review.action.cwd) : undefined;
    const rationale = review.review.rationale ?? undefined;
    void this.options.ports
      .sendNotice({
        ownerId: this.options.ownerId,
        requestId: key,
        botName: this.options.botName,
        actionType: review.action.type,
        summary,
        ...(cwd === undefined ? {} : { cwd }),
        ...(review.review.riskLevel ? { riskLevel: review.review.riskLevel } : {}),
        ...(review.review.userAuthorization
          ? { userAuthorization: review.review.userAuthorization }
          : {}),
        ...(rationale ? { rationale: clip(rationale) } : {}),
        expiresInMinutes: Math.round(this.ttlMs / 60_000),
      })
      .then((messageId) => {
        const current = this.pending.get(key);
        if (current !== undefined) current.messageId = messageId;
        const link = this.options.ports.noticeLink?.(messageId);
        void this.log({
          result: "offered",
          reviewId: record.reviewId,
          summary,
          ...(link === undefined ? {} : { link }),
          expiresAt: new Date(record.expiresAt).toISOString(),
        });
      })
      .catch((error) => {
        this.drop(key);
        this.options.onError?.(error);
        void this.log({ result: "notice-failed", reviewId: record.reviewId });
      });
  }

  // Returns true when the click belonged to a live override (the adapter then acknowledges it).
  handleInteraction(interaction: GuardianOverrideInteraction): boolean {
    if (typeof interaction.requestId !== "string") return false;
    if (!interaction.requestId.startsWith(GUARDIAN_REQUEST_PREFIX)) return false;
    if (interaction.userId !== this.options.ownerId) return false;
    const record = this.pending.get(interaction.requestId);
    if (record === undefined || record.messageId !== interaction.messageId) return false;
    if (this.now() >= record.expiresAt) {
      this.drop(interaction.requestId);
      return false;
    }
    this.drop(interaction.requestId);
    if (interaction.action === "deny") {
      void this.log({ result: "ignored", reviewId: record.reviewId, userId: interaction.userId });
      return true;
    }
    void this.approve(record, interaction.userId);
    return true;
  }

  cancelAll(): void {
    for (const key of [...this.pending.keys()]) this.drop(key);
  }

  private drop(key: string): void {
    const record = this.pending.get(key);
    if (record?.timer !== undefined) clearTimeout(record.timer);
    this.pending.delete(key);
  }

  private async approve(record: PendingOverride, userId: string): Promise<void> {
    const ports = this.options.ports;
    try {
      await ports.approve(record.threadId, record.event);
    } catch (error) {
      this.options.onError?.(error);
      await this.log({ result: "approve-failed", reviewId: record.reviewId, userId });
      await ports
        .notifyOwner(`승인 기록에 실패했어요. 봇에게 다시 시도하라고 해도 또 막힐 수 있어요.`)
        .catch(() => undefined);
      return;
    }
    await this.log({
      result: "approved",
      reviewId: record.reviewId,
      userId,
      summary: record.summary,
    });
    if (this.options.autoRetry === false) {
      await ports
        .notifyOwner("승인을 기록했어요. 봇에게 같은 동작을 다시 하라고 말하면 통과돼요.")
        .catch(() => undefined);
      return;
    }
    const channelId = record.channelId ?? this.options.fallbackChannelId;
    if (ports.currentThreadId() !== record.threadId || channelId === undefined) {
      await this.log({ result: "retry-skipped", reviewId: record.reviewId });
      await ports
        .notifyOwner(
          "승인은 기록했지만, 봇이 이미 다른 대화로 넘어가서 자동 재시도는 하지 않았어요. 같은 대화에서 다시 시도해야 통과돼요.",
        )
        .catch(() => undefined);
      return;
    }
    try {
      await ports.retry(
        channelId,
        [
          "[브리지 알림] 소유자가 Discord 버튼으로 방금 거절된 동작을 승인했어요. 승인은 Codex 공식 경로(thread/approveGuardianDeniedAction)로 이 대화에 기록됐어요.",
          "거절됐던 바로 그 동작만, 내용을 바꾸지 말고 한 번 다시 시도하세요. 다른 동작은 이 승인에 포함되지 않아요.",
          "",
          `승인된 동작: ${record.summary}`,
        ].join("\n"),
      );
      await this.log({ result: "retry-queued", reviewId: record.reviewId });
    } catch (error) {
      this.options.onError?.(error);
      await this.log({ result: "retry-failed", reviewId: record.reviewId });
      await ports
        .notifyOwner(
          "승인은 기록했지만 자동 재시도를 넣지 못했어요. 봇에게 다시 시도하라고 말해 주세요.",
        )
        .catch(() => undefined);
    }
  }

  private async log(entry: Record<string, unknown>): Promise<void> {
    if (this.options.logPath === undefined) return;
    try {
      await appendFile(
        this.options.logPath,
        `${JSON.stringify({ at: new Date(this.now()).toISOString(), bot: this.options.botName, ...entry })}\n`,
      );
    } catch (error) {
      this.options.onError?.(error);
    }
  }
}
