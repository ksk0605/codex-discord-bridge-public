import { describe, expect, it } from "vitest";
import { renderSystemdUnits } from "../../src/systemd/units.js";

const options = {
  cliPath: "/opt/codex-discord-bridge/dist/cli.js",
  home: "/home/ec2-user",
  nodePath: "/usr/bin/node",
  path: "/home/ec2-user/.local/bin:/usr/local/bin:/usr/bin:/bin",
  stateRoot: "/var/lib/codex-discord-bridge",
  user: "ec2-user",
  workingDirectory: "/opt/codex-discord-bridge",
};

describe("renderSystemdUnits", () => {
  it("renders a non-secret boot and periodic desired-state restore", () => {
    expect(renderSystemdUnits(options)).toEqual({
      serviceFileName: "codex-discord-restore.service",
      service: `[Unit]
Description=Restore desired Codex Discord Bridge agents
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
User=ec2-user
WorkingDirectory="/opt/codex-discord-bridge"
Environment="HOME=/home/ec2-user"
Environment="PATH=/home/ec2-user/.local/bin:/usr/local/bin:/usr/bin:/bin"
Environment="CODEX_DISCORD_STATE_ROOT=/var/lib/codex-discord-bridge"
ExecStart="/usr/bin/node" "/opt/codex-discord-bridge/dist/cli.js" restore
UMask=0077
PrivateTmp=true
KillMode=process
`,
      timerFileName: "codex-discord-restore.timer",
      timer: `[Unit]
Description=Periodically restore desired Codex Discord Bridge agents

[Timer]
OnBootSec=30s
OnUnitInactiveSec=60s
Persistent=true
Unit=codex-discord-restore.service

[Install]
WantedBy=timers.target
`,
    });
  });

  it("quotes paths with spaces without turning them into separate systemd arguments", () => {
    const units = renderSystemdUnits({
      ...options,
      cliPath: "/opt/codex bridge/dist/cli.js",
      workingDirectory: "/opt/codex bridge",
    });

    expect(units.service).toContain('WorkingDirectory="/opt/codex bridge"');
    expect(units.service).toContain(
      'ExecStart="/usr/bin/node" "/opt/codex bridge/dist/cli.js" restore',
    );
  });

  it("passes non-secret custom SSM configuration only when SSM is explicit", () => {
    const units = renderSystemdUnits({
      ...options,
      awsRegion: "ap-northeast-2",
      credentialStore: "ssm",
      ssmKmsKeyId: "alias/codex-discord-bridge",
      ssmPrefix: "/production/codex-discord/bots",
    });

    expect(units.service).toContain('Environment="CODEX_DISCORD_CREDENTIAL_STORE=ssm"');
    expect(units.service).toContain(
      'Environment="CODEX_DISCORD_SSM_KMS_KEY_ID=alias/codex-discord-bridge"',
    );
    expect(units.service).toContain('Environment="AWS_REGION=ap-northeast-2"');
    expect(units.service).toContain(
      'Environment="CODEX_DISCORD_SSM_PREFIX=/production/codex-discord/bots"',
    );
  });

  it("rejects SSM settings when the credential store is not SSM", () => {
    expect(() =>
      renderSystemdUnits({
        ...options,
        awsRegion: "ap-northeast-2",
      }),
    ).toThrow(/credential-store/u);
  });

  it.each([
    ["relative cli path", { cliPath: "dist/cli.js" }],
    ["control character in state root", { stateRoot: "/var/lib/bridge\nExecStart=/bin/false" }],
    ["unsafe system user", { user: "ec2-user\nroot" }],
    ["unsupported credential store", { credentialStore: "unsupported" }],
  ])("rejects %s", (_label, override) => {
    expect(() => renderSystemdUnits({ ...options, ...override })).toThrow(/Invalid systemd/u);
  });
});
