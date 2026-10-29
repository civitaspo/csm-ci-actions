export async function drainQueue<T>(options: {
  items: readonly T[];
  workers: number;
  spacingMs: number;
  stopped: () => boolean;
  run: (item: T) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}): Promise<void> {
  const queue = [...options.items];
  let nextStart = Date.now();
  await Promise.all(Array.from({ length: options.workers }, async () => {
    while (!options.stopped()) {
      const item = queue.shift();
      if (item === undefined) return;
      const startAt = Math.max(nextStart, Date.now());
      nextStart = startAt + options.spacingMs;
      await options.sleep(startAt - Date.now());
      if (options.stopped()) return;
      await options.run(item);
    }
  }));
}

export async function releaseAfterDrain(drain: () => Promise<void>, release: () => Promise<void>): Promise<void> {
  await drain();
  await release();
}
