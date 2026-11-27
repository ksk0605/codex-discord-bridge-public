import { describe, expect, it, vi } from "vitest";
import type { AutoApprovalReviewCompleted } from "../../src/app-server/protocol.js";
import { AutoApprovalReviewCompletedNotificationSchema } from "../../src/app-server/protocol.js";
import {
  denialEvent,
  GUARDIAN_REQUEST_PREFIX,
  type GuardianOverrideNotice,
  type GuardianOverridePorts,
  GuardianOverrideRouter,
} from "../../src/runtime/guardian-override.js";

function review(overrides: Partial<Record<string, unknown>> = {}): AutoApprovalReviewCompleted {
  return AutoApprovalReviewCompletedNotificationSchema.parse({
    threadId: "thread-1",
    turnId: "turn-1",
    reviewId: "review-1",
    targetItemId: "exec-1",
    decisionSource: "agent",
    startedAtMs: 1,
    completedAtMs: 2,
    review: {
      status: "denied",
      riskLevel: "high",
      userAuthorization: "low",
      rationale: "Relayed approval is not trusted.",
    },
    action: {
      type: "command",
      source: "unifiedExec",
      command: "gh pr merge 92 --match-head-commit abc123",
      cwd: "/repo",
    },
    ...overrides,
  });
}

function fakePorts(overrides: Partial<GuardianOverridePorts> = {}) {
  const notices: GuardianOverrideNotice[] = [];
  const ports: GuardianOverridePorts = {
    sendNotice: vi.fn(async (notice: GuardianOverrideNotice) => {
      notices.push(notice);
      return `message-${notices.length}`;
    }),
    notifyOwner: vi.fn(async () => undefined),
    approve: vi.fn(async () => undefined),
    currentThreadId: () => "thread-1",
    channelForTurn: (turnId: string) => (turnId === "turn-1" ? "channel-1" : undefined),
    retry: vi.fn(async () => undefined),
    ...overrides,
  };
  return { ports, notices };
}

function router(ports: GuardianOverridePorts, now = () => 1_000) {
  return new GuardianOverrideRouter({ ownerId: "owner-1", botName: "srsr-ops", ports, now });
}

const click = (
  messageId = "message-1",
  userId = "owner-1",
  action: "allow" | "deny" = "allow",
) => ({
  requestId: `${GUARDIAN_REQUEST_PREFIX}review-1`,
  messageId,
  userId,
  action,
});

describe("denialEvent", () => {
  it("converts the v2 notification into the core snake_case event Codex accepts", () => {
    expect(denialEvent(review())).toEqual({
      id: "review-1",
      target_item_id: "exec-1",
      turn_id: "turn-1",
      status: "denied",
      risk_level: "high",
      user_authorization: "low",
      rationale: "Relayed approval is not trusted.",
      decision_source: "agent",
      action: {
        type: "command",
        source: "unified_exec",
        command: "gh pr merge 92 --match-head-commit abc123",
        cwd: "/repo",
      },
    });
  });

  it("snake-cases tags and keys of other action kinds", () => {
    const event = denialEvent(
      review({
        action: {
          type: "mcpToolCall",
          server: "srsr-dbrun",
          toolName: "db_apply",
          connectorId: null,
        },
      }),
    );
    expect(event.action).toEqual({
      type: "mcp_tool_call",
      server: "srsr-dbrun",
      tool_name: "db_apply",
      connector_id: null,
    });
    const network = denialEvent(
      review({
        action: { type: "networkAccess", host: "h", port: 443, protocol: "socks5Tcp", target: "t" },
      }),
    );
    expect(network.action).toMatchObject({ type: "network_access", protocol: "socks5_tcp" });
  });
});

