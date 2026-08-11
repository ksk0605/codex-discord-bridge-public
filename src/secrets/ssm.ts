import {
  DeleteParameterCommand,
  GetParameterCommand,
  GetParametersByPathCommand,
  PutParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";
import { BridgeError } from "../domain/errors.js";
import {
  type CredentialStore,
  sortCredentialAccounts,
  validateCredentialAccount,
  validateCredentialToken,
} from "./credentials.js";

const DEFAULT_SSM_PREFIX = "/codex-discord-bridge/bots";
const MAX_SSM_PAGES = 1_000;
const SSM_PATH = /^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/u;
const SSM_ACCOUNT = /^[A-Za-z0-9_.-]+$/u;

export interface SsmParameterClient {
  getParameter(input: {
    readonly Name: string;
    readonly WithDecryption: boolean;
  }): Promise<{ readonly Parameter?: { readonly Name?: string; readonly Value?: string } }>;
  putParameter(input: {
    readonly KeyId?: string;
    readonly Name: string;
    readonly Overwrite: boolean;
    readonly Type: "SecureString";
    readonly Value: string;
  }): Promise<unknown>;
  deleteParameter(input: { readonly Name: string }): Promise<unknown>;
  getParametersByPath(input: {
    readonly NextToken?: string;
    readonly Path: string;
    readonly Recursive: boolean;
    readonly WithDecryption: boolean;
  }): Promise<{
    readonly NextToken?: string;
    readonly Parameters?: readonly { readonly Name?: string }[];
  }>;
}

export interface SsmCredentialStoreOptions {
  readonly client?: SsmParameterClient;
  readonly keyId?: string;
  readonly prefix?: string;
  readonly region?: string;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 2_048) {
    throw new BridgeError("CONFIGURATION", `Invalid SSM ${label}.`);
  }
  return value;
}

function prefix(value: unknown): string {
  const parsed = optionalString(value, "parameter prefix") ?? DEFAULT_SSM_PREFIX;
  if (!SSM_PATH.test(parsed)) {
    throw new BridgeError(
      "CONFIGURATION",
      "Invalid SSM parameter prefix.",
      "Use an absolute SSM hierarchy path without a trailing slash.",
    );
  }
  return parsed;
}

function accountSegment(value: unknown, code: "CONFIGURATION" | "INVALID_ARGUMENT"): string {
  const account = validateCredentialAccount(value, code);
  if (!SSM_ACCOUNT.test(account)) {
    throw new BridgeError(
      code,
      "Invalid SSM credential account.",
      "Use a credential account containing only letters, digits, dot, underscore, or hyphen.",
    );
  }
  return account;
}

function parameterName(
  prefix_: string,
  account: unknown,
  code: "CONFIGURATION" | "INVALID_ARGUMENT",
): string {
  return `${prefix_}/${accountSegment(account, code)}`;
}

function isParameterNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "ParameterNotFound" || error.name === "ParameterNotFoundException")
  );
}

function notFound(): BridgeError {
  return new BridgeError(
    "NOT_FOUND",
    "Credential entry was not found.",
    "Register the bot credential and retry.",
  );
}

function providerFailure(operation: "delete" | "list" | "read" | "write"): BridgeError {
  return new BridgeError(
    "RUNTIME",
    `Unable to ${operation} the SSM credential.`,
    "Verify the EC2 IAM role, SSM parameter prefix, KMS access, and network connectivity.",
  );
}

class AwsSsmParameterClient implements SsmParameterClient {
  readonly #client: SSMClient;

  constructor(options: { readonly region?: string } = {}) {
    this.#client = new SSMClient(options.region === undefined ? {} : { region: options.region });
  }

  async getParameter(input: { readonly Name: string; readonly WithDecryption: boolean }) {
    const response = await this.#client.send(new GetParameterCommand(input));
    const parameter = response.Parameter;
    return {
      ...(parameter === undefined
        ? {}
        : {
            Parameter: {
              ...(parameter.Name === undefined ? {} : { Name: parameter.Name }),
              ...(parameter.Value === undefined ? {} : { Value: parameter.Value }),
            },
          }),
    };
  }

  async putParameter(input: {
    readonly KeyId?: string;
    readonly Name: string;
    readonly Overwrite: boolean;
    readonly Type: "SecureString";
    readonly Value: string;
  }): Promise<void> {
    await this.#client.send(new PutParameterCommand(input));
  }

