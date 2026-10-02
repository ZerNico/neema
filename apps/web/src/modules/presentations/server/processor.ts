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
 * A family comes from one source, so a deck never mixes two designs under one
 * name: an upload owns it, else a loaded skill's faces, else Google's. Within
 * that source, one face per style.
 */
export const withFaces = (stored: readonly FontFace[], extra: readonly FontFace[] = []) => {
  const all = [...stored, ...extra];
  const owner = new Map<string, number>();
  for (const face of all) {
    const family = face.family.toLowerCase();
    owner.set(family, Math.min(owner.get(family) ?? Infinity, rank[face.source]));
  }
  const chosen = new Map<string, FontFace>();
  for (const face of all)
    if (rank[face.source] === owner.get(face.family.toLowerCase()) && !chosen.has(faceKey(face)))
      chosen.set(faceKey(face), face);
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
