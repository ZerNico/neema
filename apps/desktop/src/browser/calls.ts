const CALL_MAX_MS = 5 * 60_000;
const CALL_MAX = 512;

export interface BrowserCallContext {
  readonly conversationId: string;
  readonly deadline: number;
  readonly signal: AbortSignal;
  check(): void;
}

/** Main owns expiry and remembers ended identities until no admitted request can be live. */
export function browserCalls(onExpire?: (id: string) => void) {
  const entries = new Map<
    string,
    {
      context: BrowserCallContext;
      controller: AbortController;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const ended = new Map<string, number>();
  let saturatedUntil = 0;
  const retire = (id: string) => {
    const entry = entries.get(id);
    if (entry) {
      entry.controller.abort(new Error("The browser call ended."));
      clearTimeout(entry.timer);
      entries.delete(id);
    }
    ended.set(id, Date.now() + CALL_MAX_MS);
  };
  const expire = (id: string) => {
    retire(id);
    onExpire?.(id);
  };
  const prune = () => {
    for (const [id, until] of ended) if (until <= Date.now()) ended.delete(id);
  };
  return {
    begin(id: string, conversationId: string, deadline: number) {
      prune();
      if (ended.has(id)) throw new Error("The browser call ended.");
      const existing = entries.get(id);
      if (existing) {
        if (
          existing.context.conversationId !== conversationId ||
          existing.context.deadline !== deadline
        )
          throw new Error("The browser call identity changed.");
        existing.context.check();
        return;
      }
      if (
        !Number.isFinite(deadline) ||
        deadline <= Date.now() ||
        deadline > Date.now() + CALL_MAX_MS
      )
        throw new Error("Invalid browser call deadline.");
      if (Date.now() < saturatedUntil || entries.size + ended.size >= CALL_MAX)
        throw new Error("Too many browser calls.");
      const controller = new AbortController();
      const context: BrowserCallContext = {
        conversationId,
        deadline,
        signal: controller.signal,
        check() {
          controller.signal.throwIfAborted();
          if (Date.now() >= deadline) {
            expire(id);
            throw new Error("The browser call expired.");
          }
        },
      };
      const timer = setTimeout(() => expire(id), Math.max(0, deadline - Date.now()));
      entries.set(id, { context, controller, timer });
    },
    get(id: string) {
      const context = entries.get(id)?.context;
      if (!context) throw new Error("The browser call is not live.");
      context.check();
      return context;
    },
    end(id: string) {
      prune();
      // If a cancellation cannot be remembered, refuse starts until every
      // request admitted before it would have expired, even as old entries prune.
      if (entries.has(id) || ended.has(id) || entries.size + ended.size < CALL_MAX) retire(id);
      else saturatedUntil = Date.now() + CALL_MAX_MS;
    },
    clear() {
      for (const id of entries.keys()) retire(id);
    },
  };
}

/** Bounds even a dependency that ignores abort, without claiming to undo its effects. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
