import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import type { KnowledgeNotAvailable, SharingNotAllowed } from "~/modules/knowledge/errors.ts";
import { runtime } from "~/server/runtime.ts";
import type { SharingRateLimited } from "../errors.ts";
import {
  RecipientSearchInput,
  SharedResource,
  ShareEmailInput,
  ShareGroupInput,
  RevokeUserInput,
  PublishResourceInput,
} from "../schema.ts";
import { SharingService } from "./service.ts";
const publicResult = <A, R>(
  effect: Effect.Effect<A, KnowledgeNotAvailable | SharingNotAllowed | SharingRateLimited, R>,
) =>
  effect.pipe(
    Effect.catchTag("KnowledgeNotAvailable", () =>
      Effect.die(new Response("Not found", { status: 404 })),
    ),
    Effect.catchTag("SharingNotAllowed", (error) =>
      Effect.die(new Response(error.reason, { status: 400 })),
    ),
    Effect.catchTag("SharingRateLimited", () =>
      Effect.die(
        new Response("Too many sharing requests; try again shortly", {
          status: 429,
          headers: { "Retry-After": "60" },
        }),
      ),
    ),
  );
export const getResourceSharing = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(SharedResource))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(SharingService, (service) => service.detail(context.session.user.id, data)),
      ),
    ),
  );
export const searchShareRecipients = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(RecipientSearchInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      Effect.flatMap(SharingService, (service) =>
        service.recipients(context.session.user.id, data.q),
      ),
    ),
  );
export const shareResourceWithEmail = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(ShareEmailInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(SharingService, (service) =>
          service.change(context.session.user.id, data, { action: "email", email: data.email }),
        ),
      ),
    ),
  );
export const shareResourceWithGroup = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(ShareGroupInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(SharingService, (service) =>
          service.change(context.session.user.id, data, { action: "group", groupId: data.groupId }),
        ),
      ),
    ),
  );
export const revokeResourceUser = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(RevokeUserInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(SharingService, (service) =>
          service.change(context.session.user.id, data, {
            action: "revokeUser",
            userId: data.userId,
          }),
        ),
      ),
    ),
  );
export const revokeResourceGroup = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(ShareGroupInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(SharingService, (service) =>
          service.change(context.session.user.id, data, {
            action: "revokeGroup",
            groupId: data.groupId,
          }),
        ),
      ),
    ),
  );
export const publishResource = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(PublishResourceInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(SharingService, (service) =>
          service.change(context.session.user.id, data, {
            action: "publish",
            audience: data.audience,
          }),
        ),
      ),
    ),
  );
