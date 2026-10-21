import { vi } from "vitest";

/**
 * Tests drive events (including reconnects) explicitly; each suite resets instances.
 */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static readonly CLOSED = 2;
  /** Open unless a test closes it, as a refused response does. */
  readyState = 1;
  private listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  readonly close = vi.fn();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, data?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: data === undefined ? "" : JSON.stringify(data) } as MessageEvent);
    }
  }
}
