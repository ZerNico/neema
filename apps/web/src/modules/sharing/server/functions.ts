import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { runServerFn } from "~/server/run-server-fn.ts";
import {
  RecipientSearchInput,
  SharedResource,
  ShareEmailInput,
  ShareGroupInput,
  RevokeUserInput,
  PublishResourceInput,
} from "../schema.ts";
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
export const shareResourceWithEmail = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(ShareEmailInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(SharingService, (service) =>
        service.change(context.session.user.id, data, { action: "email", email: data.email }),
      ),
    ),
  );
export const shareResourceWithGroup = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(ShareGroupInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(SharingService, (service) =>
        service.change(context.session.user.id, data, { action: "group", groupId: data.groupId }),
      ),
    ),
  );
export const revokeResourceUser = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(RevokeUserInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(SharingService, (service) =>
        service.change(context.session.user.id, data, {
          action: "revokeUser",
          userId: data.userId,
        }),
      ),
    ),
  );
export const revokeResourceGroup = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(ShareGroupInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(SharingService, (service) =>
        service.change(context.session.user.id, data, {
          action: "revokeGroup",
          groupId: data.groupId,
        }),
      ),
    ),
  );
export const publishResource = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(PublishResourceInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(SharingService, (service) =>
        service.change(context.session.user.id, data, {
          action: "publish",
          audience: data.audience,
        }),
      ),
    ),
  );
