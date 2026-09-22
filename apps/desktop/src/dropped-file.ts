import { Effect, Schema } from "effect";
import {
  DesktopError,
  DroppedFileStageInput,
  refusalReply,
  StagedFileReceipt,
  type DroppedFileStageInput as DroppedFileStageInputValue,
  type StagedFileReceipt as StagedFileReceiptValue,
} from "@chat/desktop-rpc";
import { isPageSender } from "./chrome.ts";
import { toOrigin } from "./config.ts";

interface PageContents {
  readonly mainFrame: { readonly url: string };
}

interface DroppedFileEvent {
  readonly sender: PageContents;
  readonly senderFrame: { readonly url: string } | null;
}

/** Keeps sender authorization and private host-path decoding on one tested boundary. */
export const makeDroppedFileHandler =
  <R>(options: {
    readonly contents: () => PageContents | undefined;
    readonly origin: () => string | null;
    readonly stage: (
      input: DroppedFileStageInputValue,
      sourcePath: string,
    ) => Effect.Effect<StagedFileReceiptValue, DesktopError, R>;
    readonly run: <A>(effect: Effect.Effect<A, never, R>) => Promise<A>;
  }) =>
  async (event: DroppedFileEvent, message: unknown) => {
    const origin = options.origin();
    if (
      !isPageSender(event, options.contents(), (url) => origin !== null && toOrigin(url) === origin)
    )
      return refusalReply("failed", "Not allowed from this page.");

    const { payload, sourcePath } = (message ?? {}) as {
      payload?: unknown;
      sourcePath?: unknown;
    };
    if (typeof sourcePath !== "string") return refusalReply("failed", "Malformed request.");

    const outcome = await options.run(
      Effect.gen(function* () {
        const input = yield* Schema.decodeUnknownEffect(DroppedFileStageInput)(payload).pipe(
          Effect.mapError(
            () => new DesktopError({ reason: "failed", message: "Malformed request." }),
          ),
        );
        const receipt = yield* options.stage(input, sourcePath);
        return yield* Schema.encodeEffect(StagedFileReceipt)(receipt).pipe(
          Effect.mapError(
            () => new DesktopError({ reason: "failed", message: "Could not encode the reply." }),
          ),
        );
      }).pipe(Effect.result),
    );
    return outcome._tag === "Success"
      ? { ok: true as const, value: outcome.success }
      : refusalReply(outcome.failure.reason, outcome.failure.message);
  };
