import { describe, expect, it, vi } from "vitest";
import {
  type ApprovalDiscordPort,
  type ApprovalInteraction,
  type ApprovalNotice,
  ApprovalRouter,
} from "../../src/runtime/approval-router.js";

const commandParams = {
  itemId: "item-1",
  startedAtMs: 1,
  threadId: "thread-1",
  turnId: "turn-1",
  availableDecisions: ["accept", "decline"],
  command: "printf '%s' \"$(touch /tmp/pwned)\"",
  cwd: "/private/project",
};

function port() {
  const notices: ApprovalNotice[] = [];
  const send = vi.fn(async (notice: ApprovalNotice) => {
    notices.push(notice);
    return `message-${notices.length}`;
  });
  return { port: { sendApproval: send } satisfies ApprovalDiscordPort, notices, send };
}

async function settle<T>(promise: Promise<T>) {
  return await promise;
}

describe("ApprovalRouter", () => {
  it("renders command and cwd without shell interpretation", async () => {
    const fake = port();
    const router = new ApprovalRouter({ ownerId: "owner-1", discord: fake.port });
    const pending = router.register({
      id: "req-1",
      method: "item/commandExecution/requestApproval",
      params: commandParams,
    });

    await vi.waitFor(() => expect(fake.send).toHaveBeenCalledOnce());
    const notice = fake.notices[0];
    if (notice === undefined) throw new Error("approval notice was not sent");
    expect(notice).toMatchObject({
      ownerId: "owner-1",
      command: commandParams.command,
      cwd: commandParams.cwd,
      actions: ["allow", "deny"],
    });
    expect(notice.command).not.toContain("```\n");
    expect(router.pendingCount()).toBe(1);
    void pending;
  });

  it("renders legacy argv deterministically without shell interpretation", async () => {
    const fake = port();
    const router = new ApprovalRouter({ ownerId: "owner-1", discord: fake.port });
    router.register({
      id: "legacy-1",
      method: "execCommandApproval",
      params: {
        callId: "call-1",
        command: ["node", "-e", "console.log('$(touch /tmp/pwned)')", "token=secret-value"],
        conversationId: "conversation-1",
        cwd: "/private/project",
        parsedCmd: [{ cmd: "node", type: "unknown" }],
      },
    });

    await vi.waitFor(() => expect(fake.send).toHaveBeenCalledOnce());
    const notice = fake.notices[0];
    if (notice === undefined) throw new Error("approval notice was not sent");
    expect(notice.command).toBe(
      '["node","-e","console.log(\'$(touch /tmp/pwned)\')","token=[REDACTED]"]',
    );
    expect(notice.cwd).toBe("/private/project");
    expect(notice.command).not.toContain("```\n");
  });

  it("sends approval only to the configured owner DM", async () => {
    const fake = port();
    const router = new ApprovalRouter({ ownerId: "owner-1", discord: fake.port });
    router.register({
      id: 7,
      method: "item/fileChange/requestApproval",
      params: { itemId: "item-1", startedAtMs: 1, threadId: "t", turnId: "u" },
    });

    await vi.waitFor(() => expect(fake.send).toHaveBeenCalledOnce());
    const call = fake.send.mock.calls[0];
    if (call === undefined) throw new Error("approval notice was not sent");
    expect(call[0].ownerId).toBe("owner-1");
  });

  it("accepts an allow click only from the owner and exact message", async () => {
    const fake = port();
    const router = new ApprovalRouter({ ownerId: "owner-1", discord: fake.port });
    const pending = router.register({
      id: "req-1",
      method: "item/fileChange/requestApproval",
      params: { itemId: "item-1", startedAtMs: 1, threadId: "t", turnId: "u" },
    });
    await vi.waitFor(() => expect(fake.send).toHaveBeenCalledOnce());

    const bad: ApprovalInteraction = {
      requestId: "req-1",
      messageId: "message-1",
      userId: "other",
      action: "allow",
    };
    expect(router.handleInteraction(bad)).toBe(false);
    expect(router.pendingCount()).toBe(1);
    expect(router.handleInteraction({ ...bad, userId: "owner-1", messageId: "wrong" })).toBe(false);
    expect(router.pendingCount()).toBe(1);

    expect(router.handleInteraction({ ...bad, userId: "owner-1", messageId: "message-1" })).toBe(
      true,
    );
    await expect(settle(pending)).resolves.toEqual({ id: "req-1", result: { decision: "accept" } });
    expect(router.handleInteraction({ ...bad, userId: "owner-1", messageId: "message-1" })).toBe(
      false,
    );
    expect(router.pendingCount()).toBe(0);
  });

  it.each([
    ["item/commandExecution/requestApproval", commandParams, { decision: "decline" }],
    [
      "item/fileChange/requestApproval",
      { itemId: "i", startedAtMs: 1, threadId: "t", turnId: "u" },
      { decision: "accept" },
    ],
    [
      "execCommandApproval",
      {
        callId: "c",
        command: ["echo", "hi"],
        conversationId: "v",
        cwd: "/tmp",
        parsedCmd: [{ cmd: "echo", type: "unknown" }],
      },
      { decision: "approved" },
    ],
    [
      "applyPatchApproval",
      { callId: "c", conversationId: "v", fileChanges: { "a.txt": { type: "add", content: "x" } } },
      { decision: { denied: { rejection: "Denied in Discord" } } },
    ],
  ] as const)("maps %s to its exact response shape", async (method, params, expected) => {
    const fake = port();
    const router = new ApprovalRouter({ ownerId: "owner-1", discord: fake.port });
    const pending = router.register({ id: "id", method, params });
    await vi.waitFor(() => expect(fake.send).toHaveBeenCalledOnce());
    router.handleInteraction({
      requestId: "id",
      messageId: "message-1",
      userId: "owner-1",
      action: expected.decision === "approved" || expected.decision === "accept" ? "allow" : "deny",
    });
    await expect(pending).resolves.toEqual({ id: "id", result: expected });
  });

  it("expires and denies an unanswered request", async () => {
    vi.useFakeTimers();
    try {
      const fake = port();
      const router = new ApprovalRouter({ ownerId: "owner-1", discord: fake.port, timeoutMs: 100 });
      const pending = router.register({
        id: 1,
        method: "execCommandApproval",
        params: {
          callId: "c",
          command: ["echo"],
          conversationId: "v",
          cwd: "/tmp",
          parsedCmd: [{ cmd: "echo", type: "unknown" }],
        },
      });
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toEqual({
        id: 1,
        result: { decision: { denied: { rejection: "Approval timed out" } } },
      });
      expect(router.pendingCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed on an unrepresentable permission profile", async () => {
    const fake = port();
    const router = new ApprovalRouter({ ownerId: "owner-1", discord: fake.port });
    const pending = router.register({
      id: "p",
      method: "item/permissions/requestApproval",
      params: {
        itemId: "i",
        startedAtMs: 1,
        threadId: "t",
        turnId: "u",
        cwd: "/tmp",
        permissions: {
          fileSystem: {
            entries: [
              { access: "write", path: { type: "path", path: "/tmp" }, extra: "unsupported" },
            ],
          },
        },
      },
    });
    await expect(pending).resolves.toEqual({
      id: "p",
      error: { code: -32_000, message: "Permission request declined" },
    });
    expect(fake.send).not.toHaveBeenCalled();
  });

  it("grants a supported permission profile for the turn only", async () => {
    const fake = port();
    const router = new ApprovalRouter({ ownerId: "owner-1", discord: fake.port });
    const pending = router.register({
      id: "p-supported",
      method: "item/permissions/requestApproval",
      params: {
        itemId: "i",
        startedAtMs: 1,
        threadId: "t",
        turnId: "u",
        cwd: "/tmp",
        permissions: { network: { enabled: true } },
      },
    });
    await vi.waitFor(() => expect(fake.send).toHaveBeenCalledOnce());
    expect(
      router.handleInteraction({
        requestId: "p-supported",
        messageId: "message-1",
        userId: "owner-1",
        action: "allow",
      }),
    ).toBe(true);
    await expect(pending).resolves.toEqual({
      id: "p-supported",
      result: { permissions: { network: { enabled: true } }, scope: "turn" },
    });
  });

  it("denies unsupported server requests instead of hanging", async () => {
    const fake = port();
    const router = new ApprovalRouter({ ownerId: "owner-1", discord: fake.port });
    await expect(router.register({ id: 9, method: "futureApproval", params: {} })).resolves.toEqual(
      { id: 9, error: { code: -32_601, message: "Method not supported" } },
    );
    expect(router.pendingCount()).toBe(0);
  });

  it("cancels and settles every pending request", async () => {
    const fake = port();
    const router = new ApprovalRouter({ ownerId: "owner-1", discord: fake.port });
    const pending = router.register({
      id: 1,
      method: "execCommandApproval",
      params: {
        callId: "c",
        command: ["echo"],
        conversationId: "v",
        cwd: "/tmp",
        parsedCmd: [{ cmd: "echo", type: "unknown" }],
      },
    });
    await vi.waitFor(() => expect(fake.send).toHaveBeenCalledOnce());
    router.cancelAll();
    await expect(pending).resolves.toEqual({
      id: 1,
      result: { decision: { denied: { rejection: "Approval cancelled" } } },
    });
  });
});
