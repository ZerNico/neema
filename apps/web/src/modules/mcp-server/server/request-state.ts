import { createHmac } from "node:crypto";
import { createRequestStateCodec } from "@modelcontextprotocol/server";

/** What the app was asked to put to its person, one entry per parked call. */
export interface PersonAsk {
  /** The key the answer comes back under. */
  readonly key: string;
  readonly callId: string;
  /** The parked entry's nonce: an answer to an older one settles nothing. */
  readonly promptId: string;
  readonly kind: "approval" | "form" | "url";
  /** The tool as the person knows it, for saying an answer came too late. */
  readonly label: string;
}

/**
 * The turn a tool call was following when it stopped to ask, carried by the
 * client to the retried call. A retry reads this instead of its arguments, so
 * a re-sent `send_message` never starts a second turn.
 */
export interface TurnRequestState {
  readonly v: 1;
  readonly userId: string;
  readonly clientId: string;
  readonly messageId: string;
  readonly generationId: string | null;
  readonly asks: ReadonlyArray<PersonAsk>;
  /** Every entry put to the person in this call, these included: none is asked twice. */
  readonly seen: ReadonlyArray<string>;
  /** Answers that came too late, carried until the call has a result to report them in. */
  readonly late: ReadonlyArray<string>;
}

/** Its own key, so a signature made here proves nothing anywhere else the secret is used. */
export const requestStateKey = (encryptionKey: string) => {
  const secret = Buffer.from(encryptionKey, "base64");
  // Never a key derived from nothing: the runtime refuses to start without it anyway.
  if (secret.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes, base64-encoded.");
  return createHmac("sha256", secret).update("mcp-server/request-state").digest();
};

/**
 * Well past any wait. A late answer settles nothing anyway (the entry is gone
 * or carries a newer nonce), while a refused state would leave the app with
 * an error and no messageId, and re-sending the message is its next move.
 */
export const turnStateCodec = (key: Uint8Array) =>
  createRequestStateCodec<TurnRequestState>({ key, ttlSeconds: 3600 });
