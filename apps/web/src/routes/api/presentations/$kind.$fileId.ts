import { createFileRoute } from "@tanstack/react-router";
import { Effect, Option } from "effect";
import { PPTX_MEDIA_TYPE } from "~/modules/attachments/constants.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { sha256Hex } from "~/modules/attachments/server/sha256.ts";
import { sessionFromHeaders } from "~/modules/auth/server/auth.ts";
import { PresentationError } from "~/modules/presentations/errors.ts";
import { PresentationFonts } from "~/modules/presentations/server/fonts.ts";
import { PresentationProcessor } from "~/modules/presentations/server/processor.ts";
import { ProjectFileService } from "~/modules/projects/server/project-files.ts";
import { runtime } from "~/server/runtime.ts";

// Access can be taken away, so nothing is cached outside this process.
const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

/**
 * Rendered slides and deck listings by content, never by file: a hit is
 * served only after this request's own access check, so revoking access
 * still takes effect at once. Bounded by entries and bytes, oldest out first.
 */
const CACHE_LIMITS = { entries: 512, bytes: 64 * 1024 * 1024 } as const;
const cache = new Map<string, Uint8Array>();
let cachedBytes = 0;
const cached = (key: string) => {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
};
const remember = (key: string, value: Uint8Array) => {
  if (value.length > CACHE_LIMITS.bytes / 8) return;
  cache.set(key, value);
  cachedBytes += value.length;
  for (const [oldest, bytes] of cache) {
    if (cache.size <= CACHE_LIMITS.entries && cachedBytes <= CACHE_LIMITS.bytes) break;
    cache.delete(oldest);
    cachedBytes -= bytes.length;
  }
};

const text = (body: string, status: number) => new Response(body, { status, headers });

/**
 * Approximate PNG slides of an authorized PPTX: the listing without `slide`,
 * one slide's image with it. Only reads; the original stays a download.
 */
export const Route = createFileRoute("/api/presentations/$kind/$fileId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const current = await sessionFromHeaders(request.headers);
        if (!current?.approved) return text("Unauthorized", 401);
        if (params.kind !== "attachment" && params.kind !== "project-version")
          return text("Not found", 404);
        const userId = current.session.user.id;
        const file = await runtime.runPromise(
          Effect.gen(function* () {
            if (params.kind === "project-version")
              return yield* Effect.flatMap(ProjectFileService, (projects) =>
                projects.openVersion(userId, params.fileId),
              );
            const found = yield* Effect.flatMap(AttachmentService, (attachments) =>
              attachments.open({ userId, attachmentId: params.fileId }),
            ).pipe(Effect.catchTag("AttachmentNotAvailable", () => Effect.succeed(null)));
            return found && { ...found, name: found.fileName };
          }),
        );
        if (!file) return text("Not found", 404);
        // The stored type comes from the bytes, so anything else never reaches a worker.
        if (file.mediaType !== PPTX_MEDIA_TYPE)
          return text("Only PowerPoint files have a preview.", 422);

        const slide = new URL(request.url).searchParams.get("slide");
        const slideId = slide === null ? null : Number(slide);
        if (slide !== null && (!/^[1-9]\d*$/.test(slide) || !Number.isSafeInteger(slideId)))
          return text("Slide not found", 404);

        try {
          const { processor, fonts } = await runtime.runPromise(
            Effect.gen(function* () {
              const faces = yield* Effect.serviceOption(PresentationFonts).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.succeed([]),
                    onSome: (service) => service.faces(),
                  }),
                ),
              );
              return {
                processor: yield* PresentationProcessor,
                // Uploaded faces change what a slide looks like, never the listing.
                fonts: sha256Hex(new TextEncoder().encode(JSON.stringify(faces))),
              };
            }),
          );
          const key =
            slideId === null ? `list:${file.sha256}` : `slide:${file.sha256}:${slideId}:${fonts}`;
          const hit = cached(key);
          if (hit)
            return slideId === null
              ? new Response(hit as BodyInit, {
                  headers: { ...headers, "Content-Type": "application/json" },
                })
              : new Response(hit as BodyInit, {
                  headers: { ...headers, "Content-Type": "image/png" },
                });

          const bytes = await runtime.runPromise(file.bytes);
          if (!bytes) return text("Not found", 404);
          const background = { priority: "background" } as const;
          if (slideId === null) {
            const inspected = await processor.run(
              { kind: "inspect", bytes },
              request.signal,
              background,
            );
            if (inspected.kind !== "inspection") throw new Error("Unexpected inspection result.");
            const slideIds = inspected.inspection.slides.map((each) => each.slideId);
            const listing = new TextEncoder().encode(
              JSON.stringify({
                slideIds,
                count: slideIds.length,
                aspectRatio: inspected.inspection.aspectRatio,
                name: file.name,
              }),
            );
            remember(key, listing);
            return new Response(listing as BodyInit, {
              headers: { ...headers, "Content-Type": "application/json" },
            });
          }
          // An unknown slide is the renderer's `not_found`; no inspection first.
          const rendered = await processor.run(
            { kind: "render", bytes, slideIds: [slideId] },
            request.signal,
            background,
          );
          const png = rendered.kind === "rendered" ? rendered.slides[0]?.png : undefined;
          if (!png) throw new Error("Unexpected render result.");
          remember(key, png);
          return new Response(png as BodyInit, {
            headers: { ...headers, "Content-Type": "image/png" },
          });
        } catch (error) {
          if (request.signal.aborted) return text("Cancelled", 499);
          if (error instanceof PresentationError) {
            if (error.code === "not_found") return text("Slide not found", 404);
            return text(error.message, error.code === "busy" ? 503 : 422);
          }
          await runtime.runPromise(
            Effect.logError("presentation preview failed", { kind: params.kind, error }),
          );
          return text("Could not preview this presentation.", 500);
        }
      },
    },
  },
});
