import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { BridgeError } from "../domain/errors.js";
import { IdentifierSchema } from "../domain/schemas.js";

// One request per connection: the client writes a single JSON line and the server
// answers with a single JSON line. The socket file (0600, inside a 0700 directory) is
// the only access control, so only the bridge's own OS user can inject turns.

const MAX_REQUEST_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const CLIENT_TIMEOUT_MS = 60_000;
const CLOSE_GRACE_MS = 15_000;
// sun_path is 104 bytes on macOS and 108 on Linux, including the trailing NUL.
const MAX_SOCKET_PATH_BYTES = process.platform === "darwin" ? 103 : 107;

export type InjectSocketHandler = (request: unknown) => Promise<unknown>;

export interface InjectSocketServer {
  close(): Promise<void>;
}

export function injectSocketPath(paths: { readonly root: string }, instanceId: string): string {
  const parsed = IdentifierSchema.safeParse(instanceId);
  if (!parsed.success) throw new BridgeError("INVALID_ARGUMENT", "Invalid instance ID.");
  return join(paths.root, "run", `${parsed.data}.sock`);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function assertPathLength(socketPath: string): void {
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    throw new BridgeError(
      "CONFIGURATION",
      `Inject socket path is too long for this platform: ${socketPath}`,
      "Use a shorter CODEX_DISCORD_STATE_ROOT.",
    );
  }
}

function probe(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(socketPath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
  if (!entry.isSocket()) {
    throw new BridgeError("CONFIGURATION", `Inject socket path is not a socket: ${socketPath}`);
  }
  if (await probe(socketPath)) {
    throw new BridgeError("CONFLICT", `Another process is already listening on ${socketPath}`);
  }
  await unlink(socketPath);
}

function respond(socket: Socket, body: unknown): void {
  // Stop reading and close as soon as the single response has been flushed.
  socket.removeAllListeners("data");
  socket.pause();
  socket.end(`${JSON.stringify(body)}\n`, () => socket.destroy());
}

function serve(
  socket: Socket,
  handle: InjectSocketHandler,
  onError: (error: unknown) => void,
  idleTimeoutMs: number,
  markHandling: () => void,
): void {
  let buffer = "";
  socket.setEncoding("utf8");
  // Only waiting for the request line is bounded; handling may take longer (interrupts,
  // Discord rate limits) and must not be cut off after it already took effect.
  socket.setTimeout(idleTimeoutMs, () => socket.destroy());
  socket.on("error", () => undefined);
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
      respond(socket, { ok: false, code: "INVALID_REQUEST", message: "Request is too large." });
      return;
    }
    const newline = buffer.indexOf("\n");
    if (newline === -1) return;
    socket.setTimeout(0);
    socket.removeAllListeners("data");
    markHandling();
    let request: unknown;
    try {
      request = JSON.parse(buffer.slice(0, newline));
    } catch {
      respond(socket, { ok: false, code: "INVALID_REQUEST", message: "Request is not JSON." });
      return;
    }
    handle(request).then(
      (response) => respond(socket, response),
      (error) => {
        onError(error);
        respond(socket, { ok: false, code: "INTERNAL", message: "Inject request failed." });
      },
    );
  });
}

export async function startInjectSocketServer(options: {
  readonly socketPath: string;
  readonly handle: InjectSocketHandler;
  readonly onError?: (error: unknown) => void;
  readonly idleTimeoutMs?: number;
}): Promise<InjectSocketServer> {
  const { socketPath, handle } = options;
  const onError = options.onError ?? (() => undefined);
  const idleTimeoutMs = options.idleTimeoutMs ?? REQUEST_TIMEOUT_MS;
  assertPathLength(socketPath);
  const directory = dirname(socketPath);
  await mkdir(directory, { mode: 0o700, recursive: true });
  await chmod(directory, 0o700);
  await removeStaleSocket(socketPath);

  // Connections mapped to whether their request is being handled.
  const connections = new Map<Socket, boolean>();
  const server: Server = createServer((socket) => {
    connections.set(socket, false);
    socket.once("close", () => connections.delete(socket));
    serve(socket, handle, onError, idleTimeoutMs, () => connections.set(socket, true));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    await chmod(socketPath, 0o600);
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }

  let closing: Promise<void> | undefined;
  return {
    close: () => {
      // Node unlinks the socket path itself when a Unix-socket server closes. Requests
      // already being handled get a grace period to finish delivering.
      closing ??= new Promise<void>((resolve) => {
        const grace = setTimeout(() => {
          for (const socket of connections.keys()) socket.destroy();
        }, CLOSE_GRACE_MS);
        grace.unref();
        server.close(() => {
          clearTimeout(grace);
          resolve();
        });
        for (const [socket, handling] of connections) if (!handling) socket.destroy();
      });
      return closing;
    },
  };
}

export function sendInjectRequest(
  socketPath: string,
  request: unknown,
  options: { readonly timeoutMs?: number; readonly rawLine?: string } = {},
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    let done = false;
    const finish = (action: () => void) => {
      if (done) return;
      done = true;
      socket.destroy();
      action();
    };
    socket.setEncoding("utf8");
    socket.setTimeout(options.timeoutMs ?? CLIENT_TIMEOUT_MS, () =>
      finish(() =>
        reject(
          new BridgeError(
            "TIMEOUT",
            "Timed out waiting for the agent.",
            "The turn may still have been delivered; check the agent's channel before retrying.",
          ),
        ),
      ),
    );
    socket.once("connect", () => {
      socket.write(`${options.rawLine ?? JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      finish(() => {
        try {
          resolve(JSON.parse(line));
        } catch {
          reject(new BridgeError("RUNTIME", "The agent returned an invalid response."));
        }
      });
    });
    socket.once("error", (error) =>
      finish(() =>
        reject(
          isNodeError(error, "ENOENT") || isNodeError(error, "ECONNREFUSED")
            ? new BridgeError(
                "NOT_FOUND",
                "The agent is not running or has no inject socket.",
                "Start the agent with `codex-discord start <target>` and retry.",
              )
            : new BridgeError("RUNTIME", "Unable to reach the agent.", undefined, {
                cause: error,
              }),
        ),
      ),
    );
    socket.once("end", () =>
      finish(() => reject(new BridgeError("RUNTIME", "The agent closed the connection."))),
    );
  });
}
