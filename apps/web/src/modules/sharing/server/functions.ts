import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { runServerFn } from "~/server/run-server-fn.ts";
import { ChangeSharingInput, RecipientSearchInput, SharedResource } from "../schema.ts";
import { SharingService } from "./service.ts";
export const getResourceSharing = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(SharedResource))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(SharingService, (service) => service.detail(context.session.user.id, data)),
    ),
  );
export const searchShareRecipients = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(RecipientSearchInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(SharingService, (service) =>
        service.recipients(context.session.user.id, data.q),
      ),
    ),
  );
export const changeSharing = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(ChangeSharingInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(SharingService, (service) =>
        service.change(context.session.user.id, { kind: data.kind, id: data.id }, data.change),
      ),
    ),
  );
