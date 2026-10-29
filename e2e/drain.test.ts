import { expect, test } from "bun:test";
import { drainQueue, releaseAfterDrain } from "./drain.ts";

test("cancellation waits for active work and prevents queued work from starting", async () => {
  let stop = false;
  let release!: () => void;
  let started!: () => void;
  const active = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const events: string[] = [];
  const draining = drainQueue({ items: [1, 2, 3], workers: 1, spacingMs: 0, stopped: () => stop,
    sleep: async () => {}, run: async (item) => {
      events.push(`start ${item}`);
      started();
      await active;
      events.push(`cleanup ${item}`);
    } });
  await ready;
  stop = true;
  expect(events).toEqual(["start 1"]);
  release();
  await draining;
  expect(events).toEqual(["start 1", "cleanup 1"]);
});

test("cancellation during start spacing does not start reserved work", async () => {
  let stop = false;
  let wake!: () => void;
  let waiting!: () => void;
  const ready = new Promise<void>((resolve) => { waiting = resolve; });
  const events: number[] = [];
  const draining = drainQueue({ items: [1], workers: 1, spacingMs: 0, stopped: () => stop,
    sleep: () => { waiting(); return new Promise<void>((resolve) => { wake = resolve; }); },
    run: async (item) => { events.push(item); } });
  await ready;
  stop = true;
  wake();
  await draining;
  expect(events).toEqual([]);
});

test("a workflow drain failure leaves the lock held", async () => {
  let locked = true;
  await expect(releaseAfterDrain(async () => { throw new Error("workflow did not finish"); }, async () => { locked = false; }))
    .rejects.toThrow("workflow did not finish");
  expect(locked).toBe(true);
});

test("the lock is released after downstream workflows finish", async () => {
  const events: string[] = [];
  await releaseAfterDrain(async () => { events.push("workflows finished"); }, async () => { events.push("lock released"); });
  expect(events).toEqual(["workflows finished", "lock released"]);
});
