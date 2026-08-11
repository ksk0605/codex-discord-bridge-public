import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

interface MessageWaiter {
  predicate: (message: Record<string, unknown>) => boolean;
  resolve: (message: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class FakeAppServer {
  readonly clientStdout = new PassThrough();
  readonly clientStdin = new PassThrough();
  readonly messages: Record<string, unknown>[] = [];

  private readonly reader = createInterface({ input: this.clientStdin });
  private readonly waiters = new Set<MessageWaiter>();

  constructor() {
    this.reader.on("line", (line) => {
      const value: unknown = JSON.parse(line);
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Fake App Server received a non-object message");
      }
      const message = value as Record<string, unknown>;
      this.messages.push(message);
      for (const waiter of this.waiters) {
        if (waiter.predicate(message)) {
          clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          waiter.resolve(message);
        }
      }
    });
  }

  send(message: Record<string, unknown>): void {
    this.clientStdout.write(`${JSON.stringify(message)}\n`);
  }

  sendRaw(data: string | Buffer): void {
    this.clientStdout.write(data);
  }

  waitForMessage(
    predicate: (message: Record<string, unknown>) => boolean,
    timeoutMs = 1_000,
  ): Promise<Record<string, unknown>> {
    const existing = this.messages.find(predicate);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const waiter: MessageWaiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error("Timed out waiting for fake App Server message"));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  endStdout(): void {
    this.clientStdout.end();
  }

  close(): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Fake App Server closed"));
    }
    this.waiters.clear();
    this.reader.close();
    this.clientStdout.destroy();
    this.clientStdin.destroy();
  }
}
