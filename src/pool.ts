// Bounded-concurrency runner for bench (ROADMAP #10). Own ~10 lines instead of
// a p-limit dep. Workers pull from a shared queue; an item rejection rejects
// the whole pool (bench catches per-unit errors itself, so nothing escapes).

export async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await fn(item);
    }
  });
  await Promise.all(workers);
}
