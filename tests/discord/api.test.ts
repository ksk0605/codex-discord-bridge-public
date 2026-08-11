import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  DISCORD_API_BASE_URL,
  DISCORD_API_USER_AGENT,
  type DiscordApiOptions,
  MAX_DISCORD_TOKEN_BYTES,
  registerApplicationCommands,
  verifyBotToken,
} from "../../src/discord/api.js";
import { BridgeError, type BridgeErrorCode } from "../../src/domain/errors.js";

const TOKEN = "discord-bot-token-test-marker";
const APPLICATION_ID = "100000000000000001";
const BOT_USER_ID = "200000000000000001";
const COMMAND_ID = "300000000000000001";
const CODEX_COMMAND = {
  name: "codex",
  description: "Control Codex agent sessions",
  type: 1,
  integration_types: [0],
  contexts: [0, 1],
  options: [
    {
      type: 1,
      name: "status",
      description: "Show the current Codex session status",
    },
    {
      type: 1,
      name: "models",
      description: "List available Codex models",
    },
    {
      type: 1,
      name: "model",
      description: "Change the Codex model",
      options: [
        {
          type: 3,
          name: "name",
          description: "Model ID or default",
          required: true,
          min_length: 1,
          max_length: 256,
        },
      ],
    },
    {
      type: 1,
      name: "reasoning",
      description: "Change the reasoning effort",
      options: [
        {
          type: 3,
          name: "effort",
          description: "Reasoning effort or default",
          required: true,
          min_length: 1,
          max_length: 64,
        },
      ],
    },
    {
      type: 1,
      name: "new",
      description: "Start a new Codex session",
      options: [
        {
          type: 5,
          name: "confirm",
          description: "Confirm replacement of the current session",
          required: false,
        },
      ],
    },
    {
      type: 1,
      name: "interrupt",
      description: "Interrupt the current Codex turn",
    },
    {
      type: 1,
      name: "spawn",
      description: "Create and start a Codex agent",
      options: [
        {
          type: 3,
          name: "bot",
          description: "Registered bot name",
          required: true,
        },
        {
          type: 3,
          name: "workspace",
          description: "Configured workspace name",
          required: true,
        },
      ],
    },
    {
      type: 1,
      name: "stop",
      description: "Stop the current Codex agent",
    },
    {
      type: 1,
      name: "restart",
      description: "Restart the current Codex agent",
    },
  ],
} as const;

interface MutableCommandOption {
  description: string;
  max_length?: number;
  min_length?: number;
  name: string;
  options?: MutableCommandOption[];
  required?: boolean;
  type: number;
}

interface MutableRegisteredCommand {
  application_id?: string;
  contexts?: number[];
  description: string;
  id: string;
  integration_types?: number[];
  name: string;
  options: MutableCommandOption[];
  type: number;
}

function registeredCommand(): MutableRegisteredCommand {
  return structuredClone({
    id: COMMAND_ID,
    application_id: APPLICATION_ID,
    ...CODEX_COMMAND,
  }) as unknown as MutableRegisteredCommand;
}

function alteredCommand(
  alter: (command: MutableRegisteredCommand) => void,
): MutableRegisteredCommand[] {
  const command = registeredCommand();
  alter(command);
  return [command];
}

function requireCommandOption(
  command: MutableRegisteredCommand | MutableCommandOption,
  name: string,
): MutableCommandOption {
  const option = command.options?.find((candidate) => candidate.name === name);
  if (option === undefined) {
    throw new Error(`Missing command fixture option: ${name}`);
  }
  return option;
}

interface RedactedRequest {
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly authorization: {
    readonly present: boolean;
    readonly scheme: string | undefined;
    readonly matches: boolean;
  };
  readonly userAgent: string | undefined;
  readonly contentType: string | undefined;
  readonly body?: unknown;
}

interface FakeDiscordServer {
  readonly fetch: typeof fetch;
  readonly requests: RedactedRequest[];
  readonly requestedUrls: string[];
  readonly server: Server;
}

const servers: Server[] = [];

function authorizationSummary(request: IncomingMessage): RedactedRequest["authorization"] {
  const authorization = request.headers.authorization;
  const expected = `Bot ${TOKEN}`;
  const matches =
    authorization !== undefined &&
    authorization.length === expected.length &&
    timingSafeEqual(Buffer.from(authorization), Buffer.from(expected));
  return {
    present: authorization !== undefined,
    scheme: authorization?.split(" ", 1)[0],
    matches,
  };
}

