import { describe, expect, it, vi } from "vitest";
import { RUNNER_RESTART_EXIT_CODE } from "../src/runner.js";
import {
  type SupervisorChildResult,
  type SupervisorRunChild,
  superviseAgent,
} from "../src/supervisor.js";

const INSTANCE = "00000000-0000-4000-8000-000000000001";

function result(code: number): SupervisorChildResult {
  return { code, signal: null };
}

describe("superviseAgent", () => {
  it("exits when the runner stops normally", async () => {
    const runChild = vi.fn<SupervisorRunChild>(async () => result(0));

    expect(await superviseAgent({ instanceId: INSTANCE, runChild })).toBe(0);
    expect(runChild).toHaveBeenCalledOnce();
  });

  it("waits for runtime-file cleanup before a requested restart", async () => {
    const runChild = vi
      .fn<SupervisorRunChild>()
      .mockResolvedValueOnce(result(RUNNER_RESTART_EXIT_CODE))
      .mockResolvedValueOnce(result(0));
    const waitForCleanup = vi.fn(async () => undefined);

    expect(await superviseAgent({ instanceId: INSTANCE, runChild, waitForCleanup })).toBe(0);
    expect(waitForCleanup).toHaveBeenCalledWith(INSTANCE);
    expect(runChild).toHaveBeenCalledTimes(2);
  });

  it("bounds abnormal crash restarts and applies capped backoff", async () => {
    const runChild = vi.fn<SupervisorRunChild>(async () => result(1));
    const sleeps: number[] = [];

    expect(
      await superviseAgent({
        instanceId: INSTANCE,
        runChild,
        maxCrashRestarts: 2,
        crashBackoffMs: 10,
        maxCrashBackoffMs: 15,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
      }),
    ).toBe(1);
    expect(runChild).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([10, 15]);
  });
});
