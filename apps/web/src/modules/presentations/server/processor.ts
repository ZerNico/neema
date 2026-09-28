import { Context, Effect, Layer } from "effect";
import { PresentationFonts } from "./fonts.ts";
import { PresentationWorkers, type PresentationRuntime } from "./runtime.ts";

/**
 * The worker pool as chat tools and authorized attachment previews use it.
 * Renders and edits (which measure text) pick up the uploaded font faces here,
 * so no caller has to remember them.
 */
export class PresentationProcessor extends Context.Service<
  PresentationProcessor,
  PresentationRuntime
>()("chat/presentations/PresentationProcessor") {
  static readonly layer = Layer.effect(
    PresentationProcessor,
    Effect.gen(function* () {
      const fonts = yield* PresentationFonts;
      const runtime = yield* PresentationWorkers;
      const context = yield* Effect.context<never>();
      return {
        ...runtime,
        run: (request, signal, options) =>
          request.kind === "render" || request.kind === "edit"
            ? Effect.runPromiseWith(context)(
                fonts.faces().pipe(
                  Effect.flatMap((faces) =>
                    Effect.tryPromise({
                      try: () => runtime.run({ ...request, fonts: faces }, signal, options),
                      catch: (error) => error,
                    }),
                  ),
                ),
              )
            : runtime.run(request, signal, options),
      } satisfies PresentationRuntime;
    }),
  ).pipe(Layer.provide(PresentationWorkers.layer));
}
