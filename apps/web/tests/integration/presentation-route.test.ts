import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, ManagedRuntime, Redacted, Stream } from "effect";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { user } from "~/db/schema/index.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { fsBlobStoreLayer } from "~/modules/attachments/server/fs-blob-store.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { StorageQuota } from "~/modules/limits/server/storage.ts";
import {
  createPresentationDraft,
  inspectPresentation,
} from "~/modules/presentations/server/adapter.ts";
import { PresentationProcessor } from "~/modules/presentations/server/processor.ts";
import { PresentationError } from "~/modules/presentations/errors.ts";
import type { PresentationWork } from "~/modules/presentations/server/runtime.ts";
import { ProjectFileService } from "~/modules/projects/server/project-files.ts";
import { ProjectService } from "~/modules/projects/server/service.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import { seedEligibleSession } from "../fixtures/eligible-session.ts";
import { Route } from "~/routes/api/presentations/$kind.$fileId.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";
import { FakeDocumentParser } from "./unused-services.ts";

vi.mock("~/modules/auth/server/auth.ts", () => ({
  sessionFromHeaders: async (headers: Headers) => {
    const id = headers.get("x-test-user");
    return id
      ? { approved: headers.get("x-test-approved") !== "false", session: { user: { id } } }
      : null;
  },
}));
vi.mock("~/server/runtime.ts", () => ({
  runtime: { runPromise: (effect: Effect.Effect<unknown>) => runtime.runPromise(effect) },
}));

process.env.BLOB_STORE_ROOT = mkdtempSync(join(tmpdir(), "presentation-route-it-"));

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
let database: TestDatabase;
let runtime: ManagedRuntime.ManagedRuntime<
  Db | AttachmentService | ProjectFileService | ProjectService | PresentationProcessor,
  unknown
>;
let deck: Uint8Array;
let slideId: number;
const work = vi.fn(async (request: PresentationWork): Promise<unknown> => {
  if (request.kind === "inspect") return inspectPresentation(request.bytes);
  if (request.kind === "render") {
    // The renderer's own answer for a slide the deck does not have.
    if (request.slideIds[0] !== slideId)
      throw new PresentationError("not_found", `Slide ${request.slideIds[0]} does not exist.`);
    return [{ slideId: request.slideIds[0]!, png, warning: "Approximate" }];
  }
  throw new Error("Unexpected presentation work");
});

beforeAll(async () => {
  database = await createTestDatabase();
  deck = await createPresentationDraft();
  slideId = (await inspectPresentation(deck)).slides[0]!.slideId;
  const infrastructure = Db.layer.pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(database.url), maxConnections: 8 })),
  );
  const bus = Layer.succeed(SyncBus, {
    publish: () => Effect.void,
    publishGlobal: () => Effect.void,
    signals: Stream.make({ type: "ready" } as const).pipe(Stream.concat(Stream.never)),
    subscribe: () => Stream.empty,
  });
  const repos = Layer.mergeAll(
    AttachmentRepo.layer,
    bus,
    fsBlobStoreLayer,
    FakeDocumentParser,
  ).pipe(
    Layer.provideMerge(FeaturePolicy.layer),
    Layer.provideMerge(StorageQuota.layer),
    Layer.provideMerge(infrastructure),
  );
  const attachments = AttachmentService.layer.pipe(Layer.provideMerge(repos));
  const processor = Layer.succeed(PresentationProcessor, {
    // The stub answers whichever job it is asked; the route asks for inspections and renders.
    run: (request: PresentationWork) => work(request) as never,
    close: async () => {},
  });
  runtime = ManagedRuntime.make(
    Layer.mergeAll(ProjectFileService.layer, ProjectService.layer, processor).pipe(
      Layer.provideMerge(attachments),
    ),
  );
}, 180_000);
afterAll(async () => {
  await runtime?.dispose();
  await database?.drop();
});

const run = <A, E>(
  effect: Effect.Effect<A, E, Db | AttachmentService | ProjectFileService | ProjectService>,
) => runtime.runPromise(effect);
const createUser = async () => {
  const id = uuidv7();
  await run(
    Effect.flatMap(Db, (db) => db.insert(user).values({ id, name: "Member", email: `${id}@t.io` })),
  );
  await run(seedEligibleSession(id));
  return id;
};
const get = (kind: string, fileId: string, userId?: string, slide?: string, approved = true) => {
  const url = new URL(`http://localhost/api/presentations/${kind}/${fileId}`);
  if (slide !== undefined) url.searchParams.set("slide", slide);
  const request = new Request(url, {
    headers: userId ? { "x-test-user": userId, "x-test-approved": String(approved) } : {},
  });
  const handlers = Route.options.server!.handlers!;
  if (typeof handlers === "function") throw new Error("Expected static route handlers");
  return Promise.resolve(handlers.GET!({ request, params: { kind, fileId } } as never)).then(
    (result) => {
      if (!(result instanceof Response)) throw new Error("Expected a preview response");
      return result;
    },
  );
};
const expectPrivate = (response: Response) => {
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
};

