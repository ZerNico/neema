// Turning a tree's handler references into calls. Shared by every component
// that fires one, the controls in tree.tsx and the drawing in data.tsx alike.

import { use, useEffect, useRef } from "react";
import { DispatchContext, type HandlerRef, type TrustedEvent } from "./context.ts";

export function handlerOf(value: unknown): HandlerRef | undefined {
  if (typeof value !== "object" || value === null || !("$h" in value) || !("rev" in value))
    return undefined;
  const { $h, rev } = value;
  return typeof $h === "number" && typeof rev === "number" ? { $h, rev } : undefined;
}

/**
 * Calls a handler with the latest arguments, one call at a time. A slider
 * fires on every pixel; between replies only the newest value matters, and
 * it is sent through the handler of the tree that reply produced.
 */
export function useHandler(ref: HandlerRef | undefined, trusted: TrustedEvent) {
  const dispatch = use(DispatchContext);
  const inFlight = useRef(false);
  const queued = useRef<readonly unknown[] | null>(null);
  const send = (target: HandlerRef, args: readonly unknown[]) => {
    inFlight.current = true;
    void dispatch(target, args, trusted).finally(() => {
      inFlight.current = false;
    });
  };
  // A queued value goes out once the new tree, with its fresh handler, lands.
  useEffect(() => {
    if (!ref || inFlight.current || !queued.current) return;
    const args = queued.current;
    queued.current = null;
    send(ref, args);
  });
  if (!ref) return undefined;
  return (args: readonly unknown[]) => {
    if (inFlight.current) queued.current = args;
    else send(ref, args);
  };
}
