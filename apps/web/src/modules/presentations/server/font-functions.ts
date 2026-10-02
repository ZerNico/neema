import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireAdmin } from "~/modules/auth/server/middleware.ts";
import { runtime } from "~/server/runtime.ts";
import { FONT_LIMITS } from "../limits.ts";
import { megabytes, PresentationFonts } from "./fonts.ts";

export const listPresentationFonts = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() =>
    runtime.runPromise(
      PresentationFonts.use((fonts) => fonts.list()).pipe(
        Effect.map((rows) =>
          rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
        ),
      ),
    ),
  );

/** FormData at the root, so the client sends multipart. */
export const uploadPresentationFont = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator((data: FormData) => data)
  .handler(async ({ data, context }) => {
    const file = data.get("file");
    if (!(file instanceof File)) throw new Response("Expected a font file", { status: 400 });
    if (file.size > FONT_LIMITS.fileBytes)
      throw new Response(`Fonts must be under ${megabytes(FONT_LIMITS.fileBytes)} MB per file.`, {
        status: 413,
      });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const saved = await runtime.runPromise(
      PresentationFonts.use((fonts) =>
        fonts.upload({ fileName: file.name, bytes, userId: context.session.user.id }),
      ).pipe(
        Effect.catchTag("FontRejected", (error) =>
          Effect.die(new Response(error.reason, { status: 400 })),
        ),
      ),
    );
    return { ...saved, createdAt: saved.createdAt.toISOString() };
  });

export const deletePresentationFont = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(Schema.toStandardSchemaV1(Schema.Struct({ id: Schema.String })))
  .handler(({ data }) =>
    runtime.runPromise(PresentationFonts.use((fonts) => fonts.remove(data.id))),
  );

/** Embedding is per face and off by default: a brand font's licence may forbid it. */
export const setPresentationFontEmbed = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(Schema.toStandardSchemaV1(Schema.Struct({ id: Schema.String, embed: Schema.Boolean })))
  .handler(({ data }) =>
    runtime.runPromise(
      PresentationFonts.use((fonts) => fonts.setEmbed(data.id, data.embed)).pipe(
        Effect.catchTag("FontRejected", (error) =>
          Effect.die(new Response(error.reason, { status: 400 })),
        ),
      ),
    ),
  );
