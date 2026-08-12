import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import type { ManagerService } from "../src/manager/service.js";

function fixture() {
  let stdout = "";
  let stderr = "";
  const service = {
    registerBot: vi.fn(async () => ({ name: "bot-one", state: "registered" })),
    registerBotCommands: vi.fn(async () => [{ id: "command-one", name: "codex" }]),
    listBots: vi.fn(async () => []),
    addWorkspace: vi.fn(async (profile) => profile),
    listWorkspaces: vi.fn(async () => []),
    provisionAgent: vi.fn(async () => ({
      bot: { name: "bot-two", state: "registered" },
      binding: { id: "instance", name: "agent-two" },
    })),
    createAgent: vi.fn(async () => ({ id: "instance", name: "agent-one" })),
    linkAgent: vi.fn(async () => ({ id: "instance", name: "agent-one" })),
    start: vi.fn(async () => ({ observedState: "starting" })),
    stop: vi.fn(async () => ({ observedState: "stopped" })),
    restart: vi.fn(async () => ({ observedState: "starting" })),
    restoreRunningAgents: vi.fn(async () => ({
      alreadyRunning: [{ id: "instance-one", name: "agent-one", tmuxSession: "session-one" }],
      started: [{ id: "instance-two", name: "agent-two", tmuxSession: "session-two" }],
    })),
    status: vi.fn(async () => [{ name: "agent-one", tmuxRunning: true }]),
    requestProgressReconciliation: vi.fn(async (_target: string, threadId: string) => ({
      agentId: "instance",
      agentName: "agent-one",
      reconciliationRequested: true,
      restartRequired: true,
      threadId,
    })),
    approvePairing: vi.fn(async () => ({ allowFrom: [] })),
    allowUser: vi.fn(async () => ({ allowFrom: [] })),
    allowChannel: vi.fn(async () => ({ groups: {} })),
    getAccess: vi.fn(async () => ({ groups: {} })),
  } as unknown as ManagerService;
  return {
    service,
    streams: {
      writeOut: (text: string) => {
        stdout += text;
      },
      writeError: (text: string) => {
        stderr += text;
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe("codex-discord CLI", () => {
  it("emits one machine-readable status envelope", async () => {
    const context = fixture();

    expect(
      await runCli(["--json", "status"], {
        service: context.service,
        streams: context.streams,
      }),
    ).toBe(0);

    expect(JSON.parse(context.stdout())).toEqual({
      ok: true,
      command: "status",
      data: [{ name: "agent-one", tmuxRunning: true }],
    });
    expect(context.stderr()).toBe("");
  });

  it("restores every desired agent through one non-interactive command", async () => {
    const context = fixture();

    expect(
      await runCli(["--json", "restore"], {
        service: context.service,
        streams: context.streams,
      }),
    ).toBe(0);

    expect(context.service.restoreRunningAgents).toHaveBeenCalledOnce();
    expect(JSON.parse(context.stdout())).toEqual({
      ok: true,
      command: "restore",
      data: {
        alreadyRunning: [{ id: "instance-one", name: "agent-one", tmuxSession: "session-one" }],
        started: [{ id: "instance-two", name: "agent-two", tmuxSession: "session-two" }],
      },
    });
  });

  it("reads a bot token outside argv and never writes it to output", async () => {
    const context = fixture();
    const readToken = vi.fn(async () => "discord-secret-token");

    expect(
      await runCli(["--json", "bot", "register", "bot-one", "--owner", "100"], {
        service: context.service,
        streams: context.streams,
        readToken,
      }),
    ).toBe(0);

    expect(readToken).toHaveBeenCalledOnce();
    expect(context.service.registerBot).toHaveBeenCalledWith({
      name: "bot-one",
      ownerUserId: "100",
      token: "discord-secret-token",
    });
    expect(`${context.stdout()}${context.stderr()}`).not.toContain("discord-secret-token");
  });

  it("routes command re-registration without prompting for a token", async () => {
    const context = fixture();
    const readToken = vi.fn(async () => "must-not-be-read");

    expect(
      await runCli(["--json", "bot", "commands-register", "bot-one"], {
        service: context.service,
        streams: context.streams,
        readToken,
      }),
    ).toBe(0);

    expect(context.service.registerBotCommands).toHaveBeenCalledExactlyOnceWith("bot-one");
    expect(readToken).not.toHaveBeenCalled();
  });

  it("provisions an existing workspace and repeated channels from one hidden token prompt", async () => {
    const context = fixture();
    const readToken = vi.fn(async () => "discord-secret-token");

    expect(
      await runCli(
        [
          "--json",
          "provision",
          "bot-two",
          "--owner",
          "100",
          "--workspace",
          "main",
          "--channel",
          "200",
          "--channel",
          "201",
          "--name",
          "agent-two",
          "--mention",
        ],
        { service: context.service, streams: context.streams, readToken },
      ),
    ).toBe(0);

    expect(readToken).toHaveBeenCalledOnce();
    expect(context.service.provisionAgent).toHaveBeenCalledExactlyOnceWith({
      botName: "bot-two",
      ownerUserId: "100",
      token: "discord-secret-token",
      workspace: { kind: "existing", name: "main" },
      channelIds: ["200", "201"],
      requireMention: true,
      name: "agent-two",
    });
    expect(`${context.stdout()}${context.stderr()}`).not.toContain("discord-secret-token");
  });

  it("provisions an arbitrary project cwd without requiring mentions by default", async () => {
    const context = fixture();
    const readToken = vi.fn(async () => "discord-secret-token");

    expect(
      await runCli(
        [
          "--json",
          "provision",
          "bot-two",
          "--owner",
          "100",
          "--cwd",
          "/Users/example/workspace/project-two",
          "--channel",
          "200",
        ],
        { service: context.service, streams: context.streams, readToken },
      ),
    ).toBe(0);

    expect(context.service.provisionAgent).toHaveBeenCalledExactlyOnceWith({
      botName: "bot-two",
      ownerUserId: "100",
      token: "discord-secret-token",
      workspace: { cwd: "/Users/example/workspace/project-two", kind: "cwd" },
      channelIds: ["200"],
      requireMention: false,
    });
  });

  it("rejects ambiguous workspace selection before reading the token", async () => {
    for (const selectors of [
      [],
      ["--workspace", "main", "--cwd", "/Users/example/workspace/project-two"],
    ]) {
      const context = fixture();
      const readToken = vi.fn(async () => "must-not-be-read");

      expect(
        await runCli(
          ["--json", "provision", "bot-two", "--owner", "100", "--channel", "200", ...selectors],
          { service: context.service, streams: context.streams, readToken },
        ),
      ).toBe(2);

      expect(readToken).not.toHaveBeenCalled();
      expect(context.service.provisionAgent).not.toHaveBeenCalled();
      expect(JSON.parse(context.stderr())).toMatchObject({
        ok: false,
        command: "provision",
        error: { code: "INVALID_ARGUMENT" },
      });
    }
  });

  it("rejects a missing channel before reading the token", async () => {
    const context = fixture();
    const readToken = vi.fn(async () => "must-not-be-read");

    expect(
      await runCli(["--json", "provision", "bot-two", "--owner", "100", "--workspace", "main"], {
        service: context.service,
        streams: context.streams,
        readToken,
      }),
    ).toBe(2);

    expect(readToken).not.toHaveBeenCalled();
    expect(context.service.provisionAgent).not.toHaveBeenCalled();
    expect(JSON.parse(context.stderr())).toMatchObject({
      ok: false,
      command: "provision",
      error: { code: "INVALID_ARGUMENT" },
    });
  });

  it("maps create options to the manager service", async () => {
    const context = fixture();

    await runCli(["--json", "create", "bot-one", "--workspace", "main", "--name", "agent-one"], {
      service: context.service,
      streams: context.streams,
    });

    expect(context.service.createAgent).toHaveBeenCalledWith({
      botName: "bot-one",
      workspaceName: "main",
      name: "agent-one",
    });
  });

  it("requests progress reconciliation and reports that a runner restart is required", async () => {
    const threadId = "400000000000000001";
    const json = fixture();

    expect(
      await runCli(["--json", "progress", "reconcile", "agent-one", "--thread", threadId], {
        service: json.service,
        streams: json.streams,
      }),
    ).toBe(0);

    expect(json.service.requestProgressReconciliation).toHaveBeenCalledExactlyOnceWith(
      "agent-one",
      threadId,
    );
    expect(JSON.parse(json.stdout())).toMatchObject({
      ok: true,
      command: "progress reconcile",
      data: {
        reconciliationRequested: true,
        restartRequired: true,
        threadId,
      },
    });

    const human = fixture();
    expect(
      await runCli(["progress", "reconcile", "agent-one", "--thread", threadId], {
        service: human.service,
        streams: human.streams,
      }),
    ).toBe(0);
    expect(human.stdout()).toContain('"restartRequired": true');
    expect(human.stderr()).toBe("");
  });

  it("does not inherit AWS settings into a default local systemd unit", async () => {
    const context = fixture();
    vi.stubEnv("AWS_REGION", "ap-northeast-2");
    vi.stubEnv("CODEX_DISCORD_SSM_PREFIX", "/production/codex-discord/bots");
    try {
      expect(
        await runCli(
          [
            "--json",
            "systemd",
            "render",
            "--user",
            "ec2-user",
            "--home",
            "/home/ec2-user",
            "--state-root",
            "/var/lib/codex-discord-bridge",
            "--working-directory",
            "/opt/codex-discord-bridge",
            "--node",
            "/usr/bin/node",
            "--cli",
            "/opt/codex-discord-bridge/dist/cli.js",
            "--path",
            "/usr/bin:/bin",
          ],
          { service: context.service, streams: context.streams },
        ),
      ).toBe(0);

      const unit = JSON.parse(context.stdout()).data.service as string;
      expect(unit).not.toContain("AWS_REGION");
      expect(unit).not.toContain("CODEX_DISCORD_SSM_PREFIX");
      expect(unit).not.toContain("CODEX_DISCORD_CREDENTIAL_STORE");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("renders explicit SSM mode into the systemd unit", async () => {
    const context = fixture();
    vi.stubEnv("AWS_REGION", "ap-northeast-2");
    try {
      expect(
        await runCli(
          [
            "--json",
            "systemd",
            "render",
            "--user",
            "ec2-user",
            "--home",
            "/home/ec2-user",
            "--state-root",
            "/var/lib/codex-discord-bridge",
            "--working-directory",
            "/opt/codex-discord-bridge",
            "--node",
            "/usr/bin/node",
            "--cli",
            "/opt/codex-discord-bridge/dist/cli.js",
            "--path",
            "/usr/bin:/bin",
            "--credential-store",
            "ssm",
          ],
          { service: context.service, streams: context.streams },
        ),
      ).toBe(0);

      const unit = JSON.parse(context.stdout()).data.service as string;
      expect(unit).toContain('Environment="CODEX_DISCORD_CREDENTIAL_STORE=ssm"');
      expect(unit).toContain('Environment="AWS_REGION=ap-northeast-2"');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
