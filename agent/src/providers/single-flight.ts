/**
 * Wrap an async function so that overlapping calls are dropped: while one call
 * is still running, further calls return immediately without invoking `fn`.
 *
 * Reason: the pollers are driven by `setInterval`, which fires on schedule
 * whether or not the previous tick finished. A poll that stalls now costs
 * several seconds of connect timeouts and retries — longer than the 5s default
 * interval — so a bad network window would otherwise stack overlapping polls,
 * each racing to mutate the same seen-id set and each logging its own failure.
 * Dropping the tick is the right call rather than queueing it: the next
 * interval is only seconds away, and a queue would just replay a backlog of
 * stale polls once the network recovers.
 */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T | undefined> {
  let inFlight = false;
  return async () => {
    if (inFlight) return undefined;
    inFlight = true;
    try {
      return await fn();
    } finally {
      inFlight = false;
    }
  };
}
