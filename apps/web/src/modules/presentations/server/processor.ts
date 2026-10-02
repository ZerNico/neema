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

const rank = { upload: 0, skill: 1, google: 2 } as const;

const missingFonts = (result: unknown): readonly string[] =>
  Array.isArray(result) ? ((result[0] as { missingFonts?: string[] })?.missingFonts ?? []) : [];

/**
 * One face per family and style: an upload keeps its name, a loaded skill's
 * face comes next, and a fetched Google face only fills what neither supplies.
 */
export const withFaces = (stored: readonly FontFace[], extra: readonly FontFace[] = []) => {
  const chosen = new Map<string, FontFace>();
  for (const face of [...stored, ...extra].toSorted((a, b) => rank[a.source] - rank[b.source]))
    if (!chosen.has(faceKey(face))) chosen.set(faceKey(face), face);
  return [...chosen.values()];
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
          const stored = await Effect.runPromiseWith(context)(fonts.faces());
          const result = await runtime.run(
            { ...request, fonts: withFaces(stored, options?.faces) },
            signal,
            options,
          );
          // A preview never waits on a fetch: this one draws a substitute, the next the font.
          const missing = request.kind === "render" ? missingFonts(result) : [];
          if (missing.length) Effect.runForkWith(context)(fonts.ensure(missing));
          return result;
        },
      };
      return processor;
    }),
  ).pipe(Layer.provide(PresentationWorkers.layer));
}
