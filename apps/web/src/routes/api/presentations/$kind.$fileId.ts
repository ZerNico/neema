import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { PresentationError } from "~/modules/presentations/errors.ts";
import { drawnFontsKey } from "~/modules/presentations/server/fonts.ts";
import { PresentationProcessor } from "~/modules/presentations/server/processor.ts";
import { officePreviewHandler, jsonPreview } from "~/server/office-preview.ts";
import { runtime } from "~/server/runtime.ts";

/**
 * Approximate PNG slides of an authorized PPTX: the listing without `slide`,
 * one slide's image with it. Only reads; the original stays a download.
 */
export const Route = createFileRoute("/api/presentations/$kind/$fileId")({
  server: {
    handlers: {
      GET: officePreviewHandler({
        family: "presentation",
        noun: "presentation",
        query: (url) => {
          const slide = url.searchParams.get("slide");
          if (slide === null) return { slideId: null };
          const slideId = Number(slide);
          return /^[1-9]\d*$/.test(slide) && Number.isSafeInteger(slideId) ? { slideId } : null;
        },
        missing: "Slide not found",
        // Uploaded faces change what a slide looks like, never the listing.
        key: async ({ slideId }) =>
          slideId === null ? "list" : `slide:${slideId}:${await runtime.runPromise(drawnFontsKey)}`,
        produce: async (bytes, { slideId }, { signal, owner }) => {
          const processor = await runtime.runPromise(
            Effect.gen(function* () {
              return yield* PresentationProcessor;
            }),
          );
          const background = { priority: "background", owner } as const;
          if (slideId === null) {
            const inspection = await processor.run({ kind: "inspect", bytes }, signal, background);
            const slideIds = inspection.slides.map((each) => each.slideId);
            return jsonPreview({
              slideIds,
              count: slideIds.length,
              aspectRatio: inspection.aspectRatio,
            });
          }
          // An unknown slide is the renderer's `not_found`; no inspection first.
          const [slide] = await processor.run(
            { kind: "render", bytes, slideIds: [slideId] },
            signal,
            background,
          );
          if (!slide?.png) throw new Error("Unexpected render result.");
          return { body: slide.png, type: "image/png" };
        },
        isError: (error) => error instanceof PresentationError,
      }),
    },
  },
});
