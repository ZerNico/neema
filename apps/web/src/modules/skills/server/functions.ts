import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { refuse } from "~/server/refusal.ts";
import { runServerFn } from "~/server/run-server-fn.ts";
import { SaveSkillInput, SkillIdInput } from "../schema.ts";
import { SkillService } from "./service.ts";
import { readUpload } from "~/modules/attachments/server/functions.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { StorageQuota } from "~/modules/limits/server/storage.ts";

export const listSkills = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(({ context }) =>
    runServerFn(Effect.flatMap(SkillService, (service) => service.list(context.session.user.id))),
  );
export const getSkill = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(SkillIdInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(SkillService, (service) => service.get(context.session.user.id, data.skillId)),
    ),
  );
export const getSkillDetail = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(SkillIdInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(SkillService, (service) =>
        service.detail(context.session.user.id, data.skillId),
      ),
    ),
  );
export const saveSkill = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(SaveSkillInput))
  .handler(({ context, data }) =>
    runServerFn(
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
  );
export const deleteSkill = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(SkillIdInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(SkillService, (service) =>
        service.remove(context.session.user.id, data.skillId),
      ),
    ),
  );

/**
 * A binary file for a skill the sender is editing. Stored like any upload, so
 * validation, dedupe and the abandoned-upload sweep are shared; a save then
 * takes the bytes over. Gated by skill authoring, not by chat attachments.
 */
export const uploadSkillAsset = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator((data: FormData) => data)
  .handler(async ({ data, context }) => {
    const file = readUpload(data);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const userId = context.session.user.id;
    return runServerFn(
      Effect.gen(function* () {
        if (!(yield* FeaturePolicy.use((policy) => policy.can(userId, "skillsCreate"))))
          return yield* refuse(403, "Skill authoring is unavailable");
        yield* StorageQuota.use((quota) => quota.admit(userId, [bytes]));
        const attachment = yield* AttachmentService.use((service) =>
          service.upload({ userId, fileName: file.name, declaredMediaType: file.type, bytes }),
        );
        return { uploadId: attachment.id, size: attachment.size, mediaType: attachment.mediaType };
      }),
    );
  });