  async deleteParameter(input: { readonly Name: string }): Promise<void> {
    await this.#client.send(new DeleteParameterCommand(input));
  }

  async getParametersByPath(input: {
    readonly NextToken?: string;
    readonly Path: string;
    readonly Recursive: boolean;
    readonly WithDecryption: boolean;
  }) {
    const response = await this.#client.send(new GetParametersByPathCommand(input));
    return {
      ...(response.NextToken === undefined ? {} : { NextToken: response.NextToken }),
      ...(response.Parameters === undefined
        ? {}
        : {
            Parameters: response.Parameters.map((parameter) => ({
              ...(parameter.Name === undefined ? {} : { Name: parameter.Name }),
            })),
          }),
    };
  }
}

export class SsmCredentialStore implements CredentialStore {
  readonly #client: SsmParameterClient;
  readonly #keyId: string | undefined;
  readonly #prefix: string;

  constructor(options: SsmCredentialStoreOptions = {}) {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw new BridgeError("CONFIGURATION", "Invalid SSM credential configuration.");
    }
    const region = optionalString(options.region, "AWS region");
    this.#client =
      options.client ?? new AwsSsmParameterClient(region === undefined ? {} : { region });
    this.#keyId = optionalString(options.keyId, "KMS key ID");
    this.#prefix = prefix(options.prefix);
  }

  async set(account: string, token: string): Promise<void> {
    const input = {
      Name: parameterName(this.#prefix, account, "INVALID_ARGUMENT"),
      Overwrite: true,
      Type: "SecureString" as const,
      Value: validateCredentialToken(token),
      ...(this.#keyId === undefined ? {} : { KeyId: this.#keyId }),
    };
    try {
      await this.#client.putParameter(input);
    } catch {
      throw providerFailure("write");
    }
  }

  async get(account: string): Promise<string> {
    const name = parameterName(this.#prefix, account, "INVALID_ARGUMENT");
    let response: { readonly Parameter?: { readonly Name?: string; readonly Value?: string } };
    try {
      response = await this.#client.getParameter({ Name: name, WithDecryption: true });
    } catch (error) {
      if (isParameterNotFound(error)) throw notFound();
      throw providerFailure("read");
    }
    if (response.Parameter?.Name !== name || response.Parameter.Value === undefined) {
      throw new BridgeError("CONFIGURATION", "SSM returned an invalid credential parameter.");
    }
    return validateCredentialToken(response.Parameter.Value, "CONFIGURATION");
  }

  async delete(account: string): Promise<void> {
    const name = parameterName(this.#prefix, account, "INVALID_ARGUMENT");
    try {
      await this.#client.deleteParameter({ Name: name });
    } catch (error) {
      if (isParameterNotFound(error)) throw notFound();
      throw providerFailure("delete");
    }
  }

  async listAccounts(): Promise<string[]> {
    const accounts: string[] = [];
    let nextToken: string | undefined;
    for (let page = 0; page < MAX_SSM_PAGES; page += 1) {
      let response: {
        readonly NextToken?: string;
        readonly Parameters?: readonly { readonly Name?: string }[];
      };
      try {
        response = await this.#client.getParametersByPath({
          Path: this.#prefix,
          Recursive: false,
          WithDecryption: false,
          ...(nextToken === undefined ? {} : { NextToken: nextToken }),
        });
      } catch {
        throw providerFailure("list");
      }
      for (const parameter of response.Parameters ?? []) {
        const name = parameter.Name;
        const expectedPrefix = `${this.#prefix}/`;
        if (typeof name !== "string" || !name.startsWith(expectedPrefix)) continue;
        const account = name.slice(expectedPrefix.length);
        if (account.includes("/")) continue;
        accounts.push(accountSegment(account, "CONFIGURATION"));
      }
      if (response.NextToken === undefined) {
        const sorted = sortCredentialAccounts(accounts);
        if (new Set(sorted).size !== sorted.length) {
          throw new BridgeError("CONFIGURATION", "SSM returned duplicate credential accounts.");
        }
        return sorted;
      }
      if (response.NextToken.length === 0) {
        throw new BridgeError("CONFIGURATION", "SSM returned an invalid credential page token.");
      }
      nextToken = response.NextToken;
    }
    throw new BridgeError("CONFIGURATION", "SSM credential listing exceeded its page limit.");
  }
}