describe("GuardianOverrideRouter", () => {
  it("offers a one-time owner button for a denied action", async () => {
    const fake = fakePorts();
    const guard = router(fake.ports);
    guard.handleReview(review());
    await vi.waitFor(() => expect(fake.notices).toHaveLength(1));
    expect(fake.notices[0]).toMatchObject({
      ownerId: "owner-1",
      requestId: `${GUARDIAN_REQUEST_PREFIX}review-1`,
      botName: "srsr-ops",
      summary: "gh pr merge 92 --match-head-commit abc123",
      cwd: "/repo",
      riskLevel: "high",
      expiresInMinutes: 30,
    });
    expect(guard.pendingCount()).toBe(1);
  });

  it("ignores approved reviews, repeats of the same review, and critical denials", async () => {
    const fake = fakePorts();
    const guard = router(fake.ports);
    guard.handleReview(review({ review: { status: "approved" } }));
    guard.handleReview(
      review({ reviewId: "crit", review: { status: "denied", riskLevel: "critical" } }),
    );
    guard.handleReview(review());
    guard.handleReview(review());
    await vi.waitFor(() => expect(fake.notices).toHaveLength(1));
    expect(guard.pendingCount()).toBe(1);
  });

  it("approves through the official API and queues one retry in the same channel", async () => {
    const fake = fakePorts();
    const guard = router(fake.ports);
    guard.handleReview(review());
    await vi.waitFor(() => expect(fake.notices).toHaveLength(1));
    expect(guard.handleInteraction(click())).toBe(true);
    await vi.waitFor(() => expect(fake.ports.retry).toHaveBeenCalledOnce());
    expect(fake.ports.approve).toHaveBeenCalledWith("thread-1", denialEvent(review()));
    expect(vi.mocked(fake.ports.retry).mock.calls[0]?.[0]).toBe("channel-1");
    expect(vi.mocked(fake.ports.retry).mock.calls[0]?.[1]).toContain("gh pr merge 92");
    // One-time: a second click is not accepted.
    expect(guard.handleInteraction(click())).toBe(false);
    expect(fake.ports.approve).toHaveBeenCalledOnce();
  });

  it("accepts only the owner and the original message", async () => {
    const fake = fakePorts();
    const guard = router(fake.ports);
    guard.handleReview(review());
    await vi.waitFor(() => expect(fake.notices).toHaveLength(1));
    expect(guard.handleInteraction(click("message-1", "someone-else"))).toBe(false);
    expect(guard.handleInteraction(click("other-message"))).toBe(false);
    expect(guard.handleInteraction({ ...click(), requestId: 7 })).toBe(false);
    expect(guard.handleInteraction({ ...click(), requestId: "req-1" })).toBe(false);
    expect(fake.ports.approve).not.toHaveBeenCalled();
    expect(guard.pendingCount()).toBe(1);
  });

  it("does nothing on the ignore button", async () => {
    const fake = fakePorts();
    const guard = router(fake.ports);
    guard.handleReview(review());
    await vi.waitFor(() => expect(fake.notices).toHaveLength(1));
    expect(guard.handleInteraction(click("message-1", "owner-1", "deny"))).toBe(true);
    expect(fake.ports.approve).not.toHaveBeenCalled();
    expect(guard.pendingCount()).toBe(0);
  });

  it("refuses an expired button", async () => {
    const fake = fakePorts();
    let now = 1_000;
    const guard = router(fake.ports, () => now);
    guard.handleReview(review());
    await vi.waitFor(() => expect(fake.notices).toHaveLength(1));
    now += 30 * 60_000;
    expect(guard.handleInteraction(click())).toBe(false);
    expect(fake.ports.approve).not.toHaveBeenCalled();
  });

  it("records the approval but skips the retry when the bot moved to another thread", async () => {
    const fake = fakePorts({ currentThreadId: () => "thread-2" });
    const guard = router(fake.ports);
    guard.handleReview(review());
    await vi.waitFor(() => expect(fake.notices).toHaveLength(1));
    expect(guard.handleInteraction(click())).toBe(true);
    await vi.waitFor(() => expect(fake.ports.notifyOwner).toHaveBeenCalledOnce());
    expect(fake.ports.approve).toHaveBeenCalledOnce();
    expect(fake.ports.retry).not.toHaveBeenCalled();
  });

  it("tells the owner when the approval call fails and does not retry", async () => {
    const fake = fakePorts({
      approve: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const guard = new GuardianOverrideRouter({
      ownerId: "owner-1",
      botName: "srsr-ops",
      ports: fake.ports,
      onError: () => undefined,
    });
    guard.handleReview(review());
    await vi.waitFor(() => expect(fake.notices).toHaveLength(1));
    guard.handleInteraction(click());
    await vi.waitFor(() => expect(fake.ports.notifyOwner).toHaveBeenCalledOnce());
    expect(fake.ports.retry).not.toHaveBeenCalled();
  });
});
