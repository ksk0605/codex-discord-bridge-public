import { describe, expect, it } from "vitest";
import { BridgeError, exitCodeFor } from "../../src/domain/errors.js";

describe("BridgeError", () => {
  it("maps stable public error codes to process exit codes", () => {
    expect(exitCodeFor(new BridgeError("CONFLICT", "already bound"))).toBe(4);
    expect(exitCodeFor(new BridgeError("NOT_FOUND", "missing"))).toBe(3);
    expect(exitCodeFor(new Error("boom"))).toBe(7);
  });

  it.each([
    ["INVALID_ARGUMENT", 2],
    ["NOT_FOUND", 3],
    ["CONFLICT", 4],
    ["UNAUTHORIZED", 5],
    ["CONFIGURATION", 6],
    ["RUNTIME", 7],
    ["TIMEOUT", 8],
  ] as const)("maps %s to exit code %i", (code, exitCode) => {
    expect(exitCodeFor(new BridgeError(code, "failed"))).toBe(exitCode);
  });

  it("preserves public error metadata and cause", () => {
    const cause = new Error("root cause");
    const error = new BridgeError("RUNTIME", "failed", "retry the operation", { cause });

    expect(error.name).toBe("BridgeError");
    expect(error.remediation).toBe("retry the operation");
    expect(error.cause).toBe(cause);
  });
});
