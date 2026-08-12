import { resolveStatePaths } from "../config/paths.js";
import { BridgeError } from "../domain/errors.js";
import type { CredentialStore } from "./credentials.js";
import { FileCredentialStore, type FileCredentialStoreOptions } from "./file.js";
import { KeychainStore } from "./keychain.js";
import { SsmCredentialStore, type SsmCredentialStoreOptions } from "./ssm.js";

export interface PlatformCredentialStoreOptions {
  readonly createFileStore?: (options: FileCredentialStoreOptions) => CredentialStore;
  readonly createKeychainStore?: () => CredentialStore;
  readonly createSsmStore?: (options: SsmCredentialStoreOptions) => CredentialStore;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly platform?: NodeJS.Platform;
  readonly stateRoot?: string;
}

function linuxCredentialStore(environment: Readonly<NodeJS.ProcessEnv>): "file" | "ssm" {
  const configured = environment.CODEX_DISCORD_CREDENTIAL_STORE;
  if (configured === undefined || configured === "file") return "file";
  if (configured === "ssm") return "ssm";
  throw new BridgeError(
    "CONFIGURATION",
    "Unsupported Linux credential-store configuration.",
    "Set CODEX_DISCORD_CREDENTIAL_STORE to file or ssm.",
  );
}

export function createDefaultCredentialStore(
  options: PlatformCredentialStoreOptions = {},
): CredentialStore {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") return (options.createKeychainStore ?? (() => new KeychainStore()))();
  if (platform === "linux") {
    const environment = options.environment ?? process.env;
    if (linuxCredentialStore(environment) === "file") {
      const stateRoot =
        options.stateRoot ?? resolveStatePaths(environment.CODEX_DISCORD_STATE_ROOT).root;
      return (options.createFileStore ?? ((storeOptions) => new FileCredentialStore(storeOptions)))(
        {
          stateRoot,
        },
      );
    }
    const region = environment.AWS_REGION ?? environment.AWS_DEFAULT_REGION;
    const ssmOptions: SsmCredentialStoreOptions = {
      ...(environment.CODEX_DISCORD_SSM_KMS_KEY_ID === undefined
        ? {}
        : { keyId: environment.CODEX_DISCORD_SSM_KMS_KEY_ID }),
      ...(environment.CODEX_DISCORD_SSM_PREFIX === undefined
        ? {}
        : { prefix: environment.CODEX_DISCORD_SSM_PREFIX }),
      ...(region === undefined ? {} : { region }),
    };
    return (options.createSsmStore ?? ((storeOptions) => new SsmCredentialStore(storeOptions)))(
      ssmOptions,
    );
  }
  throw new BridgeError(
    "CONFIGURATION",
    `Unsupported credential-store platform: ${platform}.`,
    "Run the bridge on macOS or Linux.",
  );
}
