import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DeliveryLedger } from "../../src/runtime/delivery-ledger.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function setup() {
  const p = await mkdtemp(join(tmpdir(), "delivery-ledger-"));
  dirs.push(p);
  return join(p, "ledger.json");
}
const input = {
  channelId: "123456789012345678",
  messageId: "123456789012345679",
  authorId: "123456789012345680",
  text: "[hub task] test",
};
it("persists pending input before acceptance and deduplicates delivery identity", async () => {
  const p = await setup();
  const a = new DeliveryLedger(p);
  expect(await a.accept(input)).toBe(true);
  expect(await a.accept(input)).toBe(false);
  const b = new DeliveryLedger(p);
  expect(await b.pending()).toEqual([input]);
});
it("never replays started work after a crash and marks it uncertain", async () => {
  const p = await setup();
  const a = new DeliveryLedger(p);
  await a.accept(input);
  await a.start(input.messageId);
  const b = new DeliveryLedger(p);
  expect(await b.recover()).toEqual({ pending: [], uncertain: [input.messageId] });
  expect(await b.accept(input)).toBe(false);
});
it("retains never-started work on shutdown, drops completed payload, rejects identity mutation", async () => {
  const a = new DeliveryLedger(await setup());
  await a.accept(input);
  await expect(a.accept({ ...input, text: "changed" })).rejects.toThrow();
  expect((await a.recover()).pending).toEqual([input]);
  await a.start(input.messageId);
  await a.finish(input.messageId);
  expect(await a.pending()).toEqual([]);
  expect(await a.accept(input)).toBe(false);
});