async function readJsonRequest(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

async function startDiscordServer(
  handler?: (
    request: IncomingMessage,
    response: ServerResponse,
    requests: RedactedRequest[],
  ) => Promise<void> | void,
): Promise<FakeDiscordServer> {
  const requests: RedactedRequest[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (handler !== undefined) {
        await handler(request, response, requests);
        return;
      }

      const captured: RedactedRequest = {
        method: request.method,
        path: request.url,
        authorization: authorizationSummary(request),
        userAgent: request.headers["user-agent"],
        contentType: request.headers["content-type"],
      };
      requests.push(captured);

      if (request.method === "GET" && request.url === "/users/@me") {
        sendJson(response, 200, { id: BOT_USER_ID, bot: true, username: "bridge" });
        return;
      }
      if (request.method === "GET" && request.url === "/oauth2/applications/@me") {
        sendJson(response, 200, {
          id: APPLICATION_ID,
          name: "Bridge",
          bot: { id: BOT_USER_ID, bot: true },
        });
        return;
      }
      if (request.method === "PUT" && request.url === `/applications/${APPLICATION_ID}/commands`) {
        const body = await readJsonRequest(request);
        requests[requests.length - 1] = { ...captured, body };
        sendJson(response, 200, [
          {
            id: COMMAND_ID,
            application_id: APPLICATION_ID,
            ...CODEX_COMMAND,
          },
        ]);
        return;
      }
      sendJson(response, 404, { message: "not found" });
    })().catch(() => {
      response.destroy();
    });
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected an IP test server address");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const requestedUrls: string[] = [];
  const fetchImplementation: typeof fetch = async (input, init) => {
    const requestedUrl = fetchInputUrl(input);
    requestedUrls.push(requestedUrl);
    const parsedUrl = new URL(requestedUrl);
    if (parsedUrl.origin !== "https://discord.com" || !parsedUrl.pathname.startsWith("/api/v10/")) {
      throw new Error("Unexpected Discord API URL");
    }
    const loopbackPath = parsedUrl.pathname.slice("/api/v10".length);
    return fetch(new URL(`${loopbackPath}${parsedUrl.search}`, baseUrl), init);
  };
  return {
    fetch: fetchImplementation,
    requests,
    requestedUrls,
    server,
  };
}

async function expectBridgeError(
  promise: Promise<unknown>,
  code: BridgeErrorCode,
): Promise<BridgeError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BridgeError);
    expect(error).toMatchObject({ code });
    return error as BridgeError;
  }
  throw new Error(`Expected BridgeError with code ${code}`);
}

function serializedError(error: BridgeError): string {
  return JSON.stringify({
    name: error.name,
    code: error.code,
    message: error.message,
    remediation: error.remediation,
    cause: error.cause instanceof Error ? error.cause.message : error.cause,
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error !== undefined) {
              reject(error);
            } else {
              resolve();
            }
          });
        }),
    ),
  );
});

