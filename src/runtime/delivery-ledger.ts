import { createHash } from "node:crypto";
import { z } from "zod";
import { AtomicJsonStore } from "../storage/atomic-json.js";

const Input = z
  .object({
    channelId: z.string(),
    messageId: z.string(),
    authorId: z.string(),
    text: z.string(),
    guildId: z.string().optional(),
    announceChannelId: z.string().optional(),
    freshThread: z.boolean().optional(),
  })
  .strict();
export type DurableInput = z.infer<typeof Input>;
const Entry = z.object({
  hash: z.string(),
  state: z.enum(["pending", "running", "finished", "uncertain"]),
  input: Input.optional(),
});
const Document = z.object({ version: z.literal(1), entries: z.record(z.string(), Entry) });
type Document = z.infer<typeof Document>;
function hash(input: DurableInput): string {
  const normalized = Object.fromEntries(
    Object.entries(input).sort(([a], [b]) => a.localeCompare(b)),
  );
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}
// The acceptance record is fsynced before a receipt is returned. Started work is
// deliberately not replayed: model side effects cannot be made exactly-once here.
export class DeliveryLedger {
  private readonly store: AtomicJsonStore<Document>;
  constructor(path: string) {
    this.store = new AtomicJsonStore({
      filePath: path,
      schema: Document,
      initialDocument: () => ({ version: 1, entries: {} }),
    });
  }
  async accept(raw: DurableInput): Promise<boolean> {
    const input = Input.parse(raw),
      fingerprint = hash(input);
    return this.store.transact((d) => {
      const old = d.entries[input.messageId];
      if (old) {
        if (old.hash !== fingerprint) throw new Error("Delivery identity payload mismatch");
        return { document: d, result: false };
      }
      if (Object.keys(d.entries).length >= 10_000)
        throw new Error("Delivery ledger capacity reached; reconcile before accepting more work");
      d.entries[input.messageId] = { hash: fingerprint, state: "pending", input };
      return { document: d, result: true };
    });
  }
  async start(id: string): Promise<void> {
    await this.store.update((d) => {
      const e = d.entries[id];
      if (e?.state !== "pending") throw new Error("Delivery is not pending");
      e.state = "running";
      return d;
    });
  }
  async finish(id: string): Promise<void> {
    await this.store.update((d) => {
      const e = d.entries[id];
      if (!e) throw new Error("Unknown delivery");
      e.state = "finished";
      delete e.input;
      return d;
    });
  }
  async pending(): Promise<DurableInput[]> {
    return Object.values((await this.store.read()).entries)
      .filter((e) => e.state === "pending" && e.input)
      .map((e) => e.input as DurableInput);
  }
  async recover(): Promise<{ pending: DurableInput[]; uncertain: string[] }> {
    return this.store.transact((d) => {
      const uncertain: string[] = [];
      for (const [id, e] of Object.entries(d.entries)) {
        if (e.state === "running") e.state = "uncertain";
        if (e.state === "uncertain") uncertain.push(id);
      }
      return {
        document: d,
        result: {
          pending: Object.values(d.entries)
            .filter((e) => e.state === "pending" && e.input)
            .map((e) => e.input as DurableInput),
          uncertain,
        },
      };
    });
  }
}
