import { createContext } from "react";
import type { GenuiClient } from "../client/host.ts";

/** What a block needs to know about the answer it sits in. */
export interface GenuiMessage {
  readonly messageId: string;
  /** Epoch ms of the message's creation: the block's frozen clock. */
  readonly createdAt: number;
  readonly streaming: boolean;
}

export const GenuiMessageContext = createContext<GenuiMessage | null>(null);

/** Overrides the page's Worker client; tests run the engine in-process. */
export const GenuiClientContext = createContext<GenuiClient | null>(null);

export interface HandlerRef {
  readonly $h: number;
  readonly rev: number;
}

/** Which DOM event triggered a handler; the host decides what it may do. */
export interface TrustedEvent {
  readonly event: "click" | "change";
  readonly tag: string;
}

export type Dispatch = (
  ref: HandlerRef,
  args: readonly unknown[],
  trusted: TrustedEvent,
) => Promise<void>;

export const DispatchContext = createContext<Dispatch>(async () => {});
