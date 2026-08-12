import { isAbsolute } from "node:path";
import { BridgeError } from "../domain/errors.js";

export interface SystemdUnitOptions {
  readonly cliPath: string;
  readonly awsRegion?: string;
  readonly credentialStore?: string;
  readonly home: string;
  readonly nodePath: string;
  readonly path: string;
  readonly ssmKmsKeyId?: string;
  readonly ssmPrefix?: string;
  readonly stateRoot: string;
  readonly user: string;
  readonly workingDirectory: string;
}

export interface SystemdUnitFiles {
  readonly serviceFileName: "codex-discord-restore.service";
  readonly service: string;
  readonly timerFileName: "codex-discord-restore.timer";
  readonly timer: string;
}

const SYSTEM_USER = /^[a-z_][a-z0-9_-]{0,31}$/u;

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    );
  });
}

function systemdValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || hasControlCharacters(value)) {
    throw new BridgeError("INVALID_ARGUMENT", `Invalid systemd ${label}.`);
  }
  return value;
}

function absolutePath(value: unknown, label: string): string {
  const path = systemdValue(value, label);
  if (!isAbsolute(path)) {
    throw new BridgeError("INVALID_ARGUMENT", `Invalid systemd ${label}.`);
  }
  return path;
}

function optionalSystemdValue(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : systemdValue(value, label);
}

function credentialStore(value: unknown): "file" | "ssm" {
  if (value === undefined || value === "file") return "file";
  if (value === "ssm") return "ssm";
  throw new BridgeError(
    "INVALID_ARGUMENT",
    "Invalid systemd credential-store configuration.",
    "Choose file or ssm for the systemd credential store.",
  );
}

function systemdQuote(value: string): string {
  const escaped = value
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"')
    .replace(/\$/gu, () => "$$")
    .replace(/%/gu, "%%");
  return `"${escaped}"`;
}

function user(value: unknown): string {
  const parsed = systemdValue(value, "user");
  if (!SYSTEM_USER.test(parsed)) {
    throw new BridgeError("INVALID_ARGUMENT", "Invalid systemd user.");
  }
  return parsed;
}

export function renderSystemdUnits(options: SystemdUnitOptions): SystemdUnitFiles {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new BridgeError("INVALID_ARGUMENT", "Invalid systemd options.");
  }
  const cliPath = absolutePath(options.cliPath, "CLI path");
  const awsRegion = optionalSystemdValue(options.awsRegion, "AWS region");
  const selectedCredentialStore = credentialStore(options.credentialStore);
  const home = absolutePath(options.home, "home path");
  const nodePath = absolutePath(options.nodePath, "Node path");
  const path = systemdValue(options.path, "PATH");
  const ssmKmsKeyId = optionalSystemdValue(options.ssmKmsKeyId, "SSM KMS key ID");
  const ssmPrefix = optionalSystemdValue(options.ssmPrefix, "SSM prefix");
  const stateRoot = absolutePath(options.stateRoot, "state root");
  const systemUser = user(options.user);
  const workingDirectory = absolutePath(options.workingDirectory, "working directory");
  if (
    selectedCredentialStore !== "ssm" &&
    (awsRegion !== undefined || ssmKmsKeyId !== undefined || ssmPrefix !== undefined)
  ) {
    throw new BridgeError(
      "INVALID_ARGUMENT",
      "Invalid systemd credential-store configuration.",
      "Select the ssm credential store before supplying AWS or SSM settings.",
    );
  }

  const service = `${[
    "[Unit]",
    "Description=Restore desired Codex Discord Bridge agents",
    "Wants=network-online.target",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=oneshot",
    `User=${systemUser}`,
    `WorkingDirectory=${systemdQuote(workingDirectory)}`,
    `Environment=${systemdQuote(`HOME=${home}`)}`,
    `Environment=${systemdQuote(`PATH=${path}`)}`,
    `Environment=${systemdQuote(`CODEX_DISCORD_STATE_ROOT=${stateRoot}`)}`,
    ...(selectedCredentialStore === "ssm"
      ? [`Environment=${systemdQuote("CODEX_DISCORD_CREDENTIAL_STORE=ssm")}`]
      : []),
    ...(selectedCredentialStore === "ssm" && awsRegion !== undefined
      ? [`Environment=${systemdQuote(`AWS_REGION=${awsRegion}`)}`]
      : []),
    ...(selectedCredentialStore !== "ssm" || ssmKmsKeyId === undefined
      ? []
      : [`Environment=${systemdQuote(`CODEX_DISCORD_SSM_KMS_KEY_ID=${ssmKmsKeyId}`)}`]),
    ...(selectedCredentialStore !== "ssm" || ssmPrefix === undefined
      ? []
      : [`Environment=${systemdQuote(`CODEX_DISCORD_SSM_PREFIX=${ssmPrefix}`)}`]),
    `ExecStart=${systemdQuote(nodePath)} ${systemdQuote(cliPath)} restore`,
    "UMask=0077",
    "PrivateTmp=true",
    "KillMode=process",
  ].join("\n")}\n`;
  const timer = `${[
    "[Unit]",
    "Description=Periodically restore desired Codex Discord Bridge agents",
    "",
    "[Timer]",
    "OnBootSec=30s",
    "OnUnitInactiveSec=60s",
    "Persistent=true",
    "Unit=codex-discord-restore.service",
    "",
    "[Install]",
    "WantedBy=timers.target",
  ].join("\n")}\n`;

  return Object.freeze({
    service,
    serviceFileName: "codex-discord-restore.service",
    timer,
    timerFileName: "codex-discord-restore.timer",
  });
}
