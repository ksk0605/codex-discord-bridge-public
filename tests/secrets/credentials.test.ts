import { describe, expect, it, vi } from "vitest";
import type { CredentialStore } from "../../src/secrets/credentials.js";
import type { FileCredentialStoreOptions } from "../../src/secrets/file.js";
import { createDefaultCredentialStore } from "../../src/secrets/platform.js";

function store(): CredentialStore {
  return {
    delete: vi.fn(async () => undefined),
    get: vi.fn(async () => "token"),
    listAccounts: vi.fn(async () => []),
    set: vi.fn(async () => undefined),
  };
}

describe("createDefaultCredentialStore", () => {
  it("selects the macOS Keychain store only on Darwin", () => {
    const file = store();
    const keychain = store();
    const ssm = store();

    const selected = createDefaultCredentialStore({
      createFileStore: () => file,
      createKeychainStore: () => keychain,
      createSsmStore: () => ssm,
      platform: "darwin",
    });

    expect(selected).toBe(keychain);
  });

  it("selects local file credentials by default on Linux even with AWS settings", () => {
    const file = store();
    const keychain = store();
    const ssm = store();
    let fileOptions: FileCredentialStoreOptions | undefined;

    const selected = createDefaultCredentialStore({
      createFileStore: (options) => {
        fileOptions = options;
        return file;
      },
      createKeychainStore: () => keychain,
      createSsmStore: () => ssm,
      environment: {
        AWS_REGION: "ap-northeast-2",
        CODEX_DISCORD_SSM_KMS_KEY_ID: "alias/codex-discord-bridge",
        CODEX_DISCORD_SSM_PREFIX: "/production/codex-discord/bots",
      },
      platform: "linux",
      stateRoot: "/private/bridge-state",
    });

    expect(selected).toBe(file);
    expect(fileOptions).toEqual({ stateRoot: "/private/bridge-state" });
  });

  it("accepts an explicit local file selection on Linux", () => {
    const file = store();
    let fileOptions: FileCredentialStoreOptions | undefined;

    const selected = createDefaultCredentialStore({
      createFileStore: (options) => {
        fileOptions = options;
        return file;
      },
      environment: { CODEX_DISCORD_CREDENTIAL_STORE: "file" },
      platform: "linux",
      stateRoot: "/private/bridge-state",
    });

    expect(selected).toBe(file);
    expect(fileOptions).toEqual({ stateRoot: "/private/bridge-state" });
  });

  it("selects SSM only when explicitly requested on Linux", () => {
    const file = store();
    const ssm = store();
    let ssmOptions: unknown;

    const selected = createDefaultCredentialStore({
      createFileStore: () => file,
      createSsmStore: (options) => {
        ssmOptions = options;
        return ssm;
      },
      environment: {
        AWS_REGION: "ap-northeast-2",
        CODEX_DISCORD_CREDENTIAL_STORE: "ssm",
        CODEX_DISCORD_SSM_KMS_KEY_ID: "alias/codex-discord-bridge",
        CODEX_DISCORD_SSM_PREFIX: "/production/codex-discord/bots",
      },
      platform: "linux",
    });

    expect(selected).toBe(ssm);
    expect(ssmOptions).toEqual({
      keyId: "alias/codex-discord-bridge",
      prefix: "/production/codex-discord/bots",
      region: "ap-northeast-2",
    });
  });

  it("rejects an unsupported Linux credential-store mode", () => {
    const configuredValue = "unexpected-sensitive-mode-value";
    let failure: unknown;
    try {
      createDefaultCredentialStore({
        environment: { CODEX_DISCORD_CREDENTIAL_STORE: configuredValue },
        platform: "linux",
        stateRoot: "/private/bridge-state",
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "CONFIGURATION" });
    expect(failure).not.toMatchObject({ message: expect.stringContaining(configuredValue) });
  });

  it("fails closed on unsupported platforms", () => {
    expect(() =>
      createDefaultCredentialStore({
        createFileStore: store,
        createKeychainStore: store,
        createSsmStore: store,
        platform: "win32",
      }),
    ).toThrow(/Unsupported credential-store platform/u);
  });
});