describe("presentation preview route", () => {
  it("rejects anonymous, unapproved, unknown kinds and inaccessible attachments before processing", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const attachment = await run(
      Effect.flatMap(AttachmentService, (service) =>
        service.upload({
          userId: owner,
          fileName: "deck.pptx",
          declaredMediaType:
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          bytes: deck,
        }),
      ),
    );
    work.mockClear();
    for (const [response, status] of [
      [await get("attachment", attachment.id), 401],
      [await get("attachment", attachment.id, owner, undefined, false), 401],
      [await get("unknown", attachment.id, owner), 404],
      [await get("attachment", attachment.id, stranger), 404],
      [await get("attachment", uuidv7(), owner), 404],
    ] as const) {
      expect(response.status).toBe(status);
      expectPrivate(response);
    }
    expect(work).not.toHaveBeenCalled();

    const listing = await get("attachment", attachment.id, owner);
    expect(listing.status).toBe(200);
    expectPrivate(listing);
    expect(listing.headers.get("Content-Type")).toContain("application/json");
    const metadata = await listing.json();
    expect(metadata).toMatchObject({
      slideIds: [slideId],
      count: 1,
    });
    expect(metadata.aspectRatio).toBeCloseTo(16 / 9);
    const image = await get("attachment", attachment.id, owner, String(slideId));
    expect(image.status).toBe(200);
    expectPrivate(image);
    expect(image.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);
  });

  it("rejects malformed, noncanonical and absent slide IDs without rendering", async () => {
    const owner = await createUser();
    const project = await run(
      Effect.flatMap(ProjectService, (s) => s.create(owner, { name: "Slides" })),
    );
    const file = await run(
      Effect.flatMap(ProjectFileService, (s) =>
        s.write(
          { origin: "user", userId: owner },
          { projectId: project.id, name: "slides.pptx", bytes: deck },
        ),
      ),
    );
    work.mockClear();
    const invalidIds = [
      "",
      " ",
      ` ${slideId}`,
      `${slideId} `,
      `+${slideId}`,
      `0x${slideId.toString(16)}`,
      `${slideId}.0`,
      `${slideId}e0`,
      "NaN",
      "-1",
      "9999999999999999999999",
    ];
    const responses = await Promise.all(
      invalidIds.map((id) => get("project-version", file.versionId, owner, id)),
    );
    for (const response of responses) {
      expect(response.status).toBe(404);
      expectPrivate(response);
    }
    expect(work).not.toHaveBeenCalled();
    // A well-formed id the deck lacks is the renderer's to refuse; nothing inspects first.
    const unknown = await get("project-version", file.versionId, owner, "999");
    expect(unknown.status).toBe(404);
    expectPrivate(unknown);
    expect(work.mock.calls.map(([request]) => request.kind)).toEqual(["render"]);
    const image = await get("project-version", file.versionId, owner, String(slideId));
    expect(image.status).toBe(200);
    expectPrivate(image);
    expect(image.headers.get("Content-Type")).toBe("image/png");
  });

  it("revokes a project member’s metadata and image access immediately", async () => {
    const owner = await createUser();
    const member = await createUser();
    const stranger = await createUser();
    const project = await run(
      Effect.flatMap(ProjectService, (s) => s.create(owner, { name: "Shared" })),
    );
    await run(
      Effect.flatMap(ProjectService, (s) =>
        s.changeMembers(owner, project.id, {
          action: "addUser",
          email: `${member}@t.io`,
          role: "viewer",
        }),
      ),
    );
    const file = await run(
      Effect.flatMap(ProjectFileService, (s) =>
        s.write(
          { origin: "user", userId: owner },
          { projectId: project.id, name: "shared.pptx", bytes: deck },
        ),
      ),
    );
    expect((await get("project-version", file.versionId, member)).status).toBe(200);
    expect((await get("project-version", file.versionId, member, String(slideId))).status).toBe(
      200,
    );
    work.mockClear();
    const forbidden = await get("project-version", file.versionId, stranger);
    expect(forbidden.status).toBe(404);
    expectPrivate(forbidden);
    await run(
      Effect.flatMap(ProjectService, (s) =>
        s.changeMembers(owner, project.id, {
          action: "removeUser",
          userId: member,
        }),
      ),
    );
    for (const response of [
      await get("project-version", file.versionId, member),
      await get("project-version", file.versionId, member, String(slideId)),
    ]) {
      expect(response.status).toBe(404);
      expectPrivate(response);
    }
    expect(work).not.toHaveBeenCalled();
    expect((await get("project-version", file.versionId, owner)).status).toBe(200);
  });

  it("refuses a file that is not a PowerPoint without any worker work", async () => {
    const owner = await createUser();
    const notes = await run(
      Effect.flatMap(AttachmentService, (service) =>
        service.upload({
          userId: owner,
          fileName: "notes.pptx.txt",
          declaredMediaType:
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          bytes: new TextEncoder().encode("not a deck"),
        }),
      ),
    );
    work.mockClear();
    for (const response of [
      await get("attachment", notes.id, owner),
      await get("attachment", notes.id, owner, String(slideId)),
    ]) {
      expect(response.status).toBe(422);
      expectPrivate(response);
    }
    expect(work).not.toHaveBeenCalled();
  });

  it("serves a rendered slide again from memory, only after the access check", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const attachment = await run(
      Effect.flatMap(AttachmentService, (service) =>
        service.upload({
          userId: owner,
          fileName: "cached.pptx",
          declaredMediaType: "application/octet-stream",
          bytes: deck,
        }),
      ),
    );
    work.mockClear();
    expect((await get("attachment", attachment.id, owner, String(slideId))).status).toBe(200);
    // At most the one render; none if an earlier test already drew these bytes.
    const renders = work.mock.calls.length;
    expect(renders).toBeLessThanOrEqual(1);
    const again = await get("attachment", attachment.id, owner, String(slideId));
    expect(again.status).toBe(200);
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(png);
    const refused = await get("attachment", attachment.id, stranger, String(slideId));
    expect(refused.status).toBe(404);
    expect(work).toHaveBeenCalledTimes(renders);
  });
});
