import { describe, expect, it, vi } from "vitest";
import type { CredentialStore } from "../../src/secrets/credentials.js";
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
    const keychain = store();
    const ssm = store();

    const selected = createDefaultCredentialStore({
      createKeychainStore: () => keychain,
      createSsmStore: () => ssm,
      platform: "darwin",
    });

    expect(selected).toBe(keychain);
  });

  it("selects the SSM credential store on Linux", () => {
    const keychain = store();
    const ssm = store();
    let ssmOptions: unknown;

    const selected = createDefaultCredentialStore({
      createKeychainStore: () => keychain,
      createSsmStore: (options) => {
        ssmOptions = options;
        return ssm;
      },
      environment: {
        AWS_REGION: "ap-northeast-2",
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

  it("fails closed on unsupported platforms", () => {
    expect(() =>
      createDefaultCredentialStore({
        createKeychainStore: store,
        createSsmStore: store,
        platform: "win32",
      }),
    ).toThrow(/Unsupported credential-store platform/u);
  });
});
