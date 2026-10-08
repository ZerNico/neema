import { createContext } from "react";
import type { GenuiClient } from "../client/host.ts";

export interface SavedUiState {
  readonly sourceHash: string;
  /** The state JSON the block's runtime reported. */
  readonly state: string;
}

/** What a block needs to know about the answer it sits in. */
export interface GenuiMessage {
  readonly messageId: string;
  /** Epoch ms of the message's creation: the block's frozen clock. */
  readonly createdAt: number;
  readonly streaming: boolean;
  /** The attempt that wrote the answer; a save names it so a later attempt refuses it. */
  readonly generationId?: string | null;
  /** Saved state by block ordinal, from the conversation's stored rows. */
  readonly saved?: ReadonlyMap<number, SavedUiState>;
}

export interface UiStateSave {
  readonly messageId: string;
  readonly generationId: string;
  readonly ordinal: number;
  readonly sourceHash: string;
  readonly state: string;
}

/**
 * What blocks may do to the conversation, from the chat view. Absent where
 * no conversation can act (a preview), which leaves suggestions disabled and
 * state unsaved.
 */
export interface GenuiActions {
  /** The conversation's last message; only its blocks may send. */
  readonly tailId: string | undefined;
  readonly disabled: boolean;
  /** Sends a follow-up as an ordinary message. */
  readonly send: (text: string) => void;
  /** Puts text in the composer for the reader to send. */
  readonly offer: (text: string) => void;
  readonly save: (input: UiStateSave) => void;
}

export const GenuiActionsContext = createContext<GenuiActions | null>(null);

/** A suggestion chip's click; null while the answer may not send. */
export const SuggestContext = createContext<((text: string) => void) | null>(null);

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
