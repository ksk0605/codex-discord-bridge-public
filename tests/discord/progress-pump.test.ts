import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type RenderedProgressEvent,
  renderTurnProgressEvent,
} from "../../src/discord/progress-format.js";
import {
  DiscordProgressPump,
  PROGRESS_TRUNCATION_NOTICE,
  type ProgressPumpDestination,
  type ProgressPumpScheduler,
} from "../../src/discord/progress-pump.js";
import { createTurnProgressEvent } from "../../src/runtime/turn-progress.js";

const STATUS_MESSAGE_ID = "400000000000000010";

function scheduler(): ProgressPumpScheduler {
  return {
    now: () => Date.now(),
    setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

function destination() {
  const calls: Array<{ kind: "append" | "create" | "edit"; content: string }> = [];
  const value: ProgressPumpDestination = {
    createStatus: vi.fn(async (content) => {
      calls.push({ kind: "create", content });
      return { id: STATUS_MESSAGE_ID };
    }),
    editStatus: vi.fn(async (_messageId, content) => {
      calls.push({ kind: "edit", content });
      return { id: STATUS_MESSAGE_ID };
    }),
    append: vi.fn(async (content) => {
      calls.push({ kind: "append", content });
      return { id: String(400000000000000020n + BigInt(calls.length)) };
    }),
  };
  return { calls, value };
}

function event(
  text: string,
  type: RenderedProgressEvent["type"] = "commentary",
): RenderedProgressEvent {
  return Object.freeze({ text, type });
}

function streamEvent(
  text: string,
  type: "commentary" | "reasoning" = "commentary",
): RenderedProgressEvent {
  return renderTurnProgressEvent(createTurnProgressEvent({ text, type }));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("DiscordProgressPump", () => {
  it("uses one status message and coalesces concurrent events for at least two seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const target = destination();
    const pump = new DiscordProgressPump(target.value, {
      batchDelayMs: 1,
      scheduler: scheduler(),
    });

    await pump.start("Question progress");
    await Promise.all([
      pump.push(event("Reasoning: first", "reasoning")),
      pump.push(event("Update: second")),
      pump.push(event("Warning: third", "warning")),
    ]);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(target.calls).toEqual([{ kind: "create", content: "Question progress" }]);

    await vi.advanceTimersByTimeAsync(1);
    expect(target.calls).toEqual([
      { kind: "create", content: "Question progress" },
      {
        kind: "edit",
        content: "Question progress\nCurrent: Warning: third",
      },
      {
        kind: "append",
        content: "Reasoning: first\n\nUpdate: second\n\nWarning: third",
      },
    ]);
    expect(target.value.createStatus).toHaveBeenCalledOnce();
  });

  it("coalesces adjacent commentary fragments within one timer batch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const target = destination();
    const pump = new DiscordProgressPump(target.value, { scheduler: scheduler() });
    await pump.start("Question progress");

    for (const fragment of ["`", "ex", "ample", "-repo", "` 저장", "소의", " 현재"]) {
      await pump.push(streamEvent(fragment));
    }
    await vi.advanceTimersByTimeAsync(2_000);

    expect(target.calls.filter((call) => call.kind === "edit").at(-1)).toEqual({
      kind: "edit",
      content: "Question progress\nCurrent: Update: \\`example-repo\\` 저장소의 현재",
    });
    expect(target.calls.filter((call) => call.kind === "append")).toEqual([
      { kind: "append", content: "Update: \\`example-repo\\` 저장소의 현재" },
    ]);
  });

  it("preserves activity and progress-type boundaries while coalescing fragments", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const target = destination();
    const pump = new DiscordProgressPump(target.value, { scheduler: scheduler() });
    await pump.start("Question progress");

    await pump.push(streamEvent("first "));
    await pump.push(streamEvent("update"));
    await pump.push(event("Command running: zsh", "activity"));
    await pump.push(streamEvent("reasoning ", "reasoning"));
    await pump.push(streamEvent("continues", "reasoning"));
    await pump.push(streamEvent("final "));
    await pump.push(streamEvent("update"));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(target.calls.filter((call) => call.kind === "append")).toEqual([
      {
        kind: "append",
        content:
          "Update: first update\n\nCommand running: zsh\n\nReasoning: reasoning continues\n\nUpdate: final update",
      },
    ]);
  });

  it("collapses repeated running activity and preserves the first-seen event order", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const target = destination();
    const pump = new DiscordProgressPump(target.value, { scheduler: scheduler() });
    await pump.start("Question progress");

    await Promise.all([
      pump.push(event("Command running: npm", "activity")),
      pump.push(event("Command running: npm", "activity")),
      pump.push(event("Tool running: github/search", "activity")),
      pump.push(event("Command completed: npm", "activity")),
    ]);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(target.calls.filter((call) => call.kind === "append")).toEqual([
      {
        kind: "append",
        content: "Command running: npm\n\nTool running: github/search\n\nCommand completed: npm",
      },
    ]);
  });

  it("serializes destination operations across overlapping timer batches", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const target = destination();
    let releaseFirst!: () => void;
    const firstAppend = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let appendCount = 0;
    vi.mocked(target.value.append).mockImplementation(async (content) => {
      appendCount += 1;
      target.calls.push({ kind: "append", content });
      if (appendCount === 1) await firstAppend;
      return { id: String(400000000000000030n + BigInt(appendCount)) };
    });
    const pump = new DiscordProgressPump(target.value, { scheduler: scheduler() });
    await pump.start("Question progress");

    await pump.push(event("Update: first"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(target.value.append).toHaveBeenCalledTimes(1);

    await pump.push(event("Update: second"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(target.value.append).toHaveBeenCalledTimes(1);

    releaseFirst();
    await vi.advanceTimersByTimeAsync(0);
    expect(target.value.append).toHaveBeenCalledTimes(2);
    expect(target.calls.filter((call) => call.kind === "append")).toEqual([
      { kind: "append", content: "Update: first" },
      { kind: "append", content: "Update: second" },
    ]);
  });

  it("enforces event and character budgets with exactly one truncation notice", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const target = destination();
    const pump = new DiscordProgressPump(target.value, {
      maxDetailCharacters: 6,
      maxDetailEvents: 2,
      scheduler: scheduler(),
    });
    await pump.start("Question progress");

    await pump.push(event("one"));
    await pump.push(event("two"));
    await pump.push(event("three"));
    await pump.push(event("four"));
    await vi.advanceTimersByTimeAsync(2_000);
    await pump.push(event("five"));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(target.calls.filter((call) => call.kind === "append")).toEqual([
      { kind: "append", content: "one\n\ntwo" },
      { kind: "append", content: PROGRESS_TRUNCATION_NOTICE },
    ]);
  });

  it("delivers terminal status after the detail budget is exhausted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const target = destination();
    const pump = new DiscordProgressPump(target.value, {
      maxDetailCharacters: 3,
      maxDetailEvents: 1,
      scheduler: scheduler(),
    });
    await pump.start("Question progress");
    await pump.push(event("one"));
    await pump.push(event("overflow"));

    await pump.terminal({ text: "Completed", type: "terminal" });

    expect(target.calls.filter((call) => call.kind === "append")).toEqual([
      { kind: "append", content: "one" },
      { kind: "append", content: PROGRESS_TRUNCATION_NOTICE },
      { kind: "append", content: "Completed" },
    ]);
    expect(target.calls.filter((call) => call.kind === "edit").at(-1)).toEqual({
      kind: "edit",
      content: "Question progress\nTerminal: Completed",
    });
    const callsAfterTerminal = target.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(target.calls).toHaveLength(callsAfterTerminal);
  });

  it("edits heartbeat age only when the thirty-second display bucket changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const target = destination();
    const pump = new DiscordProgressPump(target.value, { scheduler: scheduler() });
    await pump.start("Question progress");

    await pump.heartbeat(0);
    await vi.advanceTimersByTimeAsync(29_999);
    await pump.heartbeat(0);
    await vi.advanceTimersByTimeAsync(1);
    await pump.heartbeat(0);
    await pump.heartbeat(1_000);

    expect(target.calls.filter((call) => call.kind === "edit")).toEqual([
      {
        kind: "edit",
        content: "Question progress\nLast verified activity: now",
      },
      {
        kind: "edit",
        content: "Question progress\nLast verified activity: 30s ago",
      },
      {
        kind: "edit",
        content: "Question progress\nLast verified activity: now",
      },
    ]);
  });

  it("clears a stale heartbeat age when a new verified event arrives", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const target = destination();
    const pump = new DiscordProgressPump(target.value, { scheduler: scheduler() });
    await pump.start("Question progress");
    await pump.heartbeat(0);
    await vi.advanceTimersByTimeAsync(30_000);
    await pump.heartbeat(0);

    await pump.push(event("Update: fresh"));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(target.calls.filter((call) => call.kind === "edit").at(-1)).toEqual({
      kind: "edit",
      content: "Question progress\nCurrent: Update: fresh",
    });
  });

  it("disables nonterminal delivery after one transport failure without retrying", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const target = destination();
    vi.mocked(target.value.append).mockRejectedValue(new Error("transport failed"));
    const pump = new DiscordProgressPump(target.value, { scheduler: scheduler() });
    await pump.start("Question progress");
    await pump.push(event("Update: first"));
    await vi.advanceTimersByTimeAsync(2_000);

    const callsAfterFailure = target.calls.length;
    await pump.push(event("Update: second"));
    await vi.advanceTimersByTimeAsync(32_000);
    await pump.heartbeat(0);
    expect(target.calls).toHaveLength(callsAfterFailure);

    await expect(pump.terminal({ text: "Failed", type: "terminal" })).resolves.toBeUndefined();
    expect(target.value.editStatus).toHaveBeenCalledTimes(2);
    expect(target.value.append).toHaveBeenCalledTimes(2);
  });

  it("cancels pending batches and bounds stop when a destination never settles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const target = destination();
    const pump = new DiscordProgressPump(target.value, {
      scheduler: scheduler(),
      stopWaitMs: 500,
    });
    await pump.start("Question progress");
    await pump.push(event("Update: pending"));
    await pump.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(target.value.append).not.toHaveBeenCalled();

    const hanging = destination();
    vi.mocked(hanging.value.createStatus).mockImplementation(
      async () => new Promise<never>(() => undefined),
    );
    const blockedPump = new DiscordProgressPump(hanging.value, {
      scheduler: scheduler(),
      stopWaitMs: 500,
    });
    void blockedPump.start("Question progress");
    await Promise.resolve();
    let stopped = false;
    const stopping = blockedPump.stop().then(() => {
      stopped = true;
    });

    await vi.advanceTimersByTimeAsync(499);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(stopped).toBe(true);
  });
});
