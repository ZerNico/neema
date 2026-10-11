import type { Transaction } from "@tiptap/pm/state";

/** Set on a transaction that loads the server's document wholesale. */
export const SERVER_RESET = "documentServerReset";

/**
 * Whether a transaction came from someone else: steps received from the
 * server (`receiveTransaction` marks them `rebased`), or a reload of the
 * server's document. Plugins that react to the person typing skip these.
 */
export const isRemoteChange = (transaction: Transaction) =>
  transaction.getMeta("rebased") !== undefined || transaction.getMeta(SERVER_RESET) === true;
