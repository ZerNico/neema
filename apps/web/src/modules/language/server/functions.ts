import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { runServerFn } from "~/server/run-server-fn.ts";
import { LanguageChoice, Locale, RegionChoice } from "../schema.ts";
import { LanguageRepo } from "./repo.ts";

export const getLanguage = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(({ context }) =>
    runServerFn(Effect.flatMap(LanguageRepo, (repo) => repo.get(context.session.user.id))),
  );

export const chooseLanguage = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(Schema.Struct({ chosen: LanguageChoice })))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(LanguageRepo, (repo) => repo.choose(context.session.user.id, data.chosen)),
    ),
  );

export const chooseRegion = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(Schema.Struct({ region: RegionChoice })))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(LanguageRepo, (repo) =>
        repo.chooseRegion(context.session.user.id, data.region),
      ),
    ),
  );

export const noteBrowserLanguage = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(Schema.Struct({ browser: Locale })))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(LanguageRepo, (repo) =>
        repo.noteBrowser(context.session.user.id, data.browser),
      ),
    ),
  );
