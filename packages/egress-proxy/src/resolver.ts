import { lookup as systemLookup } from "node:dns";
import { Deadline, type Timers } from "./timers.ts";

type Address = { address: string; family: 4 | 6 };

/** One system lookup: every address for a name, as the operating system resolves it. */
export type Lookup = (host: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;

const lookupAll: Lookup = (host) =>
  new Promise((resolve, reject) => {
    systemLookup(host, { all: true }, (error, addresses) =>
      error ? reject(error) : resolve(addresses),
    );
  });

/**
 * getaddrinfo holds a libuv pool thread for as long as a lookup takes, and the
 * pool has four. Two may resolve at once, so slow names can never stall the
 * file and crypto work sharing that pool.
 */
export const LOOKUP_SLOTS = 2;

/**
 * Admits at most `LOOKUP_SLOTS` lookups. A waiter that gives up leaves the
 * queue; a running lookup cannot be cancelled, so its slot frees only when it
 * settles. That bound is what keeps abandoned lookups from piling up.
 */
export class LookupGate {
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly slots = LOOKUP_SLOTS) {}

  /** Resolves when a slot is free; the returned function frees it. */
  acquire(signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const admit = () => {
        signal.removeEventListener("abort", leave);
        this.running += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.running -= 1;
          this.waiting.shift()?.();
        });
      };
      const leave = () => {
        const index = this.waiting.indexOf(admit);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(new Error("Lookup abandoned"));
      };
      if (signal.aborted) return reject(new Error("Lookup abandoned"));
      if (this.running < this.slots) return admit();
      this.waiting.push(admit);
      signal.addEventListener("abort", leave, { once: true });
    });
  }
}

const sharedGate = new LookupGate();

/**
 * The system resolver, so VPN, split DNS and the hosts file behave as they do
 * for every other program. Names are looked up fully qualified, so search
 * domains can never turn an authorized name into a different one.
 */
export function createDefaultResolver(
  timeoutMs: number,
  timers: Timers,
  lookup: Lookup = lookupAll,
  gate: LookupGate = sharedGate,
) {
  return (host: string, signal: AbortSignal): Promise<ReadonlyArray<Address>> =>
    new Promise((resolve, reject) => {
      const deadline = new Deadline(timers);
      const waiting = new AbortController();
      let settled = false;
      const finish = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        deadline.clear();
        signal.removeEventListener("abort", fail);
        waiting.abort();
        outcome();
      };
      const fail = () => finish(() => reject(new Error("DNS resolution failed")));
      if (signal.aborted) return fail();
      signal.addEventListener("abort", fail, { once: true });
      deadline.start(timeoutMs, fail);
      gate.acquire(waiting.signal).then(
        (release) => {
          if (settled) return release();
          lookup(`${host}.`)
            .then((answers) => {
              const addresses: Address[] = [];
              for (const { address, family } of answers)
                if (family === 4 || family === 6) addresses.push({ address, family });
              finish(() => resolve(addresses));
            }, fail)
            .finally(release);
        },
        () => fail(),
      );
    });
}
