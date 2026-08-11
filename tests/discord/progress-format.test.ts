import { describe, expect, it } from "vitest";
import {
  MAX_RENDERED_PROGRESS_LENGTH,
  type RenderedProgressEvent,
  renderTurnProgressEvent,
} from "../../src/discord/progress-format.js";
import { BridgeError } from "../../src/domain/errors.js";
import {
  createDiscordDeliveryReceipt,
  createTurnProgressEvent,
  createTurnProgressSource,
} from "../../src/runtime/turn-progress.js";

describe("turn progress contract", () => {
  it.each([
    { state: "preparing", type: "state" },
    { state: "queued", type: "state" },
    { state: "running", type: "state" },
    { text: "Inspecting the runtime.", type: "reasoning" },
    { text: "I am checking the tests.", type: "commentary" },
    {
      steps: [
        { status: "pending", step: "Inspect" },
        { status: "inProgress", step: "Implement" },
        { status: "completed", step: "Verify" },
      ],
      type: "plan",
    },
    {
      activity: { executable: "/usr/local/bin/npm", kind: "command" },
      status: "inProgress",
      type: "activity",
    },
    { message: "A bounded warning.", type: "warning" },
    { observedAt: "2026-07-31T00:00:00.000Z", type: "heartbeat" },
    { status: "completed", type: "terminal" },
    { message: "Stopped by the user.", status: "interrupted", type: "terminal" },
  ])("creates and freezes $type events", (input) => {
    const event = createTurnProgressEvent(input);
    expect(event).toMatchObject(input);
    expect(Object.isFrozen(event)).toBe(true);
  });

  it.each([
    { state: "unknown", type: "state" },
    { text: "x".repeat(65_537), type: "reasoning" },
    { text: "contains\u0000control", type: "commentary" },
    {
      steps: Array.from({ length: 129 }, () => ({ status: "pending", step: "x" })),
      type: "plan",
    },
    {
      activity: {
        argv: ["npm", "test"],
        executable: "npm",
        kind: "command",
      },
      status: "inProgress",
      type: "activity",
    },
    {
      activity: {
        diff: "secret",
        kind: "file",
        paths: ["src/a.ts"],
      },
      status: "completed",
      type: "activity",
    },
    { observedAt: "not-a-timestamp", type: "heartbeat" },
    { status: "unknown", type: "terminal" },
  ])("rejects malformed or unsafe $type events", (input) => {
    expect(() => createTurnProgressEvent(input)).toThrow(BridgeError);
  });

  it("validates bounded Discord source and receipt metadata", () => {
    expect(
      createTurnProgressSource({
        channelId: "123",
        guildId: "789",
        messageId: "456",
      }),
    ).toEqual({ channelId: "123", guildId: "789", messageId: "456" });
    expect(createDiscordDeliveryReceipt({ channelId: "123", messageId: "456" })).toEqual({
      channelId: "123",
      messageId: "456",
    });
    expect(() => createTurnProgressSource({ channelId: "x", messageId: "456" })).toThrow(
      BridgeError,
    );
    expect(() =>
      createDiscordDeliveryReceipt({ channelId: "123", messageId: "456", secret: true }),
    ).toThrow(BridgeError);
  });
});

describe("progress rendering", () => {
  const discordToken = `${"A".repeat(24)}.${"B".repeat(6)}.${"C".repeat(30)}`;
  const fixtures = [
    discordToken,
    `mfa.${"D".repeat(40)}`,
    `sk-proj-${"e".repeat(40)}`,
    `ghp_${"f".repeat(40)}`,
    `AKIA${"G".repeat(16)}`,
    `eyJ${"a".repeat(20)}.eyJ${"b".repeat(20)}.${"c".repeat(24)}`,
    `https://discord.com/api/webhooks/1234567890/${"secret"}-token`,
    "https://user:password@example.com/private",
    "Authorization: Bearer top-secret-value",
    `${"-----BEGIN "}PRIVATE KEY-----\nsecret-material\n-----END PRIVATE KEY-----`,
    "@everyone @here <@1234567890> <@&1234567890> <#1234567890>",
    "[private](https://example.com/secret)",
    "/Users/example/workspace/private.txt",
    "/private/var/folders/private.txt",
    "/tmp/private.txt",
    "/home/user/private.txt",
    "https://cdn.discordapp.com/attachments/1/2/private.txt",
    "https://media.discordapp.net/attachments/1/2/private.png",
  ] as const;

  function eventsFor(value: string) {
    return [
      createTurnProgressEvent({ text: value, type: "commentary" }),
      createTurnProgressEvent({ text: value, type: "reasoning" }),
      createTurnProgressEvent({ message: value, type: "warning" }),
      createTurnProgressEvent({
        activity: { executable: value, kind: "command" },
        status: "inProgress",
        type: "activity",
      }),
      createTurnProgressEvent({
        activity: { kind: "file", paths: [value] },
        status: "completed",
        type: "activity",
      }),
    ];
  }

  it.each(fixtures)("removes prohibited progress content from %s", (fixture) => {
    const pumpInputs: RenderedProgressEvent[] = [];
    for (const event of eventsFor(fixture)) {
      const rendered = renderTurnProgressEvent(event);
      pumpInputs.push(rendered);
      expect(rendered.text.length).toBeLessThanOrEqual(MAX_RENDERED_PROGRESS_LENGTH);
      expect(rendered.text).not.toContain(fixture);
      expect(rendered.text).not.toMatch(/@everyone|@here|<[@#]/u);
      expect(rendered.text).not.toMatch(
        /(?:cdn|media)\.discordapp\.(?:com|net)|\/(?:Users|private|tmp|home)\//iu,
      );
      expect(rendered.text).not.toContain(discordToken);
    }
    expect(pumpInputs).toHaveLength(5);
    expect(pumpInputs.every((entry) => Object.isFrozen(entry))).toBe(true);
  });

  it("uses fixed labels, executable basenames, and safe relative file summaries", () => {
    expect(
      renderTurnProgressEvent(
        createTurnProgressEvent({
          activity: { executable: "/usr/local/bin/npm", kind: "command" },
          status: "completed",
          type: "activity",
        }),
      ).text,
    ).toBe("Command completed: npm");

    const files = renderTurnProgressEvent(
      createTurnProgressEvent({
        activity: {
          kind: "file",
          paths: ["src/a.ts", "../outside.txt", "/Users/example/private.txt"],
        },
        status: "completed",
        type: "activity",
      }),
    ).text;
    expect(files).toContain("src/a.ts");
    expect(files).not.toContain("../");
    expect(files).not.toContain("/Users/");
  });

  it("bounds aggregate plan and terminal rendering", () => {
    const plan = renderTurnProgressEvent(
      createTurnProgressEvent({
        steps: Array.from({ length: 128 }, (_, index) => ({
          status: "pending",
          step: `step-${index}-${"x".repeat(500)}`,
        })),
        type: "plan",
      }),
    );
    expect(plan.text.length).toBeLessThanOrEqual(MAX_RENDERED_PROGRESS_LENGTH);
    expect(plan.text).toContain("Plan");

    const terminal = renderTurnProgressEvent(
      createTurnProgressEvent({
        message: "done",
        status: "completed",
        type: "terminal",
      }),
    );
    expect(terminal.text).toBe("Completed: done");
  });
});
