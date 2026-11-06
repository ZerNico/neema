import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PgClient } from "@effect/sql-pg";
import { and, eq, gt, lte } from "drizzle-orm";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Redacted, Stream } from "effect";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { english, type Localized } from "~/i18n/localized.ts";
import { documentSteps, documentVersions, user } from "~/db/schema/index.ts";
import { fsBlobStoreLayer } from "~/modules/attachments/server/fs-blob-store.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { DocumentRepo } from "~/modules/documents/server/document-repo.ts";
import { DocumentService } from "~/modules/documents/server/document-service.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { StorageQuota } from "~/modules/limits/server/storage.ts";
import { ProjectService } from "~/modules/projects/server/service.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import { seedEligibleSession } from "../fixtures/eligible-session.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

process.env.BLOB_STORE_ROOT = mkdtempSync(join(tmpdir(), "document-versions-it-"));

type Services =
  | Db
  | AttachmentRepo
  | AttachmentService
  | DocumentService
  | ProjectService
  | FeaturePolicy;
let database: TestDatabase;
let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>;
let appLayer: Layer.Layer<Services, unknown>;
const run = <A, E>(effect: Effect.Effect<A, E, Services>) => runtime.runPromise(effect);

beforeAll(async () => {
  database = await createTestDatabase();
  const infrastructure = Db.layer.pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(database.url), maxConnections: 8 })),
  );
  const bus = Layer.succeed(SyncBus, {
    publish: () => Effect.void,
    publishGlobal: () => Effect.void,
    signals: Stream.make({ type: "ready" } as const).pipe(Stream.concat(Stream.never)),
    subscribe: () => Stream.empty,
  });
  const core = Layer.mergeAll(DocumentRepo.layer, AttachmentRepo.layer, bus, fsBlobStoreLayer).pipe(
    Layer.provideMerge(FeaturePolicy.layer),
    Layer.provideMerge(StorageQuota.layer),
    Layer.provideMerge(infrastructure),
  );
  appLayer = Layer.mergeAll(
    DocumentService.layer,
    ProjectService.layer,
    AttachmentService.layer,
  ).pipe(Layer.provideMerge(core));
  runtime = ManagedRuntime.make(appLayer);
}, 180_000);
afterAll(async () => {
  await runtime?.dispose();
  await database?.drop();
});

const createUser = async () => {
  const id = uuidv7();
  await run(
    Effect.flatMap(Db, (db) => db.insert(user).values({ id, name: "Member", email: `${id}@t.io` })),
  );
  await run(seedEligibleSession(id));
  return id;
};
/** A project with an owner, an editor and a viewer, and one blank document in it. */
const projectDocument = async () => {
  const owner = await createUser();
  const editor = await createUser();
  const viewer = await createUser();
  const project = await run(
    Effect.flatMap(ProjectService, (s) => s.create(owner, { name: "Launch", instructions: "" })),
  );
  for (const [member, role] of [
    [editor, "editor"],
    [viewer, "viewer"],
  ] as const)
    // oxlint-disable-next-line eslint/no-await-in-loop -- Two members, in order.
    await run(
      Effect.flatMap(ProjectService, (s) =>
        s.changeMembers(owner, project.id, { action: "addUser", email: `${member}@t.io`, role }),
      ),
    );
  const { document } = await run(
    Effect.flatMap(DocumentService, (s) =>
      s.create(owner, { projectId: project.id, title: "Plan", content: "", by: "user" }),
    ),
  );
  return { owner, editor, viewer, projectId: project.id, documentId: document.id };
};

/** A person typing `text` at `from`, one step per character. */
const typing = (text: string, from: number) =>
  [...text].map((character, at) =>
    JSON.stringify({
      stepType: "replace",
      from: from + at,
      to: from + at,
      slice: { content: [{ type: "text", text: character }] },
    }),
  );
const textOf = (json: string | null) =>
  json === null
    ? null
    : (JSON.parse(json) as { content?: { content?: { text?: string }[] }[] }).content
        ?.flatMap((block) => block.content ?? [])
        .map((node) => node.text ?? "")
        .join("");

