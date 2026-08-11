import { describe, expect, it, vi } from "vitest";
import { BridgeError } from "../../src/domain/errors.js";
import { type TmuxCommandRunner, TmuxController } from "../../src/manager/tmux.js";

const INSTANCE = "00000000-0000-4000-8000-000000000001";
const SESSION = "codex-discord-00000000";

describe("TmuxController", () => {
  it("starts a detached supervisor without placing secrets in argv", async () => {
    const run = vi.fn<TmuxCommandRunner>(async (_command, arguments_) => ({
      code: arguments_[0] === "has-session" ? 1 : 0,
      stdout: "",
      stderr: "",
    }));
    const tmux = new TmuxController({
      run,
      executable: "/opt/homebrew/bin/tmux",
      nodePath: "/usr/local/bin/node",
      supervisorPath: "/app/dist/supervisor.js",
    });

    await tmux.start(INSTANCE, SESSION);

    expect(run).toHaveBeenNthCalledWith(2, "/opt/homebrew/bin/tmux", [
      "new-session",
      "-d",
      "-s",
      SESSION,
      "/usr/local/bin/node",
      "/app/dist/supervisor.js",
      "--instance",
      INSTANCE,
    ]);
    expect(JSON.stringify(run.mock.calls)).not.toContain("token");
  });

  it("refuses a duplicate session and unsafe session names", async () => {
    const run = vi.fn<TmuxCommandRunner>(async () => ({ code: 0, stdout: "", stderr: "" }));
    const tmux = new TmuxController({ run, supervisorPath: "/app/supervisor.js" });

    await expect(tmux.start(INSTANCE, SESSION)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(tmux.start(INSTANCE, "bad session")).rejects.toBeInstanceOf(BridgeError);
  });

  it("uses C-c for graceful stop and never force-kills on timeout", async () => {
    const run = vi.fn<TmuxCommandRunner>(async (_command, arguments_) => ({
      code: arguments_[0] === "send-keys" ? 0 : 0,
      stdout: "",
      stderr: "",
    }));
    const tmux = new TmuxController({
      run,
      supervisorPath: "/app/supervisor.js",
      stopTimeoutMs: 2,
      pollIntervalMs: 1,
      sleep: async () => undefined,
    });

    await expect(tmux.stop(SESSION)).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(run).toHaveBeenCalledWith("tmux", ["send-keys", "-t", SESSION, "C-c"]);
    expect(run.mock.calls.some(([, arguments_]) => arguments_[0] === "kill-session")).toBe(false);
  });

  it("reserves kill-session for explicit force stop", async () => {
    let present = true;
    const run = vi.fn<TmuxCommandRunner>(async (_command, arguments_) => {
      if (arguments_[0] === "kill-session") present = false;
      return { code: arguments_[0] === "has-session" && !present ? 1 : 0, stdout: "", stderr: "" };
    });
    const tmux = new TmuxController({ run, supervisorPath: "/app/supervisor.js" });

    await tmux.stop(SESSION, { force: true });

    expect(run).toHaveBeenCalledWith("tmux", ["kill-session", "-t", SESSION]);
    expect(await tmux.hasSession(SESSION)).toBe(false);
  });
});
