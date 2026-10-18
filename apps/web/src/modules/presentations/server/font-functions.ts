import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireAdmin } from "~/modules/auth/server/middleware.ts";
import { refusal } from "~/server/refusal.ts";
import { runServerFn } from "~/server/run-server-fn.ts";
import { FONT_LIMITS } from "../limits.ts";
import { megabytes, PresentationFonts } from "./fonts.ts";

export const listPresentationFonts = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() =>
    runServerFn(
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
    if (!(file instanceof File)) throw refusal(400, "Expected a font file");
    if (file.size > FONT_LIMITS.fileBytes)
      throw refusal(413, `Fonts must be under ${megabytes(FONT_LIMITS.fileBytes)} MB per file.`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const saved = await runServerFn(
      PresentationFonts.use((fonts) =>
        fonts.upload({ fileName: file.name, bytes, userId: context.session.user.id }),
      ),
    );
    return { ...saved, createdAt: saved.createdAt.toISOString() };
  });

export const deletePresentationFont = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(Schema.toStandardSchemaV1(Schema.Struct({ id: Schema.String })))
  .handler(({ data }) => runServerFn(PresentationFonts.use((fonts) => fonts.remove(data.id))));

/** Embedding is per face and off by default: a brand font's licence may forbid it. */
export const setPresentationFontEmbed = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(Schema.toStandardSchemaV1(Schema.Struct({ id: Schema.String, embed: Schema.Boolean })))
  .handler(({ data }) =>
    runServerFn(PresentationFonts.use((fonts) => fonts.setEmbed(data.id, data.embed))),
  );
