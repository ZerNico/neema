import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { Effect, Schema } from "effect";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { runtime } from "~/server/runtime.ts";
import { compareSkillUpdate, resolveSkillUpdate } from "../update.ts";
import { SkillService } from "./service.ts";
import { discoverSkills, reviewGitHubSkill, type RemoteSkillPackage } from "./remote.ts";

/**
 * Reviews hold no server state. A reviewed package is identified by its pinned
 * commit and the hash computed from its bytes, so importing re-reads exactly
 * what was reviewed and refuses anything else. Server memory does not reliably
 * survive between requests, and a review that expires between looking and
 * importing is a failure the reader can do nothing about.
 */
const reviewedSource = Schema.Struct({
  repository: Schema.String.check(Schema.isMaxLength(140)),
  commit: Schema.String.check(Schema.isMaxLength(40)),
  path: Schema.String.check(Schema.isMaxLength(240)),
  contentHash: Schema.String.check(Schema.isMaxLength(140)),
});

const reReview = async (
  userId: string,
  source: { repository: string; commit: string; path: string; contentHash: string },
): Promise<RemoteSkillPackage> => {
  const review = await reviewGitHubSkill(
    userId,
    `https://github.com/${source.repository}/tree/${source.commit}`,
    source.path,
    getRequest().signal,
  );
  if (!review.selected)
    throw new Response("The package is no longer available at its reviewed path.", { status: 409 });
  // The commit is immutable, so a different hash means a different package.
  if (
    review.selected.source.contentHash !== source.contentHash ||
    review.selected.source.commit !== source.commit
  )
    throw new Response("The package changed since you reviewed it. Review it again.", {
      status: 409,
    });
  return review.selected;
};

export const searchDiscoverableSkills = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(
    Schema.toStandardSchemaV1(
      Schema.Struct({
        query: Schema.String.check(Schema.isMaxLength(200)),
        limit: Schema.optional(Schema.Number),
      }),
    ),
  )
  .handler(({ context, data }) =>
    discoverSkills(context.session.user.id, data.query, data.limit, getRequest().signal),
  );
export const reviewRemoteSkill = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(
    Schema.toStandardSchemaV1(
      Schema.Struct({
        url: Schema.String.check(Schema.isMaxLength(2048)),
        path: Schema.optional(Schema.String.check(Schema.isMaxLength(240))),
      }),
    ),
  )
  .handler(async ({ context, data }) => {
    const review = await reviewGitHubSkill(
      context.session.user.id,
      data.url,
      data.path,
      getRequest().signal,
    );
    return review;
  });
export const importReviewedSkill = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(reviewedSource))
  .handler(async ({ context, data }) => {
    const selected = await reReview(context.session.user.id, data);
    return runtime.runPromise(
      Effect.flatMap(SkillService, (service) =>
        service.save(context.session.user.id, {
          files: selected.package.files,
          source: selected.source,
        }),
      ),
    );
  });
export const reviewSkillUpdate = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(
    Schema.toStandardSchemaV1(
      Schema.Struct({ skillId: Schema.String.check(Schema.isMaxLength(100)) }),
    ),
  )
  .handler(async ({ context, data }) => {
    const userId = context.session.user.id;
    const local = await runtime.runPromise(
      Effect.flatMap(SkillService, (service) => service.detail(userId, data.skillId)),
    );
    if (!local.source) throw new Response("This skill has no upstream source.", { status: 400 });
    const baseline = await runtime.runPromise(
      Effect.flatMap(SkillService, (service) => service.baseline(userId, data.skillId)),
    );
    const remote = await reviewGitHubSkill(
      userId,
      local.source.url,
      local.source.path,
      getRequest().signal,
    );
    if (!remote.selected)
      throw new Response("The upstream package is no longer available at its original path.", {
        status: 409,
      });
    return {
      changes: compareSkillUpdate(baseline, local.files, remote.selected.package.files),
      source: remote.selected.source,
      expectedRevision: local.revision,
    };
  });
export const applySkillUpdate = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(
    Schema.toStandardSchemaV1(
      Schema.Struct({
        skillId: Schema.String.check(Schema.isMaxLength(100)),
        expectedRevision: Schema.Number,
        source: reviewedSource,
        choices: Schema.Array(
          Schema.Struct({
            path: Schema.String.check(Schema.isMaxLength(240)),
            selected: Schema.Literals(["local", "upstream"]),
          }),
        ).check(Schema.isMaxLength(300)),
      }),
    ),
  )
  .handler(async ({ context, data }) => {
    const userId = context.session.user.id;
    const selected = await reReview(userId, data.source);
    const local = await runtime.runPromise(
      Effect.flatMap(SkillService, (service) => service.detail(userId, data.skillId)),
    );
    // The draft the choices were made against, not whatever it is now.
    if (local.revision !== data.expectedRevision)
      throw new Response("This skill changed while you were reviewing. Check for updates again.", {
        status: 409,
      });
    const baseline = await runtime.runPromise(
      Effect.flatMap(SkillService, (service) => service.baseline(userId, data.skillId)),
    );
    const changes = compareSkillUpdate(baseline, local.files, selected.package.files);
    if (
      new Set(data.choices.map((choice) => choice.path)).size !== data.choices.length ||
      data.choices.length !== changes.length ||
      data.choices.some((choice) => !changes.some((change) => change.path === choice.path))
    )
      throw new Response("Invalid file choices.", { status: 400 });
    const files = resolveSkillUpdate(
      changes.map((change) => ({
        ...change,
        selected: data.choices.find((choice) => choice.path === change.path)!.selected,
      })),
    );
    const id = await runtime.runPromise(
      Effect.flatMap(SkillService, (service) =>
        service.save(userId, {
          skillId: data.skillId,
          expectedRevision: data.expectedRevision,
          files,
          source: selected.source,
          upstreamBaseline: selected.package.files,
        }),
      ),
    );
    return { id, files, revision: data.expectedRevision + 1, source: selected.source };
  });
