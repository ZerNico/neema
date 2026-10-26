import { Effect, Schema } from "effect";
import type { RpcGroup } from "effect/rpc";
import { DesktopRpcs } from "./group.ts";
import {
  DesktopError,
  DroppedFileStageInput,
  StagedFileReceipt,
  type DroppedFileStageInput as DroppedFileStageInputType,
  type StagedFileReceipt as StagedFileReceiptType,
} from "./schema.ts";
import type { DesktopChrome } from "./chrome.ts";

/**
 * The transport is a promise-based request/response channel, because that is
 * what `contextBridge` can carry: only structured-cloneable values cross it, and
 * a function returning a promise is the one shape it forwards cleanly.
 *
 * `RpcGroup` still owns the contract. Every payload and result below is encoded
 * and decoded with the schemas declared there, so neither side trusts the other's
 * word about a shape. What is deliberately *not* used is `RpcClient.Protocol`,
 * whose `run`/`send` pair models a duplex stream with acks and transferables.
 * That is the right abstraction for sockets and workers and the wrong one here:
 * it would mean inventing request ids and a receive loop on top of a channel
 * that already answers each call directly.
 */
export interface DesktopChannel {
  /** Bumped when the contract changes shape, so an old shell fails loudly. */
  readonly protocolVersion: number;
  /** Short git sha and build time of the shell, for the reader and for bug reports. */
  readonly build?: string;
  /** The operating system's region format, such as "en-DE", which the page's languages lack. */
  readonly systemLocale?: string;
  readonly chrome?: DesktopChrome;
  /** Stages a real dropped File without exposing its host path to the page. */
  stageDroppedFile(file: File, payload: unknown): Promise<BridgeReply | null>;
  request(tag: string, payload: unknown): Promise<BridgeReply>;
}

export type BridgeReply =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown };

export const PROTOCOL_VERSION = 10;

/** The key `contextBridge` exposes on `window` inside the desktop shell. */
export const BRIDGE_KEY = "__chatDesktop" as const;
/** Private Electron channel used only after preload resolves a real File path. */
export const DROPPED_FILE_CHANNEL = "chat-desktop:stage-dropped-file" as const;

type Rpcs = typeof DesktopRpcs extends RpcGroup.RpcGroup<infer R> ? R : never;
type RpcNamed<Tag extends string> = Extract<Rpcs, { readonly _tag: Tag }>;

export type DesktopTag = Rpcs["_tag"];

/** Calls the desktop, typed from the group. Failures are always `DesktopError`. */
export type DesktopClient = {
  [Tag in DesktopTag]: (
    payload: RpcNamed<Tag>["payloadSchema"]["Type"],
  ) => Effect.Effect<RpcNamed<Tag>["successSchema"]["Type"], DesktopError>;
};

/** What the desktop process implements. */
export type DesktopHandlers = {
  [Tag in DesktopTag]: (
    payload: RpcNamed<Tag>["payloadSchema"]["Type"],
  ) => Effect.Effect<RpcNamed<Tag>["successSchema"]["Type"], DesktopError>;
};

const rpcFor = (tag: string): Rpcs => {
  const rpc = DesktopRpcs.requests.get(tag);
  if (!rpc) throw new Error(`unknown desktop procedure: ${tag}`);
  return rpc;
};

const asDesktopError = (cause: unknown): DesktopError =>
  cause instanceof DesktopError
    ? cause
    : new DesktopError({ reason: "failed", message: String(cause) });

/**
 * Anything that is not a decodable `DesktopError` becomes an opaque failure.
 * A site talking to a shell it does not understand, or a shell answering
 * nonsense, must not surface as a crash in the middle of a tool call.
 */
const decodeFailure = (rpc: Rpcs, encoded: unknown) =>
  Schema.decodeUnknownEffect(rpc.errorSchema)(encoded).pipe(
    Effect.match({
      onSuccess: asDesktopError,
      onFailure: () =>
        new DesktopError({
          reason: "failed",
          message: "The desktop app sent an unreadable reply.",
        }),
    }),
  );

/** Builds the site's client over a channel the preload exposed. */
export const makeDesktopClient = (channel: DesktopChannel): DesktopClient => {
  const call = (tag: string) => (payload: unknown) =>
    Effect.gen(function* () {
      const rpc = rpcFor(tag);
      // The value is `unknown` here only because the caller is generic over
      // tags; the typed surface above already fixed it to this rpc's payload.
      const encoded = yield* Schema.encodeEffect(rpc.payloadSchema)(payload as never).pipe(
        Effect.mapError(
          () => new DesktopError({ reason: "failed", message: "Could not send the request." }),
        ),
      );
      const reply = yield* Effect.tryPromise({
        try: () => channel.request(tag, encoded),
        catch: asDesktopError,
      });
      // `decodeFailure` folds both channels into a value, so it has to be
      // failed explicitly rather than yielded: yielding it would hand the
      // caller an error object as a success.
      if (!reply.ok) return yield* Effect.fail(yield* decodeFailure(rpc, reply.error));
      return yield* Schema.decodeUnknownEffect(rpc.successSchema)(reply.value).pipe(
        Effect.mapError(
          () =>
            new DesktopError({
              reason: "failed",
              message: "The desktop app sent an unreadable reply.",
            }),
        ),
      );
    });

  return Object.fromEntries(
    [...DesktopRpcs.requests.keys()].map((tag) => [tag, call(tag)]),
  ) as DesktopClient;
};

