import { Context, Effect, Layer } from "effect";
import { PresentationFonts } from "./fonts.ts";
import type { FontFace } from "./font-file.ts";
import {
  PresentationWorkers,
  type PresentationRunOptions,
  type PresentationRuntime,
  type PresentationJobs,
  type PresentationWork,
} from "./runtime.ts";
import type { JobResult } from "~/server/jobs.ts";

const faceKey = (face: FontFace) => `${face.family.toLowerCase()}|${face.bold}|${face.italic}`;

/** An uploaded face keeps its name: a job's own faces never replace one. */
const withFaces = (uploaded: readonly FontFace[], extra: readonly FontFace[] = []) => {
  const taken = new Set(uploaded.map(faceKey));
  return [...uploaded, ...extra.filter((face) => !taken.has(faceKey(face)))];
};

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
      const processor: PresentationRuntime = {
        close: () => runtime.close(),
        async run<R extends PresentationWork>(
          request: R,
          signal?: AbortSignal,
          options?: PresentationRunOptions,
        ): Promise<JobResult<PresentationJobs, R["kind"]>> {
          if (request.kind !== "render" && request.kind !== "edit" && request.kind !== "chart")
            return runtime.run(request, signal, options);
          const uploaded = await Effect.runPromiseWith(context)(fonts.faces());
          return runtime.run(
            { ...request, fonts: withFaces(uploaded, options?.faces) },
            signal,
            options,
          );
        },
      };
      return processor;
    }),
  ).pipe(Layer.provide(PresentationWorkers.layer));
}
