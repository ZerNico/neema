import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { uuidv7 } from "uuidv7";
import {
  customToolGroupGrants,
  customTools,
  customToolUserGrants,
  groupMembers,
  user,
} from "~/db/schema/index.ts";
import type { DbTx } from "~/modules/attachments/server/repo.ts";
import { Db } from "~/server/db.ts";
import { capabilityAllowedSql } from "~/modules/groups/server/policy.ts";
import { isUniqueViolation } from "~/server/sql.ts";
import type {
  CustomToolDependency,
  CustomToolFunctionManifest,
  CustomToolManifest,
} from "../schema.ts";
import { CustomToolConflict, CustomToolNotFound, CustomToolSlugTaken } from "../errors.ts";

export type CustomToolRow = typeof customTools.$inferSelect;

/**
 * What a listing needs: no source or bundle. A bundle can be megabytes and
 * every agent page lists modules, so the heavy columns stay behind `get`.
 */
export type CustomToolSummaryRow = Omit<CustomToolRow, "source" | "compiled">;

export interface CustomToolBuildRecord {
  readonly source: string;
  readonly dependencies: ReadonlyArray<CustomToolDependency>;
  readonly compiled: string;
  readonly functions: ReadonlyArray<CustomToolFunctionManifest>;
}

const toManifest = (row: CustomToolRow): CustomToolManifest => ({
  toolId: row.id,
  slug: row.slug,
  name: row.name,
  description: row.description,
  compiled: row.compiled,
  functions: row.functions,
});

const summaryColumns = {
  id: customTools.id,
  slug: customTools.slug,
  name: customTools.name,
  description: customTools.description,
  dependencies: customTools.dependencies,
  functions: customTools.functions,
  enabled: customTools.enabled,
  audience: customTools.audience,
  version: customTools.version,
  createdBy: customTools.createdBy,
  createdAt: customTools.createdAt,
  updatedAt: customTools.updatedAt,
};

/**
 * Who may run a module: everyone signed in when the audience is the instance,
 * admins always, otherwise a user or group grant from the sharing dialog. SQL,
 * so attach-time and attempt-time checks cannot drift apart.
 */
export const customToolUsableBy = (userId: string): SQL => sql`(
  ${capabilityAllowedSql(userId, "customTools")}
  and (
  ${customTools.audience} = 'instance'
  or exists(select 1 from ${user} where ${user.id} = ${userId} and ${user.role} = 'admin')
  or exists(select 1 from ${customToolUserGrants} where ${customToolUserGrants.toolId} = ${customTools.id} and ${customToolUserGrants.userId} = ${userId})
  or exists(select 1 from ${customToolGroupGrants} join ${groupMembers} on ${groupMembers.groupId} = ${customToolGroupGrants.groupId}
    where ${customToolGroupGrants.toolId} = ${customTools.id} and ${groupMembers.userId} = ${userId})
  )
)`;

export class CustomToolRepo extends Context.Service<
  CustomToolRepo,
  {
    list(): Effect.Effect<ReadonlyArray<CustomToolSummaryRow>>;
    /** Enabled modules the user may attach; admins see every enabled one. */
    listUsableBy(userId: string): Effect.Effect<ReadonlyArray<CustomToolSummaryRow>>;
    get(id: string): Effect.Effect<CustomToolRow | null>;
    /**
     * The enabled modules the user may run, in the order given, as they are
     * right now. A module the user lost access to drops out silently, like a
     * disabled one.
     */
    resolveForAttempt(
      userId: string,
      /** Explicit ids from an agent; `"all"` is plain chat, every usable module. */
      selection: ReadonlyArray<string> | "all",
      tx?: DbTx,
    ): Effect.Effect<ReadonlyArray<CustomToolManifest>>;
    create(input: {
      slug: string;
      name: string;
      description: string;
      build: CustomToolBuildRecord;
      createdBy: string;
    }): Effect.Effect<CustomToolRow, CustomToolSlugTaken>;
    update(
      id: string,
      expectedVersion: string,
      input: {
        slug: string;
        name: string;
        description: string;
        build: CustomToolBuildRecord;
      },
    ): Effect.Effect<CustomToolRow, CustomToolNotFound | CustomToolConflict | CustomToolSlugTaken>;
    setEnabled(
      id: string,
      enabled: boolean,
    ): Effect.Effect<CustomToolSummaryRow, CustomToolNotFound>;
    remove(id: string): Effect.Effect<void>;
  }
