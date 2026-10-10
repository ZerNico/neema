import { createFileRoute } from "@tanstack/react-router";
import { calculateSheet } from "@chat/sheet/model/calc";
import { Effect } from "effect";
import { liveSheetExport } from "~/modules/documents/sheet/server/export.ts";
import { SheetService } from "~/modules/documents/sheet/server/sheet-service.ts";
import { SpreadsheetError } from "~/modules/spreadsheets/errors.ts";
import { SpreadsheetProcessor } from "~/modules/spreadsheets/server/runtime.ts";
import { approvedSession, unauthorized } from "~/server/approved-route.ts";
import { runtime } from "~/server/runtime.ts";

/** A file name from a title: what a download keeps of it. */
const fileName = (title: string) => {
  const printable = [...title].filter((character) => character.charCodeAt(0) >= 32).join("");
  return `${
    printable
      .replace(/[\\/:*?"<>|]+/g, " ")
      .trim()
      .slice(0, 120) || "Sheet"
  }.xlsx`;
};

/** A live sheet as an Excel workbook, its formulas calculated, for someone who may read it. */
export const Route = createFileRoute("/api/sheets/$documentId/export")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const session = await approvedSession(request);
        if (!session) return unauthorized();
        const read = await runtime.runPromise(
          Effect.flatMap(SheetService, (service) =>
            service.read(session.user.id, params.documentId),
          ),
        );
        if (!read) return new Response("Not found", { status: 404 });
        const sheets = await runtime.runPromise(
          Effect.flatMap(SpreadsheetProcessor, Effect.succeed),
        );
        try {
          const bytes = await sheets.run(
            {
              kind: "exportLive",
              // Values say which rows a filter hides, which Excel expects saved as hidden.
              sheet: liveSheetExport(
                read.doc,
                calculateSheet(read.doc, { revision: read.revision, epoch: 0, ...read.moment }),
              ),
            },
            request.signal,
            { owner: session.user.id },
          );
          const name = fileName(read.document.title);
          return new Response(new Uint8Array(bytes), {
            headers: {
              "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              "content-disposition": `attachment; filename="sheet.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`,
              "cache-control": "private, no-store",
            },
          });
        } catch (error) {
          if (error instanceof SpreadsheetError)
            return new Response(error.message, { status: 422 });
          throw error;
        }
      },
    },
  },
});
