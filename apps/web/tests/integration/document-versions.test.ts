import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, ManagedRuntime, Redacted, Stream } from "effect";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { user } from "~/db/schema/index.ts";
import { fsBlobStoreLayer } from "~/modules/attachments/server/fs-blob-store.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { DocumentRepo } from "~/modules/documents/server/document-repo.ts";
import { DocumentService } from "~/modules/documents/server/document-service.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { ProjectService } from "~/modules/projects/server/service.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
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
    Layer.provideMerge(infrastructure),
  );
  runtime = ManagedRuntime.make(
    Layer.mergeAll(DocumentService.layer, ProjectService.layer, AttachmentService.layer).pipe(
      Layer.provideMerge(core),
    ),
  );
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
});
