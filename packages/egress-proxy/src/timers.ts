import { setTimeout, clearTimeout } from "node:timers";
import type { ProxyOptions } from "./index.ts";

export type Timers = NonNullable<ProxyOptions["timers"]>;

export const defaultTimers: Timers = {
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return () => clearTimeout(handle);
  },
  clearTimeout(handle) {
    if (typeof handle === "function") handle();
  },
};

export class Deadline {
  private cancel: (() => void) | undefined;
  constructor(private readonly timers: Timers) {}

  start(ms: number, fn: () => void) {
    this.clear();
    const handle = this.timers.setTimeout(() => {
      this.cancel = undefined;
      fn();
    }, ms);
    this.cancel = () => this.timers.clearTimeout(handle);
  }

  clear() {
    this.cancel?.();
    this.cancel = undefined;
  }
}
