/**
 * At most `perOwner` jobs of one person run at once; more wait in order, so a
 * burst from one chat can't hold every worker of a pool. A cancelled wait
 * leaves the line, and a line past `queue` is refused as busy.
 */
export function createOwnerLimit(options: {
  readonly perOwner: number;
  readonly queue: number;
  readonly busy: () => Error;
  readonly cancelled: () => Error;
}) {
  const owners = new Map<string, { running: number; waiting: Array<() => void> }>();
  const release = (owner: string) => {
    const entry = owners.get(owner)!;
    const next = entry.waiting.shift();
    if (next) next();
    else if (--entry.running === 0) owners.delete(owner);
  };
  const admit = (owner: string, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const entry = owners.get(owner) ?? { running: 0, waiting: [] };
      owners.set(owner, entry);
      if (entry.running < options.perOwner) {
        entry.running++;
        return resolve();
      }
      if (entry.waiting.length >= options.queue) return reject(options.busy());
      const start = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        entry.waiting.splice(entry.waiting.indexOf(start), 1);
        reject(options.cancelled());
      };
      signal?.addEventListener("abort", abort, { once: true });
      entry.waiting.push(start);
    });
  return {
    /** Runs `job` once `owner` has a free slot; no owner means no limit. */
    async run<T>(
      owner: string | undefined,
      signal: AbortSignal | undefined,
      job: () => Promise<T>,
    ) {
      if (owner === undefined) return job();
      await admit(owner, signal);
      try {
        return await job();
      } finally {
        release(owner);
      }
    },
  };
}
