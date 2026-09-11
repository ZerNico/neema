import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { attachmentKind } from "~/modules/attachments/constants.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { sessionFromHeaders } from "~/modules/auth/server/auth.ts";
import { runtime } from "~/server/runtime.ts";

// RFC 5987: an ASCII fallback for old agents plus the real UTF-8 name.
const contentDisposition = (kind: string, fileName: string) => {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const mode = kind === "text" ? "attachment" : "inline";
  return `${mode}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
};

// Serves attachment bytes to anyone the access policy allows. Raw route rather
// than a server function because the body is bytes with cache headers.
export const Route = createFileRoute("/api/files/$attachmentId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const current = await sessionFromHeaders(request.headers);
        // An account still waiting on approval is declined here as though
        // signed out: only a server function can say why, and the browser
        // is already being sent to the waiting screen by the app route.
        if (!current?.approved) return new Response("Unauthorized", { status: 401 });
        const session = current.session;

        const file = await runtime.runPromise(
          Effect.gen(function* () {
            const service = yield* AttachmentService;
            return yield* service.read({
              userId: session.user.id,
              attachmentId: params.attachmentId,
            });
          }).pipe(Effect.catchTag("AttachmentNotAvailable", () => Effect.succeed(null))),
        );
        if (!file) return new Response("Not found", { status: 404 });

        const kind = attachmentKind(file.mediaType);
        return new Response(file.bytes as BodyInit, {
          headers: {
            "Content-Type": kind === "text" ? `${file.mediaType}; charset=utf-8` : file.mediaType,
            // From the bytes actually being sent, not the size column — if
            // store and DB ever drift the response must not be malformed.
            "Content-Length": String(file.bytes.byteLength),
            "Content-Disposition": contentDisposition(kind, file.fileName),
            // Content is addressed by an opaque id, so it never changes.
            "Cache-Control": "private, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
          },
        });
      },
    },
  },
});