>()("chat/custom-tools/CustomToolRepo") {
  static readonly layer = Layer.effect(
    CustomToolRepo,
    Effect.gen(function* () {
      const db = yield* Db;

      return CustomToolRepo.of({
        list: Effect.fn("CustomToolRepo.list")(function* () {
          return yield* db
            .select(summaryColumns)
            .from(customTools)
            .orderBy(asc(customTools.slug))
            .pipe(Effect.orDie);
        }),

        listUsableBy: Effect.fn("CustomToolRepo.listUsableBy")(function* (userId) {
          return yield* db
            .select(summaryColumns)
            .from(customTools)
            .where(and(eq(customTools.enabled, true), customToolUsableBy(userId)))
            .orderBy(asc(customTools.slug))
            .pipe(Effect.orDie);
        }),

        get: Effect.fn("CustomToolRepo.get")(function* (id) {
          const rows = yield* db
            .select()
            .from(customTools)
            .where(eq(customTools.id, id))
            .pipe(Effect.orDie);
          return rows[0] ?? null;
        }),

        resolveForAttempt: Effect.fn("CustomToolRepo.resolveForAttempt")(
          function* (userId, selection, tx) {
            if (selection !== "all" && selection.length === 0) return [];
            const client = tx ?? db;
            const rows = yield* client
              .select()
              .from(customTools)
              .where(
                and(
                  selection === "all" ? undefined : inArray(customTools.id, [...selection]),
                  eq(customTools.enabled, true),
                  customToolUsableBy(userId),
                ),
              )
              .orderBy(asc(customTools.slug))
              .pipe(Effect.orDie);
            if (selection === "all") return rows.map(toManifest);
            const byId = new Map(rows.map((row) => [row.id, row]));
            return selection.flatMap((id) => {
              const row = byId.get(id);
              return row ? [toManifest(row)] : [];
            });
          },
        ),

        create: Effect.fn("CustomToolRepo.create")(function* (input) {
          const [row] = yield* db
            .insert(customTools)
            .values({
              id: uuidv7(),
              slug: input.slug,
              name: input.name,
              description: input.description,
              source: input.build.source,
              dependencies: [...input.build.dependencies],
              compiled: input.build.compiled,
              functions: [...input.build.functions],
              version: uuidv7(),
              createdBy: input.createdBy,
            })
            .returning()
            .pipe(
              Effect.catchTag("EffectDrizzleQueryError", (error) =>
                isUniqueViolation(error)
                  ? Effect.fail(new CustomToolSlugTaken({ slug: input.slug }))
                  : Effect.die(error),
              ),
            );
          return row!;
        }),

        update: Effect.fn("CustomToolRepo.update")(function* (id, expectedVersion, input) {
          const [row] = yield* db
            .update(customTools)
            .set({
              slug: input.slug,
              name: input.name,
              description: input.description,
              source: input.build.source,
              dependencies: [...input.build.dependencies],
              compiled: input.build.compiled,
              functions: [...input.build.functions],
              version: uuidv7(),
              updatedAt: new Date(),
            })
            .where(and(eq(customTools.id, id), eq(customTools.version, expectedVersion)))
            .returning()
            .pipe(
              Effect.catchTag("EffectDrizzleQueryError", (error) =>
                isUniqueViolation(error)
                  ? Effect.fail(new CustomToolSlugTaken({ slug: input.slug }))
                  : Effect.die(error),
              ),
            );
          if (row) return row;
          const rows = yield* db
            .select({ id: customTools.id })
            .from(customTools)
            .where(eq(customTools.id, id))
            .pipe(Effect.orDie);
          return yield* rows[0]
            ? new CustomToolConflict({ toolId: id })
            : new CustomToolNotFound({ toolId: id });
        }),

        setEnabled: Effect.fn("CustomToolRepo.setEnabled")(function* (id, enabled) {
          const [row] = yield* db
            .update(customTools)
            .set({ enabled, updatedAt: new Date() })
            .where(eq(customTools.id, id))
            .returning(summaryColumns)
            .pipe(Effect.orDie);
          if (!row) return yield* new CustomToolNotFound({ toolId: id });
          return row;
        }),

        // Attachments and grants cascade, and an answer that called the module
        // keeps its own tool row, so the slug is free again afterwards.
        remove: Effect.fn("CustomToolRepo.remove")(function* (id) {
          yield* db.delete(customTools).where(eq(customTools.id, id)).pipe(Effect.orDie);
        }),
      });
    }),
  );
}
