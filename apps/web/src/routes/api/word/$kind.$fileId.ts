import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { WordError } from "~/modules/word/errors.ts";
import { WordProcessor } from "~/modules/word/server/runtime.ts";
import { jsonPreview, officePreviewHandler } from "~/server/office-preview.ts";
import { runtime } from "~/server/runtime.ts";

/**
 * An authorized Word file as bounded, structured text (roles, runs, tables)
 * for people; the client lays it out, so nothing here is markup. Only reads.
 */
export const Route = createFileRoute("/api/word/$kind/$fileId")({
  server: {
    handlers: {
      GET: officePreviewHandler({
        family: "word",
        noun: "document",
        query: () => ({}),
        missing: "Not found",
        key: () => "",
        produce: async (bytes, _query, { signal, owner }) => {
          const processor = await runtime.runPromise(
            Effect.gen(function* () {
              return yield* WordProcessor;
            }),
          );
          return jsonPreview(
            await processor.run({ kind: "preview", bytes }, signal, {
              priority: "background",
              owner,
            }),
          );
        },
        isError: (error) => error instanceof WordError,
      }),
    },
  },
});
