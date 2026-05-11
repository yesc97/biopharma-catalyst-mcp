/**
 * Process-wide token bucket for SEC requests.
 *
 * SEC.gov enforces 10 req/sec per IP. Going over triggers a 10-minute block.
 * Wrap every SEC.gov / data.sec.gov axios call in `throttleSec(...)` so the
 * entire process respects a conservative cap, regardless of which connector
 * (sec, xbrl, insider) is firing concurrently.
 */

const MIN_INTERVAL_MS = 200; // ~5 req/sec, well under SEC's 10/sec ceiling

let lastCallAt = 0;
let chain: Promise<void> = Promise.resolve();

export function throttleSec<T>(fn: () => Promise<T>): Promise<T> {
  const result = chain.then(async () => {
    const now = Date.now();
    const wait = Math.max(0, lastCallAt + MIN_INTERVAL_MS - now);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
    return fn();
  });
  // Keep the chain alive for sequencing, but don't let an error in one task
  // poison the whole chain.
  chain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