describe("a document's version history", () => {
  it("lists its versions to an editor and gives back each as it was", async () => {
    const { editor, documentId } = await projectDocument();
    const before = await run(Effect.flatMap(DocumentService, (s) => s.get(editor, documentId)));
    await run(
      Effect.flatMap(DocumentService, (s) =>
        s.push(editor, {
          documentId,
          clientId: "typist",
          revision: before!.revision,
          steps: typing("Plan", 1),
        }),
      ),
    );
    const versions = await run(
      Effect.flatMap(DocumentService, (s) => s.versions(editor, documentId)),
    );
    expect(versions?.[0]).toMatchObject({ author: { kind: "person", name: "Member" } });
    expect(versions?.at(-1)?.author).toBeNull();
    const latest = await run(
      Effect.flatMap(DocumentService, (s) =>
        s.versionAt(editor, documentId, versions![0]!.revision),
      ),
    );
    expect(textOf(latest)).toBe("Plan");
    // Before the typing, as it was.
    const earlier = await run(
      Effect.flatMap(DocumentService, (s) => s.versionAt(editor, documentId, before!.revision)),
    );
    expect(textOf(earlier)).toBe("");
  });

  it("refuses a person's step that builds a malformed block", async () => {
    const { editor, documentId } = await projectDocument();
    const before = await run(Effect.flatMap(DocumentService, (s) => s.get(editor, documentId)));
    // A collapsible section with neither title nor body, which once crashed the model's view.
    const empty = JSON.stringify({
      stepType: "replace",
      from: 0,
      to: 0,
      slice: { content: [{ type: "details" }] },
    });
    const pushed = await runtime.runPromiseExit(
      Effect.flatMap(DocumentService, (s) =>
        s.push(editor, {
          documentId,
          clientId: "typist",
          revision: before!.revision,
          steps: [empty],
        }),
      ),
    );
    expect(Exit.isFailure(pushed) && Cause.squash(pushed.cause)).toMatchObject({
      _tag: "DocumentRejected",
      reason: expect.toSatisfy((reason: Localized) => english(reason) === "invalid document step"),
    });
  });

  it("is an editor's only, and keeps nothing it does not hold", async () => {
    const { viewer, editor, documentId } = await projectDocument();
    const revision = (await run(Effect.flatMap(DocumentService, (s) => s.get(editor, documentId))))!
      .revision;
    expect(
      await run(Effect.flatMap(DocumentService, (s) => s.versions(viewer, documentId))),
    ).toBeNull();
    expect(
      await run(Effect.flatMap(DocumentService, (s) => s.versionAt(viewer, documentId, revision))),
    ).toBeNull();
    expect(
      await run(
        Effect.flatMap(DocumentService, (s) => s.versionAt(editor, documentId, revision + 5)),
      ),
    ).toBeNull();
  });

  it("keeps the versions it folds away, names them, and goes with the document", async () => {
    const { owner, editor, viewer, documentId } = await projectDocument();
    const push = (userId: string, revision: number, steps: string[]) =>
      run(
        Effect.flatMap(DocumentService, (s) =>
          s.push(userId, { documentId, clientId: userId, revision, steps }),
        ),
      );
    await push(editor, 0, typing("Draft", 1));
    await push(owner, 5, typing("x".repeat(2_000), 6));
    const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    await run(
      Effect.flatMap(Db, (db) =>
        Effect.all([
          db
            .update(documentSteps)
            .set({ createdAt: daysAgo(50) })
            .where(and(eq(documentSteps.documentId, documentId), lte(documentSteps.revision, 5))),
          db
            .update(documentSteps)
            .set({ createdAt: daysAgo(45) })
            .where(and(eq(documentSteps.documentId, documentId), gt(documentSteps.revision, 5))),
        ]),
      ),
    );

    // The in-memory steps carry their own times: a new process reads the backdated ones.
    const fresh = ManagedRuntime.make(appLayer);
    const later = <A, E>(effect: Effect.Effect<A, E, Services>) => fresh.runPromise(effect);
    try {
      // One more step folds the editor's run and the first of the owner's.
      await later(
        Effect.flatMap(DocumentService, (s) =>
          s.push(owner, { documentId, clientId: owner, revision: 2_005, steps: typing("y", 1) }),
        ),
      );
      const versions = await later(
        Effect.flatMap(DocumentService, (s) => s.versions(editor, documentId)),
      );
      // The editor's draft is kept past the fold. The blank start, on the same day, is thinned.
      expect(versions?.at(-1)).toMatchObject({
        revision: 5,
        author: { kind: "person", name: "Member" },
      });
      const textAt = (revision: number) =>
        later(Effect.flatMap(DocumentService, (s) => s.versionAt(editor, documentId, revision)));
      expect(textOf(await textAt(5))).toBe("Draft");
      // Inside a folded run, or thinned away, nothing is kept.
      expect(await textAt(3)).toBeNull();
      expect(await textAt(0)).toBeNull();

      const nameAs = (userId: string, revision: number, named: string | null) =>
        fresh.runPromiseExit(
          Effect.flatMap(DocumentService, (s) =>
            s.nameVersion(userId, documentId, revision, named),
          ),
        );
      expect(Exit.isSuccess(await nameAs(editor, 5, "Sent to legal"))).toBe(true);
      // A recent version is kept as soon as it is named.
      expect(Exit.isSuccess(await nameAs(editor, 2_006, "Latest"))).toBe(true);
      expect(Exit.isFailure(await nameAs(viewer, 5, "Mine"))).toBe(true);
      const named = await later(
        Effect.flatMap(DocumentService, (s) => s.versions(editor, documentId)),
      );
      expect(
        named
          ?.filter((version) => version.name !== null)
          .map(({ revision, name }) => [revision, name]),
      ).toEqual([
        [2_006, "Latest"],
        [5, "Sent to legal"],
      ]);
      expect(textOf(await textAt(2_006))).toMatch(/^yDraftx{2000}$/);

      await later(Effect.flatMap(DocumentService, (s) => s.remove(owner, documentId)));
      const left = await later(
        Effect.flatMap(Db, (db) =>
          db.select().from(documentVersions).where(eq(documentVersions.documentId, documentId)),
        ),
      );
      expect(left).toEqual([]);
    } finally {
      await fresh.dispose();
    }
  });
});
