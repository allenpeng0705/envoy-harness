/**
 * Bounded rolling-pool map for sub-agent fan-out inside one `task` call.
 * Same concurrency idea as {@link runToolGroupInModelOrder}, but returns
 * results in input order (no transcript commit).
 *
 * If `signal` aborts, unstarted items are skipped. Completed (and still
 * in-flight) work is awaited; the return value contains only defined
 * results in original index order — never sparse holes.
 */

export async function mapBoundedParallel<T, R>(
  items: ReadonlyArray<T>,
  maxParallel: number,
  signal: AbortSignal | undefined,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.floor(maxParallel));
  const results: Array<R | undefined> = new Array(items.length);
  const inFlight = new Set<Promise<void>>();
  let next = 0;

  const start = (index: number): void => {
    const item = items[index]!;
    const task = fn(item, index)
      .then((r) => {
        results[index] = r;
      })
      .finally(() => {
        inFlight.delete(task);
      });
    inFlight.add(task);
  };

  while (next < items.length || inFlight.size > 0) {
    while (
      next < items.length &&
      inFlight.size < limit &&
      !(signal?.aborted ?? false)
    ) {
      start(next);
      next += 1;
    }
    if (inFlight.size === 0) break;
    await Promise.race(inFlight);
  }
  await Promise.all(inFlight);
  return results.filter((r): r is R => r !== undefined);
}