/**
 * The desktop side of the same contract: decode, run, encode. Returns a reply
 * rather than throwing, so a handler failure crosses as data.
 */
/** The wire form of a refusal, so the shell and the responder spell it once. */
export const refusalReply = (reason: DesktopError["reason"], message: string): BridgeReply => ({
  ok: false,
  error: { _tag: "DesktopError", reason, message },
});

export const makeDesktopResponder =
  (handlers: DesktopHandlers) =>
  (tag: string, payload: unknown): Effect.Effect<BridgeReply> =>
    Effect.gen(function* () {
      const rpc = DesktopRpcs.requests.get(tag);
      if (!rpc) return refusalReply("failed", `Unknown request: ${tag}`);
      const decoded = yield* Schema.decodeUnknownEffect(rpc.payloadSchema)(payload).pipe(
        Effect.result,
      );
      if (decoded._tag === "Failure") return refusalReply("failed", "Malformed request.");
      const handler = handlers[tag as DesktopTag] as (
        input: unknown,
      ) => Effect.Effect<unknown, DesktopError>;
      const outcome = yield* handler(decoded.success).pipe(Effect.result);
      if (outcome._tag === "Failure") {
        const failure = asDesktopError(outcome.failure);
        return refusalReply(failure.reason, failure.message);
      }
      const encoded = yield* Schema.encodeEffect(rpc.successSchema)(outcome.success as never).pipe(
        Effect.orDie,
      );
      return { ok: true, value: encoded } as const;
    });

/**
 * Stages a real dropped File while its host path remains inside preload/main.
 * Null means the File has no host path, so the caller may use bounded base64.
 */
export const stageDroppedFile = (
  file: File,
  input: DroppedFileStageInputType,
): Effect.Effect<StagedFileReceiptType | null, DesktopError> =>
  Effect.gen(function* () {
    const channel = readDesktopChannel();
    if (!channel) return null;
    const payload = yield* Schema.encodeEffect(DroppedFileStageInput)(input).pipe(
      Effect.mapError(
        () => new DesktopError({ reason: "failed", message: "Could not stage that file." }),
      ),
    );
    const reply = yield* Effect.tryPromise({
      try: () => channel.stageDroppedFile(file, payload),
      catch: asDesktopError,
    });
    if (reply === null) return null;
    if (!reply.ok) {
      const failure = yield* Schema.decodeUnknownEffect(DesktopError)(reply.error).pipe(
        Effect.catch(() =>
          Effect.succeed(
            new DesktopError({
              reason: "failed",
              message: "The desktop app sent an unreadable reply.",
            }),
          ),
        ),
      );
      return yield* Effect.fail(failure);
    }
    return yield* Schema.decodeUnknownEffect(StagedFileReceipt)(reply.value).pipe(
      Effect.mapError(
        () =>
          new DesktopError({
            reason: "failed",
            message: "The desktop app sent an unreadable reply.",
          }),
      ),
    );
  });

/** True inside the desktop shell, on the origin the shell was pointed at. */
export const readDesktopChannel = (): DesktopChannel | null => {
  const candidate = (globalThis as Record<string, unknown>)[BRIDGE_KEY];
  if (!candidate || typeof candidate !== "object") return null;
  const channel = candidate as Partial<DesktopChannel>;
  if (typeof channel.request !== "function") return null;
  if (typeof channel.stageDroppedFile !== "function") return null;
  if (channel.protocolVersion !== PROTOCOL_VERSION) return null;
  return channel as DesktopChannel;
};

/**
 * A shell is present but speaks another version. Distinct from no shell at
 * all: the reader is inside the desktop app and should be told to update it,
 * rather than shown a browser's "open this in the desktop app".
 */
export const desktopShellOutdated = (): boolean => {
  const candidate = (globalThis as Record<string, unknown>)[BRIDGE_KEY];
  if (!candidate || typeof candidate !== "object") return false;
  const channel = candidate as Partial<DesktopChannel>;
  return typeof channel.request === "function" && channel.protocolVersion !== PROTOCOL_VERSION;
};