describe("verifyBotToken", () => {
  it("uses the documented fixed Discord bot User-Agent", () => {
    expect(DISCORD_API_USER_AGENT).toBe(
      "DiscordBot (https://github.com/ksk0605/codex-discord-bridge-public, 0.1.0)",
    );
  });

  it("verifies the bot user and current application over Discord API v10 semantics", async () => {
    const fake = await startDiscordServer();

    await expect(verifyBotToken(TOKEN, { fetch: fake.fetch })).resolves.toEqual({
      applicationId: APPLICATION_ID,
      botUserId: BOT_USER_ID,
    });

    expect(fake.requests).toEqual([
      {
        method: "GET",
        path: "/users/@me",
        authorization: { present: true, scheme: "Bot", matches: true },
        userAgent: DISCORD_API_USER_AGENT,
        contentType: undefined,
      },
      {
        method: "GET",
        path: "/oauth2/applications/@me",
        authorization: { present: true, scheme: "Bot", matches: true },
        userAgent: DISCORD_API_USER_AGENT,
        contentType: undefined,
      },
    ]);
    expect(JSON.stringify(fake.requests).includes(TOKEN)).toBe(false);
    expect(fake.requestedUrls).toEqual([
      `${DISCORD_API_BASE_URL}/users/@me`,
      `${DISCORD_API_BASE_URL}/oauth2/applications/@me`,
    ]);
  });

  it("fails closed when the application bot ID does not match the current user", async () => {
    const fake = await startDiscordServer((request, response, requests) => {
      requests.push({
        method: request.method,
        path: request.url,
        authorization: authorizationSummary(request),
        userAgent: request.headers["user-agent"],
        contentType: request.headers["content-type"],
      });
      if (request.url === "/users/@me") {
        sendJson(response, 200, { id: BOT_USER_ID, bot: true });
      } else {
        sendJson(response, 200, {
          id: APPLICATION_ID,
          bot: { id: "200000000000000099", bot: true },
        });
      }
    });

    await expectBridgeError(verifyBotToken(TOKEN, { fetch: fake.fetch }), "CONFIGURATION");
  });

  it.each([
    ["non-bot current user", { id: BOT_USER_ID, bot: false }],
    ["invalid user snowflake", { id: "not-a-snowflake", bot: true }],
  ])("rejects a malformed current user: %s", async (_label, userBody) => {
    const fake = await startDiscordServer((request, response) => {
      if (request.url === "/users/@me") {
        sendJson(response, 200, userBody);
      } else {
        sendJson(response, 200, { id: APPLICATION_ID, bot: { id: BOT_USER_ID } });
      }
    });

    await expectBridgeError(verifyBotToken(TOKEN, { fetch: fake.fetch }), "CONFIGURATION");
  });

  it.each([401, 403])("maps HTTP %i to UNAUTHORIZED without exposing the body", async (status) => {
    const fake = await startDiscordServer((_request, response) => {
      sendJson(response, status, { message: TOKEN });
    });

    const error = await expectBridgeError(
      verifyBotToken(TOKEN, { fetch: fake.fetch }),
      "UNAUTHORIZED",
    );

    expect(serializedError(error).includes(TOKEN)).toBe(false);
  });

  it.each([
    [429, "RUNTIME"],
    [500, "RUNTIME"],
    [400, "CONFIGURATION"],
  ] as const)("maps HTTP %i to %s", async (status, code) => {
    const fake = await startDiscordServer((_request, response) => {
      sendJson(response, status, { message: TOKEN });
    });

    await expectBridgeError(verifyBotToken(TOKEN, { fetch: fake.fetch }), code);
  });

  it("bounds request duration and aborts a stalled response", async () => {
    const fake = await startDiscordServer((_request, response) => {
      response.on("close", () => undefined);
    });

    await expectBridgeError(verifyBotToken(TOKEN, { fetch: fake.fetch, timeoutMs: 30 }), "TIMEOUT");
  });

  it("caps response bytes before JSON parsing", async () => {
    const fake = await startDiscordServer((_request, response) => {
      sendJson(response, 200, { id: BOT_USER_ID, bot: true, padding: "x".repeat(1_000) });
    });

    await expectBridgeError(
      verifyBotToken(TOKEN, { fetch: fake.fetch, maxResponseBytes: 64 }),
      "RUNTIME",
    );
  });

  it("redacts token-bearing network causes", async () => {
    const fetchImplementation: typeof fetch = async () => {
      throw new Error(`network failure with ${TOKEN}`);
    };

    const error = await expectBridgeError(
      verifyBotToken(TOKEN, { fetch: fetchImplementation }),
      "RUNTIME",
    );

    expect(serializedError(error).includes(TOKEN)).toBe(false);
    expect(error.cause).toBeUndefined();
  });

  it("disables automatic redirects for authenticated requests", async () => {
    let redirectPolicy: RequestInit["redirect"];
    const fetchImplementation: typeof fetch = async (_input, init) => {
      redirectPolicy = init?.redirect;
      throw new Error("stop after inspecting redacted request metadata");
    };

    await expectBridgeError(verifyBotToken(TOKEN, { fetch: fetchImplementation }), "RUNTIME");

    expect(redirectPolicy).toBe("error");
  });

  it.each([
    ["empty token", ""],
    ["oversized token", "x".repeat(MAX_DISCORD_TOKEN_BYTES + 1)],
  ])("rejects an %s before fetching", async (_label, token) => {
    let fetchCalls = 0;
    const fetchImplementation: typeof fetch = async () => {
      fetchCalls += 1;
      throw new Error("fetch must not be called");
    };

    await expectBridgeError(
      verifyBotToken(token, { fetch: fetchImplementation }),
      "INVALID_ARGUMENT",
    );
    expect(fetchCalls).toBe(0);
  });

  it.each([
    ["newline", "token\nvalue"],
    ["carriage return", "token\rvalue"],
    ["NUL", "token\0value"],
    ["tab", "token\tvalue"],
    ["leading space", " token-value"],
    ["trailing space", "token-value "],
    ["internal ordinary space", "token value"],
    ["DEL", "token\u007fvalue"],
    ["C1 control", "token\u0085value"],
    ["non-breaking space", "token\u00a0value"],
    ["zero-width space", "token\u200bvalue"],
    ["format character", "token\u2060value"],
    ["Unicode letter", "token-\u00e9"],
    ["non-header Unicode", "token-\u{1f680}"],
    ["lone surrogate", "token\ud800value"],
  ])("rejects a token containing %s before fetching", async (_label, token) => {
    let fetchCalls = 0;
    const fetchImplementation: typeof fetch = async () => {
      fetchCalls += 1;
      throw new Error("fetch must not be called");
    };

    const error = await expectBridgeError(
      verifyBotToken(token, { fetch: fetchImplementation }),
      "INVALID_ARGUMENT",
    );

    expect(fetchCalls).toBe(0);
    expect(error.cause).toBeUndefined();
    expect(serializedError(error).includes(token)).toBe(false);
  });

  it("preserves realistic Discord token punctuation", async () => {
    const token = "test-token.segment_with_underscore.segment-with-hyphen";
    let fetchCalls = 0;
    const fetchImplementation: typeof fetch = async () => {
      fetchCalls += 1;
      throw new Error("expected network stop after token validation");
    };

    await expectBridgeError(verifyBotToken(token, { fetch: fetchImplementation }), "RUNTIME");
    expect(fetchCalls).toBe(1);
  });

  it("does not expose an API base option and rejects runtime attempts to set one", async () => {
    let fetchCalls = 0;
    const fetchImplementation: typeof fetch = async () => {
      fetchCalls += 1;
      throw new Error("fetch must not be called");
    };
    const options: DiscordApiOptions = {
      fetch: fetchImplementation,
      // @ts-expect-error Authenticated Discord requests have no caller-controlled base URL.
      apiBaseUrl: "https://attacker.invalid/api/v10",
    };

    await expectBridgeError(verifyBotToken(TOKEN, options), "CONFIGURATION");
    expect(fetchCalls).toBe(0);
  });

  it("rejects a non-object options value as CONFIGURATION", async () => {
    await expectBridgeError(
      verifyBotToken(TOKEN, null as unknown as Parameters<typeof verifyBotToken>[1]),
      "CONFIGURATION",
    );
  });

  it("rejects an array options value before fetching", async () => {
    let fetchCalls = 0;
    const malformedOptions = Object.assign([], {
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("fetch must not be called");
      },
    }) as unknown as Parameters<typeof verifyBotToken>[1];

    await expectBridgeError(verifyBotToken(TOKEN, malformedOptions), "CONFIGURATION");
    expect(fetchCalls).toBe(0);
  });
});

