import { Exit, Schema } from "effect";

/**
 * One `ipcMain.handle` listener for a channel only the server's page may call:
 * the sender is checked on every call, then the payload is decoded against
 * `payload`, so `run` never sees a shape the contract does not name.
 */
export const pageHandler = <Event, S extends Schema.Decoder<unknown>, A>(
  allowed: (event: Event) => boolean,
  payload: S,
  run: (input: S["Type"]) => A,
  invalid = "Malformed request.",
) => {
  const decode = Schema.decodeUnknownExit(payload);
  return (event: Event, raw?: unknown): A => {
    if (!allowed(event)) throw new Error("Not allowed from this page.");
    const decoded = decode(raw);
    if (Exit.isFailure(decoded)) throw new Error(invalid);
    return run(decoded.value);
  };
};
