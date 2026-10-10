import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { runtime } from "~/server/runtime.ts";
import { CreateSheetInput, PushSheetInput } from "../schema.ts";
import { SheetService } from "./sheet-service.ts";

const CreateProjectSheetInput = Schema.Struct({
  projectId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  title: CreateSheetInput.fields.title,
  locale: CreateSheetInput.fields.locale,
  timeZone: CreateSheetInput.fields.timeZone,
});

/** A person starting a blank sheet in a project, in their own locale and time zone. */
export const createProjectSheet = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(CreateProjectSheetInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      Effect.flatMap(SheetService, (service) =>
        service.create(context.session.user.id, { ...data, by: "user" }),
      ).pipe(
        Effect.catchTag("DocumentNotAvailable", () =>
          Effect.die(new Response("Not found", { status: 404 })),
        ),
        Effect.catchTag("DocumentRejected", (error) =>
          Effect.die(new Response(error.reason, { status: 400 })),
        ),
      ),
    ),
  );

/** A sheet editor sends its changes and cursor here; the live stream carries them out. */
export const pushSheet = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(PushSheetInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      Effect.flatMap(SheetService, (service) => service.push(context.session.user.id, data)).pipe(
        Effect.catchTag("DocumentNotAvailable", () =>
          Effect.die(new Response("Not found", { status: 404 })),
        ),
        Effect.catchTag("DocumentRejected", (error) =>
          Effect.die(new Response(error.reason, { status: 400 })),
        ),
      ),
    ),
  );