describe("registerApplicationCommands", () => {
  it("bulk-overwrites the single global codex command with nine subcommands", async () => {
    const fake = await startDiscordServer();

    await expect(
      registerApplicationCommands(APPLICATION_ID, TOKEN, { fetch: fake.fetch }),
    ).resolves.toEqual([{ id: COMMAND_ID, name: "codex" }]);

    expect(fake.requests).toEqual([
      {
        method: "PUT",
        path: `/applications/${APPLICATION_ID}/commands`,
        authorization: { present: true, scheme: "Bot", matches: true },
        userAgent: DISCORD_API_USER_AGENT,
        contentType: "application/json",
        body: [CODEX_COMMAND],
      },
    ]);
    expect(JSON.stringify(fake.requests).includes(TOKEN)).toBe(false);
    expect(fake.requestedUrls).toEqual([
      `${DISCORD_API_BASE_URL}/applications/${APPLICATION_ID}/commands`,
    ]);
  });

  it("accepts Discord omitting the default false value for optional command options", async () => {
    const fake = await startDiscordServer(async (request, response) => {
      await readJsonRequest(request);
      const command = registeredCommand();
      delete requireCommandOption(requireCommandOption(command, "new"), "confirm").required;
      sendJson(response, 200, [command]);
    });

    await expect(
      registerApplicationCommands(APPLICATION_ID, TOKEN, { fetch: fake.fetch }),
    ).resolves.toEqual([{ id: COMMAND_ID, name: "codex" }]);
  });

  it.each([
    ["non-array response", () => registeredCommand()],
    ["missing command", () => []],
    [
      "extra command",
      () => {
        const command = registeredCommand();
        return [command, { ...structuredClone(command), id: "300000000000000002" }];
      },
    ],
    [
      "missing application ID",
      () =>
        alteredCommand((command) => {
          delete command.application_id;
        }),
    ],
    [
      "wrong application ID",
      () =>
        alteredCommand((command) => {
          command.application_id = "100000000000000099";
        }),
    ],
    [
      "wrong command name",
      () =>
        alteredCommand((command) => {
          command.name = "other";
        }),
    ],
    [
      "missing subcommand",
      () =>
        alteredCommand((command) => {
          command.options.splice(2, 1);
        }),
    ],
    [
      "reordered subcommands",
      () =>
        alteredCommand((command) => {
          command.options.reverse();
        }),
    ],
    [
      "duplicated subcommand",
      () =>
        alteredCommand((command) => {
          command.options.push(structuredClone(requireCommandOption(command, "status")));
        }),
    ],
    [
      "extra subcommand",
      () =>
        alteredCommand((command) => {
          command.options.push({
            type: 1,
            name: "extra",
            description: "Unexpected extra subcommand",
          });
        }),
    ],
    [
      "altered subcommand",
      () =>
        alteredCommand((command) => {
          requireCommandOption(command, "status").description = "Altered status description";
        }),
    ],
    [
      "missing new.confirm option",
      () =>
        alteredCommand((command) => {
          requireCommandOption(command, "new").options = [];
        }),
    ],
    [
      "altered new.confirm option",
      () =>
        alteredCommand((command) => {
          requireCommandOption(requireCommandOption(command, "new"), "confirm").required = true;
        }),
    ],
    [
      "missing model.name lower bound",
      () =>
        alteredCommand((command) => {
          delete requireCommandOption(requireCommandOption(command, "model"), "name").min_length;
        }),
    ],
    [
      "altered model.name option",
      () =>
        alteredCommand((command) => {
          requireCommandOption(requireCommandOption(command, "model"), "name").name = "id";
        }),
    ],
    [
      "missing reasoning.effort upper bound",
      () =>
        alteredCommand((command) => {
          delete requireCommandOption(requireCommandOption(command, "reasoning"), "effort")
            .max_length;
        }),
    ],
    [
      "altered reasoning.effort type",
      () =>
        alteredCommand((command) => {
          requireCommandOption(requireCommandOption(command, "reasoning"), "effort").type = 4;
        }),
    ],
    [
      "extra model option",
      () =>
        alteredCommand((command) => {
          requireCommandOption(command, "model").options?.push({
            type: 3,
            name: "extra",
            description: "Unexpected extra option",
          });
        }),
    ],
    [
      "missing spawn.workspace option",
      () =>
        alteredCommand((command) => {
          const spawn = requireCommandOption(command, "spawn");
          if (spawn.options === undefined) {
            throw new Error("Missing spawn command fixture options");
          }
          spawn.options = spawn.options.filter((option) => option.name !== "workspace");
        }),
    ],
    [
      "altered spawn.bot option",
      () =>
        alteredCommand((command) => {
          requireCommandOption(requireCommandOption(command, "spawn"), "bot").type = 4;
        }),
    ],
    [
      "missing contexts",
      () =>
        alteredCommand((command) => {
          delete command.contexts;
        }),
    ],
    [
      "altered contexts",
      () =>
        alteredCommand((command) => {
          command.contexts = [0, 2];
        }),
    ],
    [
      "altered integration types",
      () =>
        alteredCommand((command) => {
          command.integration_types = [1];
        }),
    ],
  ] satisfies ReadonlyArray<readonly [string, () => unknown]>)(
    "rejects malformed bulk-overwrite output: %s",
    async (_label, responseBodyFactory) => {
      const fake = await startDiscordServer(async (request, response) => {
        await readJsonRequest(request);
        sendJson(response, 200, responseBodyFactory());
      });

      await expectBridgeError(
        registerApplicationCommands(APPLICATION_ID, TOKEN, { fetch: fake.fetch }),
        "CONFIGURATION",
      );
    },
  );

  it("rejects an invalid application snowflake before fetching", async () => {
    let fetchCalls = 0;
    const fetchImplementation: typeof fetch = async () => {
      fetchCalls += 1;
      throw new Error("fetch must not be called");
    };

    await expectBridgeError(
      registerApplicationCommands("not-a-snowflake", TOKEN, {
        fetch: fetchImplementation,
      }),
      "INVALID_ARGUMENT",
    );
    expect(fetchCalls).toBe(0);
  });
});
