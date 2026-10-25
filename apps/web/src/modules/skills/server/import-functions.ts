import { createMiddleware, createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { Effect, Schema } from "effect";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { refusal } from "~/server/refusal.ts";
import { localized } from "~/i18n/localized.ts";
import { m } from "~/paraglide/messages.js";
import { runServerFn } from "~/server/run-server-fn.ts";
import { withoutBytes } from "../package.ts";
import { changesWithoutBytes, compareSkillUpdate, resolveSkillUpdate } from "../update.ts";
import { SkillService } from "./service.ts";
import { discoverSkills, reviewGitHubSkill, type RemoteSkillPackage } from "./remote.ts";
import { EntityId } from "~/entity-id.ts";

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

/**
 * Remote reads cost the instance's upstream rate limits and fetch packages
 * through the server, so they need skill authoring, not only a session.
 */
const requireSkillAuthoring = createMiddleware()
  .middleware([requireSession])
  .server(async ({ context, next }) => {
    const userId = context.session.user.id;
    if (!(await runServerFn(FeaturePolicy.use((policy) => policy.can(userId, "skillsCreate")))))
      throw refusal(403, localized(m.skills_error_authoring_unavailable));
    return next();
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
  if (!review.selected) throw refusal(409, localized(m.skills_error_review_gone));
  // The commit is immutable, so a different hash means a different package.
  if (
    review.selected.source.contentHash !== source.contentHash ||
    review.selected.source.commit !== source.commit
  )
    throw refusal(409, localized(m.skills_error_review_changed));
  return review.selected;
};

export const searchDiscoverableSkills = createServerFn({ method: "GET" })
  .middleware([requireSkillAuthoring])
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
  .middleware([requireSkillAuthoring])
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
    // A reviewed binary is described to the browser; import fetches it again.
    return review.selected
      ? {
          ...review,
          selected: {
            ...review.selected,
            package: {
              ...review.selected.package,
              files: review.selected.package.files.map(withoutBytes),
            },
          },
        }
      : review;
  });
export const importReviewedSkill = createServerFn({ method: "POST" })
  .middleware([requireSkillAuthoring])
  .validator(Schema.toStandardSchemaV1(reviewedSource))
  .handler(async ({ context, data }) => {
    const selected = await reReview(context.session.user.id, data);
    return runServerFn(
      Effect.flatMap(SkillService, (service) =>
        service
          .save(context.session.user.id, {
            files: selected.package.files,
            source: selected.source,
          })
          .pipe(Effect.map((saved) => saved.id)),
      ),
    );
  });
export const reviewSkillUpdate = createServerFn({ method: "POST" })
  .middleware([requireSkillAuthoring])
  .validator(Schema.toStandardSchemaV1(Schema.Struct({ skillId: EntityId })))
  .handler(async ({ context, data }) => {
    const userId = context.session.user.id;
    const local = await runServerFn(
      Effect.flatMap(SkillService, (service) => service.detail(userId, data.skillId)),
    );
    if (!local.source) throw refusal(400, localized(m.skills_error_no_source));
    const baseline = await runServerFn(
      Effect.flatMap(SkillService, (service) => service.baseline(userId, data.skillId)),
    );
    const remote = await reviewGitHubSkill(
      userId,
      local.source.url,
      local.source.path,
      getRequest().signal,
    );
    if (!remote.selected) throw refusal(409, localized(m.skills_error_upstream_gone));
    return {
      changes: changesWithoutBytes(
        compareSkillUpdate(baseline, local.files, remote.selected.package.files),
      ),
      source: remote.selected.source,
      expectedRevision: local.revision,
    };
  });
export const applySkillUpdate = createServerFn({ method: "POST" })
  .middleware([requireSkillAuthoring])
  .validator(
    Schema.toStandardSchemaV1(
      Schema.Struct({
        skillId: EntityId,
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
    const local = await runServerFn(
      Effect.flatMap(SkillService, (service) => service.detail(userId, data.skillId)),
    );
    // The draft the choices were made against, not whatever it is now.
    if (local.revision !== data.expectedRevision)
      throw refusal(409, localized(m.skills_error_changed_while_reviewing));
    const baseline = await runServerFn(
      Effect.flatMap(SkillService, (service) => service.baseline(userId, data.skillId)),
    );
    const changes = compareSkillUpdate(baseline, local.files, selected.package.files);
    if (
      new Set(data.choices.map((choice) => choice.path)).size !== data.choices.length ||
      data.choices.length !== changes.length ||
      data.choices.some((choice) => !changes.some((change) => change.path === choice.path))
    )
      throw refusal(400, localized(m.skills_error_invalid_choices));
    const files = resolveSkillUpdate(
      changes.map((change) => ({
        ...change,
        selected: data.choices.find((choice) => choice.path === change.path)!.selected,
      })),
    );
    const saved = await runServerFn(
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
    return {
      id: saved.id,
      files: saved.files,
      revision: saved.revision,
      source: selected.source,
    };
  });
