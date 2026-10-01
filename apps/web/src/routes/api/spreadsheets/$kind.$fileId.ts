import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { PresentationError } from "~/modules/presentations/errors.ts";
import { drawnFontsKey } from "~/modules/presentations/server/fonts.ts";
import { PresentationProcessor } from "~/modules/presentations/server/processor.ts";
import { SpreadsheetError } from "~/modules/spreadsheets/errors.ts";
import { SpreadsheetProcessor } from "~/modules/spreadsheets/server/runtime.ts";
import { jsonPreview, officePreviewHandler } from "~/server/office-preview.ts";
import { runtime } from "~/server/runtime.ts";

const sheetsProcessor = Effect.gen(function* () {
  return yield* SpreadsheetProcessor;
});
const slidesProcessor = Effect.gen(function* () {
  return yield* PresentationProcessor;
});

/**
 * One sheet of an authorized workbook as a bounded grid of displayed values
 * and plain styles, for people; `sheet` picks the tab. With `chart`, that
 * sheet's chart as an image, drawn by the PowerPoint renderer, which reads
 * the same chart format. Only reads.
 */
export const Route = createFileRoute("/api/spreadsheets/$kind/$fileId")({
  server: {
    handlers: {
      GET: officePreviewHandler({
        family: "spreadsheet",
        noun: "workbook",
        query: (url) => {
          const sheet = url.searchParams.get("sheet");
          const chart = url.searchParams.get("chart");
          if (sheet !== null && (sheet.length === 0 || sheet.length > 31)) return null;
          if (chart !== null && !/^\d{1,2}$/.test(chart)) return null;
          return { sheet, chart: chart === null ? null : Number(chart) };
        },
        missing: "Sheet or chart not found",
        key: async ({ sheet, chart }) =>
          chart === null
            ? (sheet ?? "")
            : `${sheet ?? ""}:chart:${chart}:${await runtime.runPromise(drawnFontsKey)}`,
        produce: async (bytes, { sheet, chart }, { signal, owner }) => {
          const sheets = await runtime.runPromise(sheetsProcessor);
          const background = { priority: "background", owner } as const;
          const named = sheet === null ? {} : { sheet };
          if (chart === null)
            return jsonPreview(
              await sheets.run({ kind: "preview", bytes, ...named }, signal, background),
            );
          const drawn = await sheets.run(
            { kind: "chart", bytes, ...named, index: chart },
            signal,
            background,
          );
          const slides = await runtime.runPromise(slidesProcessor);
          return {
            body: await slides.run({ kind: "chart", chart: drawn }, signal, background),
            type: "image/png",
          };
        },
        isError: (error) => error instanceof SpreadsheetError || error instanceof PresentationError,
      }),
    },
  },
});
