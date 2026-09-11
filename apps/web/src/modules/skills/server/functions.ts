import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { runtime } from "~/server/runtime.ts";
import type { SkillConflict, SkillNotAvailable, SkillRejected } from "../errors.ts";
import { SaveSkillInput, SkillIdInput } from "../schema.ts";
import { SkillService } from "./service.ts";

const publicResult = <A, R>(
  effect: Effect.Effect<A, SkillNotAvailable | SkillConflict | SkillRejected, R>,
) =>
  effect.pipe(
    Effect.catchTag("SkillNotAvailable", () =>
      Effect.die(new Response("Skill not available", { status: 404 })),
    ),
    Effect.catchTag("SkillConflict", () =>
      Effect.die(
        new Response(
          "This skill changed in another editor. Your draft is preserved; review the current revision before saving.",
          { status: 409 },
        ),
      ),
    ),
    Effect.catchTag("SkillRejected", (error) =>
      Effect.die(new Response(error.reason, { status: 400 })),
    ),
  );
export const listSkills = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(({ context }) =>
    runtime.runPromise(
      Effect.flatMap(SkillService, (service) => service.list(context.session.user.id)),
    ),
  );
export const getSkill = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(SkillIdInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(SkillService, (service) =>
          service.get(context.session.user.id, data.skillId),
        ),
      ),
    ),
  );
export const getSkillDetail = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(SkillIdInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(SkillService, (service) =>
          service.detail(context.session.user.id, data.skillId),
        ),
      ),
    ),
  );
export const saveSkill = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(SaveSkillInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(SkillService, (service) =>
          service.save(context.session.user.id, {
            files: data.files,
            ...(data.skillId ? { skillId: data.skillId } : {}),
            ...(data.expectedRevision === undefined
              ? {}
              : { expectedRevision: data.expectedRevision }),
          }),
        ),
      ),
    ),
  );
export const deleteSkill = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(SkillIdInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(SkillService, (service) =>
          service.remove(context.session.user.id, data.skillId),
        ),
      ),
    ),
  );
