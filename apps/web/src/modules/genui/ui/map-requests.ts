// Asks the server for the places and routes a finished answer's map computes
// from its state: an {#each} pin, a route over the stops the reader kept.
// What comes back is kept here by message, outside React, so every block of
// the answer and every remount sees it; a reload reads it from the answer.

import { use, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  mergeLookups,
  NO_LOOKUPS,
  type UiLookups,
} from "~/modules/chat/assistant-output.ts";
import type { ValidNode } from "../catalog.ts";
import { BlockOrdinalContext, GenuiActionsContext, GenuiMessageContext } from "./context.ts";
import { mapNeeds } from "./map-model.ts";

/** Edits come in bursts (a filter, then a removal); one request follows them. */
const SETTLE_MS = 300;
/** The server runs one lookup per reader; a busy reply is asked again after this. */
const BUSY_RETRY_MS = 1000;
const MAX_MESSAGES = 200;

const found = new Map<string, UiLookups>();
/** By message, block and needs: asked and waiting, or answered (found or refused). */
const asked = new Map<string, "asking" | "done">();
const listeners = new Set<() => void>();
let version = 0;

function changed() {
  version++;
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => version;

function keep(messageId: string, lookups: UiLookups) {
  found.delete(messageId);
  found.set(messageId, lookups);
  if (found.size > MAX_MESSAGES) {
    const oldest = found.keys().next().value;
    if (oldest !== undefined) found.delete(oldest);
  }
}

/** For tests: forget every result and request. */
export function clearMapRequests() {
  found.clear();
  asked.clear();
  changed();
}

/** The answer's lookups with what the page asked for merged in. */
export function useMessageLookups(): UiLookups {
  const message = use(GenuiMessageContext);
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const base = message?.lookups ?? NO_LOOKUPS;
  const extra = message ? found.get(message.messageId) : undefined;
  // One object per change, not per render: a map redraws when its lookups change.
  return useMemo(() => (extra ? mergeLookups(base, extra) : base), [base, extra]);
}

/**
 * The map's lookups, with what the page asked for merged in, and whether a
 * place or route without a result may still get one.
 */
export function useMapLookups(node: ValidNode): { lookups: UiLookups; waiting: boolean } {
  const message = use(GenuiMessageContext);
  const actions = use(GenuiActionsContext);
  const ordinal = use(BlockOrdinalContext);
  const lookups = useMessageLookups();
  const needs = mapNeeds(node, lookups);
  const streaming = message?.streaming ?? false;
  const canAsk =
    message !== null &&
    actions !== null &&
    !streaming &&
    message.generationId !== undefined &&
    ordinal >= 0 &&
    (needs.places.length > 0 || needs.routes.length > 0);
  const key = canAsk
    ? `${message.messageId}:${message.generationId ?? "copy"}:${ordinal}:${JSON.stringify(needs)}`
    : null;

  // Read through a ref: the key names the needs, message and block, so it alone decides a request.
  const request = useRef({ message, actions, ordinal, needs });
  useEffect(() => {
    request.current = { message, actions, ordinal, needs };
  });

  useEffect(() => {
    if (key === null || asked.has(key)) return;
    let timer: ReturnType<typeof setTimeout>;
    const ask = () => {
      const { message: target, actions: act, ordinal: block, needs: wanted } = request.current;
      if (asked.has(key) || !target || !act) return;
      asked.set(key, "asking");
      void act
        .lookupMap({
          messageId: target.messageId,
          generationId: target.generationId ?? null,
          ordinal: block,
          places: wanted.places,
          routes: wanted.routes,
        })
        .then((result) => {
          if (result.busy) {
            asked.delete(key);
            timer = setTimeout(ask, BUSY_RETRY_MS);
            return;
          }
          asked.set(key, "done");
          if (result.lookups) keep(target.messageId, result.lookups);
          changed();
        });
    };
    timer = setTimeout(ask, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [key]);

  return { lookups, waiting: streaming || (key !== null && asked.get(key) !== "done") };
}
