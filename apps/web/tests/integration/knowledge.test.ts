import { Client } from "pg";
import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, ManagedRuntime, Redacted, Stream } from "effect";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRepo } from "~/modules/agents/server/repo.ts";
import { CustomToolRepo } from "~/modules/custom-tools/server/repo.ts";
import { AgentService } from "~/modules/agents/server/service.ts";
import type { AgentSettings } from "~/modules/agents/schema.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { BlobStoreError } from "~/modules/attachments/errors.ts";
import { BlobStore } from "~/modules/attachments/server/blob-store.ts";
import { DocumentParser } from "~/modules/attachments/server/document-parser.ts";
import {
  chunkDocument,
  CHUNKER_REVISION,
  pipelineFingerprint,
} from "~/modules/knowledge/server/chunking.ts";
import { readConnection } from "~/modules/knowledge/server/embedding-connection.ts";
import { EmbeddingSpace } from "~/modules/knowledge/server/embedding-space.ts";
import { KnowledgeIndexer } from "~/modules/knowledge/server/indexer.ts";
import { KnowledgeRepo } from "~/modules/knowledge/server/repo.ts";
import { KnowledgeService } from "~/modules/knowledge/server/service.ts";
import { SharingService } from "~/modules/sharing/server/service.ts";
import type { SharedResource } from "~/modules/sharing/schema.ts";
import { ALL_CAPABILITIES } from "~/modules/groups/policy.ts";
import { GroupRepo } from "~/modules/groups/server/repo.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import type { SyncEvent } from "~/modules/sync/events.ts";
import { KnowledgeSearch } from "~/modules/knowledge/server/search.ts";
import { AiGateway, ProviderUnreachable } from "~/modules/providers/server/gateway.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { ToolsRepo } from "~/modules/tools/server/repo.ts";
import { Db } from "~/server/db.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 5).toString("base64");

// A deterministic stand-in for a real embedding model: a handful of concept
// dimensions, so a paraphrase lands near its source without sharing a word.
// Real vectors are not needed to test that the index, the space fencing and
// the fusion behave.
const CONCEPTS = [
  ["terminate", "termination", "cancel", "cancelling", "end", "ending"],
  ["payment", "invoice", "invoices", "pay", "fee", "fees"],
  ["confidential", "confidentiality", "secret", "nda"],
];
const fakeEmbed = (text: string): number[] => {
  const words = text.toLowerCase().split(/\W+/u);
  // The trailing constant keeps the vector non-zero; cosine is undefined at 0.
  const raw = [...CONCEPTS.map((c) => words.filter((w) => c.includes(w)).length), 0.05];
  const norm = Math.hypot(...raw) || 1;
  return raw.map((value) => value / norm);
};
const DIMENSIONS = CONCEPTS.length + 1;
/** Lets one test change the fake's output width; null means the default fake. */
let fakeEmbedOverride: ((text: string) => number[]) | null = null;

let embedCalls = 0;
let embedFails = false;
let beforeEmbedDispatch: (() => Promise<void>) | null = null;
let onEmbed: ((inputs: ReadonlyArray<string>) => Promise<void>) | null = null;
let embedFailure: ProviderUnreachable | null = null;
/** Answers any request with more than one input the way Gemini on Vertex AI does. */
let refuseArrays = false;
let batchSizes: number[] = [];
const FakeGateway = Layer.succeed(AiGateway, {
  fetchCatalog: () => Effect.succeed([]),
  probeEmbeddingDimensions: () => Effect.die("no dimension probes in these tests"),
  probeChatModel: () => Effect.die("no model probes in these tests"),
  generateText: () => Effect.die("unused"),
  streamChat: () => Effect.die("unused") as never,
  embed: (input: {
    inputs: ReadonlyArray<string>;
    expectedDimensions?: number;
    beforeDispatch?: () => Effect.Effect<void, ProviderUnreachable>;
  }) =>
    Effect.gen(function* () {
      if (beforeEmbedDispatch) yield* Effect.promise(beforeEmbedDispatch);
      if (input.beforeDispatch) yield* input.beforeDispatch();
      embedCalls += 1;
      batchSizes.push(input.inputs.length);
      if (embedFailure) return yield* Effect.fail(embedFailure);
      if (refuseArrays && input.inputs.length > 1)
        return yield* Effect.fail(
          new ProviderUnreachable({
            providerId: "fake",
            message: "the embedding provider answered 400",
            diagnostic: { kind: "InvalidRequestError", status: 400 },
          }),
        );
      if (embedFails)
        return yield* Effect.fail(
          new ProviderUnreachable({ providerId: "fake", message: "the fake provider is down" }),
        );
      const embeddings = yield* Effect.promise(async () => {
        if (onEmbed) await onEmbed(input.inputs);
        return input.inputs.map((text) => (fakeEmbedOverride ?? fakeEmbed)(text));
      });
      const dimensions = embeddings[0]?.length ?? DIMENSIONS;
      // Mirror the real gateway's contract: a width the space did not approve
      // is a non-retryable failure, never a vector stored beside the others.
      if (input.expectedDimensions !== undefined && dimensions !== input.expectedDimensions)
        return yield* Effect.fail(
          new ProviderUnreachable({
            providerId: "fake",
            message: `embedding model returned ${dimensions} dimensions, expected ${input.expectedDimensions}`,
            diagnostic: { kind: "InvalidRequestError" },
          }),
        );
      return { embeddings, dimensions, inputTokens: input.inputs.length * 10 };
    }),
} as never);

const events: SyncEvent[] = [];
const FakeSync = Layer.succeed(
  SyncBus,
  SyncBus.of({
    publish: (_userId, event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    publishGlobal: (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    signals: Stream.make({ type: "ready" } as const).pipe(Stream.concat(Stream.never)),
    subscribe: () => Stream.empty,
  }),
);
let onBlobRead: (() => Promise<void>) | null = null;
const blobs = new Map<string, Uint8Array>();
const MemoryBlobStore = Layer.succeed(BlobStore, {
  put: (key: string, bytes: Uint8Array) => Effect.sync(() => void blobs.set(key, bytes)),
  get: (key: string) =>
    Effect.gen(function* () {
      if (onBlobRead) yield* Effect.promise(onBlobRead);
      const bytes = blobs.get(key);
      if (!bytes)
        return yield* new BlobStoreError({ operation: "get", key, message: "missing test blob" });
      return bytes;
    }),
  delete: (key: string) => Effect.sync(() => void blobs.delete(key)),
  exists: (key: string) => Effect.succeed(blobs.has(key)),
  deletePrefix: () => Effect.void,
} as never);

const FakeParser = Layer.succeed(DocumentParser, {
  parsePdf: () => Effect.die("no PDFs in this suite"),
  availability: () => Effect.succeed({ configured: false, enabled: false, scanEngine: null }),
});

let database: TestDatabase;
type Services =
  | Db
  | AgentRepo
  | AgentService
  | SharingService
  | GroupRepo
  | KnowledgeRepo
  | KnowledgeIndexer
  | KnowledgeSearch
  | KnowledgeService
  | AttachmentRepo
  | ToolsRepo
  | EmbeddingSpace;
let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>;

const run = <A, E>(effect: Effect.Effect<A, E, Services>) => runtime.runPromise(effect);

const exec = async (statement: string) =>
  (await run(Effect.flatMap(Db, (db) => db.execute(statement as never)))) as {
    rows: ReadonlyArray<Record<string, unknown>>;
  };

const createUser = async (role: "user" | "admin" = "user") => {
  const id = uuidv7();
  await exec(
    `insert into "user" (id, name, email, role) values ('${id}', 'U', '${id}@t.io', '${role}')`,
  );
  await exec(`insert into user_approvals (user_id, status) values ('${id}', 'approved')`);
  return id;
};

/** Runs the background workers to completion instead of waiting on a fiber. */
const drainIndexer = () =>
  run(
    Effect.gen(function* () {
      const indexer = yield* KnowledgeIndexer;
      yield* indexer.recoverExpiredJobs();
      for (let step = 0; step < 50; step++) if (!(yield* indexer.runExtraction())) break;
      for (let step = 0; step < 50; step++) if (!(yield* indexer.runEmbedding())) break;
    }),
  );

const configureEmbeddings = async (input: {
  spaceId: string | null;
  enabled: boolean;
  modelId?: string;
}) => {
  const connection = input.modelId
    ? await run(Effect.flatMap(Db, (db) => readConnection(db, input.modelId!)))
    : null;
  await exec(
    `update tools set enabled = ${input.enabled}, config = '${JSON.stringify({
      spaceId: input.spaceId,
      embeddingModelId: input.modelId ?? null,
      dimensions: input.spaceId ? DIMENSIONS : null,
      connectionRevision: input.spaceId ? uuidv7() : null,
      approvedConnection: connection,
    })}' where name = 'knowledge_search'`,
  );
};

let embeddingModelId: string;

beforeAll(async () => {
  database = await createTestDatabase();
  const url = database.url;

  const InfraLayer = Layer.mergeAll(Db.layer, KeyCipher.layer).pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(url), maxConnections: 5 })),
  );
  const ReposLayer = Layer.mergeAll(
    KnowledgeRepo.layer,
    CustomToolRepo.layer,
    AgentRepo.layer,
    GroupRepo.layer,
    AttachmentRepo.layer,
    ToolsRepo.layer,
    ProviderRepo.layer,
  ).pipe(Layer.provideMerge(FeaturePolicy.layer), Layer.provideMerge(InfraLayer));
  const AppLayer = Layer.mergeAll(
    KnowledgeIndexer.layer,
    KnowledgeSearch.layer,
    KnowledgeService.layer,
    AgentService.layer,
    SharingService.layer,
  ).pipe(
    Layer.provideMerge(EmbeddingSpace.layer),
    Layer.provideMerge(AttachmentService.layer),
    Layer.provideMerge(
      Layer.mergeAll(FakeGateway, MemoryBlobStore, FakeParser, FakeSync).pipe(
        Layer.provideMerge(ReposLayer),
      ),
    ),
  );
  runtime = ManagedRuntime.make(AppLayer);

  const providerId = uuidv7();
  embeddingModelId = uuidv7();
  await exec(
    `insert into providers (id, name, preset, base_url, api_key_ciphertext)
     values ('${providerId}', 'P', 'custom', 'http://x', 'x')`,
  );
  await exec(
    `insert into models (id, provider_id, model_key, display_name, type, embedding_dimensions)
     values ('${embeddingModelId}', '${providerId}', 'embed-1', 'Embed', 'embedding', ${DIMENSIONS})`,
  );
}, 240_000);

afterAll(async () => {
  await runtime?.dispose();
  await database?.drop();
});

// Explicit grant fixtures for tests of ingestion/search rather than sharing policy.
const grantFixture = (collectionId: string, userId: string) =>
  Effect.promise(() =>
    exec(
      `insert into knowledge_collection_user_grants (collection_id, user_id) values ('${collectionId}', '${userId}') on conflict do nothing`,
    ),
  ).pipe(Effect.asVoid);
const revokeFixture = (collectionId: string, userId: string) =>
  Effect.promise(() =>
    exec(
      `delete from knowledge_collection_user_grants where collection_id = '${collectionId}' and user_id = '${userId}'`,
    ),
  ).pipe(Effect.asVoid);

describe("knowledge access", () => {
  it("keeps a private collection to its owner and honours each additive grant", async () => {
    const owner = await createUser("admin");
    const invited = await createUser();
    const colleague = await createUser();
    const stranger = await createUser();
    const admin = await createUser("admin");

    const collectionId = await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.createCollection(owner, { name: "Contracts", description: "" }),
      ),
    );
    const visibleTo = (userId: string) =>
      run(Effect.flatMap(KnowledgeRepo, (repo) => repo.getCollection(userId, collectionId)));

    expect(await visibleTo(owner)).toMatchObject({ name: "Contracts", canEdit: true });
    expect(await visibleTo(stranger)).toBeNull();
    // Being an admin is not a licence to read someone's private documents;
    // publishing to the instance is the administrative act, not reading.
    expect(await visibleTo(admin)).toBeNull();

    await run(
      Effect.flatMap(SharingService, (service) =>
        service.change(
          owner,
          { kind: "collection", id: collectionId },
          { action: "email", email: `${invited}@t.io` },
        ),
      ),
    );
    expect(await visibleTo(invited)).toMatchObject({ canEdit: false, ownerName: "U" });
    expect(await visibleTo(stranger)).toBeNull();

    const groupId = uuidv7();
    await exec(`insert into groups (id, name) values ('${groupId}', 'Legal-${groupId}')`);
    await exec(
      `insert into group_members (group_id, user_id) values ('${groupId}', '${colleague}')`,
    );
    expect(await visibleTo(colleague)).toBeNull();
    await run(
      Effect.flatMap(SharingService, (service) =>
        service.change(
          owner,
          { kind: "collection", id: collectionId },
          { action: "group", groupId },
        ),
      ),
    );
    expect(await visibleTo(colleague)).not.toBeNull();

    // Leaving the group ends membership-based access; the direct grant to
    // someone else is untouched by it.
    await exec(
      `delete from group_members where group_id = '${groupId}' and user_id = '${colleague}'`,
    );
    expect(await visibleTo(colleague)).toBeNull();
    expect(await visibleTo(invited)).not.toBeNull();

    await run(
      Effect.flatMap(SharingService, (service) =>
        service.change(
          owner,
          { kind: "collection", id: collectionId },
          { action: "publish", audience: "instance" },
        ),
      ),
    );
    expect(await visibleTo(stranger)).toMatchObject({ canEdit: false });
    await run(
      Effect.flatMap(SharingService, (service) =>
        service.change(
          owner,
          { kind: "collection", id: collectionId },
          { action: "publish", audience: "private" },
        ),
      ),
    );
    expect(await visibleTo(stranger)).toBeNull();

    // Revoking the direct grant takes future access away immediately.
    await run(
      Effect.flatMap(SharingService, (service) =>
        service.change(
          owner,
          { kind: "collection", id: collectionId },
          { action: "revokeUser", userId: invited },
        ),
      ),
    );
    expect(await visibleTo(invited)).toBeNull();
  });

  it("only offers groups the sharer is actually allowed to share into", async () => {
    const member = await createUser();
    const open = uuidv7();
    const closed = uuidv7();
    await exec(`insert into groups (id, name) values ('${open}', 'Open-${open}')`);
    await exec(`insert into groups (id, name) values ('${closed}', 'Closed-${closed}')`);
    for (const groupId of [open, closed]) {
      await exec(
        `insert into group_members (group_id, user_id) values ('${groupId}', '${member}')`,
      );
    }

    const resource = {
      kind: "collection" as const,
      id: await run(
        Effect.flatMap(KnowledgeRepo, (repo) =>
          repo.createCollection(member, { name: "Sharing", description: "" }),
        ),
      ),
    };
    await run(
      GroupRepo.use((repo) =>
        repo.setMemberSharing(open, member, {
          agents: true,
          knowledge: true,
          skills: true,
          projects: false,
        }),
      ),
    );
    const forMember = await run(
      Effect.flatMap(SharingService, (service) => service.detail(member, resource)),
    );
    expect(forMember.eligibleGroups.map((group) => group.id)).toEqual([open]);
    await exec(`update "user" set role = 'admin' where id = '${member}'`);
    const forAdmin = await run(
      Effect.flatMap(SharingService, (service) => service.detail(member, resource)),
    );
    expect(forAdmin.eligibleGroups.length).toBeGreaterThanOrEqual(2);
  });

  it("removes a mirrored source only while its owner may still change the collection", async () => {
    const owner = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.createCollection(owner, { name: "Mirrored", description: "" }),
      ),
    );
    const integrationId = uuidv7();
    const sourceId = uuidv7();
    await exec(
      `insert into integration_configs (id, kind, name) values ('${integrationId}', 'outline', 'Wiki')`,
    );
    await exec(
      `insert into knowledge_sources (id, collection_id, integration_id, root) values ('${sourceId}', '${collectionId}', '${integrationId}', '{}')`,
    );
    const remove = () =>
      run(Effect.flatMap(KnowledgeRepo, (repo) => repo.removeSource(owner, sourceId)));
    const group = await run(GroupRepo.use((repo) => repo.createGroup(`Readers-${uuidv7()}`)));
    await run(
      GroupRepo.use((repo) =>
        repo.updateGroupCapabilities(group.id, { ...ALL_CAPABILITIES, knowledgeCreate: false }),
      ),
    );
    await run(GroupRepo.use((repo) => repo.addMember(group.id, owner)));
    expect(await remove()).toBe(false);
    await run(GroupRepo.use((repo) => repo.removeMember(group.id, owner)));
    expect(await remove()).toBe(true);
  });

  it("resolves a manifest only from collections the caller may use", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.createCollection(owner, { name: "Private", description: "" }),
      ),
    );
    await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.addNoteDocument(owner, {
          collectionId,
          title: "Note",
          content: "Some content worth indexing.",
        }),
      ),
    );
    await drainIndexer();

    const mine = await run(
      Effect.flatMap(KnowledgeRepo, (repo) => repo.resolveManifest(owner, [collectionId])),
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ title: "Note", status: "ready" });
    // Guessing the id is not access.
    expect(
      await run(
        Effect.flatMap(KnowledgeRepo, (repo) =>
          Effect.flip(repo.resolveManifest(stranger, [collectionId])),
        ),
      ),
    ).toMatchObject({ _tag: "KnowledgeNotAvailable", resourceId: collectionId });
  });
});

describe("knowledge application boundary", () => {
  it("reads exact Unicode-safe ranges independently of search chunk boundaries", async () => {
    await configureEmbeddings({ spaceId: null, enabled: false });
    const owner = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.createCollection(owner, { name: "Ranges", description: "" }),
      ),
    );
    const text = `  [page 1]\n${"😀 payment terms. ".repeat(350)}  \n\n[page 2]\n${"𐐀 next page. ".repeat(350)}  `;
    const document = (await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.addNoteDocument(owner, { collectionId, title: "Unicode", content: text }),
      ),
    ))!;
    await drainIndexer();
    const reference = { collectionId, ...document };
    const metadata = await run(
      Effect.flatMap(KnowledgeRepo, (repo) => repo.readVersionForAccess(owner, reference)),
    );
    expect(metadata).toMatchObject({ title: "Unicode", charCount: text.length });
    expect(metadata).not.toHaveProperty("text");
    const chunks = chunkDocument(text);
    const starts = [
      0,
      text.indexOf("😀"),
      ...chunks.map((chunk) => Math.max(0, chunk.startOffset - 3)),
      text.length,
    ].filter((offset) => !/[\uDC00-\uDFFF]/.test(text.charAt(offset)));
    for (const startOffset of starts) {
      const excerpt = await run(
        Effect.flatMap(KnowledgeService, (service) =>
          service.read(owner, { ...reference, startOffset, maxChars: 4000 }),
        ),
      );
      const requestedEnd = Math.min(text.length, startOffset + 4000);
      const endOffset = /[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(
        text.slice(requestedEnd - 1, requestedEnd + 1),
      )
        ? requestedEnd - 1
        : requestedEnd;
      expect(excerpt.content).not.toMatch(/[\uD800-\uDFFF]/u);
      expect(excerpt).toMatchObject({
        content: text.slice(startOffset, endOffset),
        startOffset,
        endOffset,
        totalChars: text.length,
        nextOffset: endOffset < text.length ? endOffset : null,
      });
    }
    for (const invalid of [
      { startOffset: text.indexOf("😀") + 1, maxChars: 100 },
      { startOffset: text.indexOf("😀"), maxChars: 1 },
    ])
      expect(
        await run(
          Effect.flatMap(KnowledgeService, (service) =>
            Effect.flip(service.read(owner, { ...reference, ...invalid })),
          ),
        ),
      ).toMatchObject({ _tag: "KnowledgeRejected" });
    // Search excerpts are not authority to reconstruct the original body.
    await exec(
      `update knowledge_chunks set content = 'unrelated excerpt' where version_id = '${document.versionId}' and ordinal = 0`,
    );
    const startOffset = text.indexOf("payment");
    const excerpt = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.read(owner, { ...reference, startOffset, maxChars: 4000 }),
      ),
    );
    expect(excerpt.content).toBe(text.slice(startOffset, startOffset + 4000));
  });

  it("loads full bodies across SQL batches in saved order and refuses partial access", async () => {
    await configureEmbeddings({ spaceId: null, enabled: false });
    const owner = await createUser();
    const outsider = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.createCollection(owner, { name: "Full bodies", description: "" }),
      ),
    );
    const references = await run(
      Effect.gen(function* () {
        const repo = yield* KnowledgeRepo;
        return yield* Effect.forEach(
          Array.from({ length: 35 }, (_, i) => i),
          (i) =>
            repo
              .addNoteDocument(owner, {
                collectionId,
                title: `Body ${i}`,
                content: `Evidence ${i} 😀`,
              })
              .pipe(
                Effect.map((document) => ({
                  collectionId,
                  ...document!,
                  charCount: `Evidence ${i} 😀`.length,
                })),
              ),
        );
      }),
    );
    await drainIndexer();
    const ordered = [...references].toReversed();
    const bodies = await run(
      Effect.flatMap(KnowledgeService, (service) => service.readBodies(owner, ordered)),
    );
    expect(bodies.map((body) => body.versionId)).toEqual(
      ordered.map((reference) => reference.versionId),
    );
    expect(bodies[0]?.text).toBe("Evidence 34 😀");
    for (const [actor, selection] of [
      [outsider, ordered],
      [owner, [ordered[0]!, { ...ordered[1]!, charCount: 1 }]],
    ] as const) {
      const error = await run(
        Effect.flatMap(KnowledgeService, (service) => service.readBodies(actor, selection)).pipe(
          Effect.flip,
        ),
      );
      expect(error._tag).toBe("KnowledgeNotAvailable");
    }
  });

  it("authorizes saved manifests against uncommitted grants in the caller transaction", async () => {
    await configureEmbeddings({ spaceId: null, enabled: false });
    const owner = await createUser();
    const recipient = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.createCollection(owner, { name: "Transaction", description: "" }),
      ),
    );
    await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.addNoteDocument(owner, { collectionId, title: "Evidence", content: "Evidence" }),
      ),
    );
    await drainIndexer();
    await run(
      Effect.gen(function* () {
        const repo = yield* KnowledgeRepo;
        const db = yield* Db;
        const manifest = yield* repo.resolveManifest(owner, [collectionId]);
        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.execute(
              `insert into knowledge_collection_user_grants (collection_id, user_id) values ('${collectionId}', '${recipient}')` as never,
            );
            yield* repo.authorizeManifest(recipient, [collectionId], manifest, tx);
          }),
        );
      }),
    );
  });

  it("keeps recipient and admin access read-only and validates bounded excerpts", async () => {
    await configureEmbeddings({ spaceId: null, enabled: false });
    const owner = await createUser();
    const recipient = await createUser();
    const admin = await createUser("admin");
    const collectionId = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.create(owner, { name: "  Private notes  ", description: "" }),
      ),
    );
    const document = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.addNote(owner, {
          collectionId,
          title: "Private note",
          content: "The full private source text.",
        }),
      ),
    );
    const reference = { collectionId, ...document, startOffset: 0, maxChars: 8 };
    await drainIndexer();
    for (const userId of [recipient, admin]) {
      expect(
        await run(
          Effect.flatMap(KnowledgeService, (service) =>
            Effect.flip(service.detail(userId, collectionId)),
          ),
        ),
      ).toMatchObject({ _tag: "KnowledgeNotAvailable" });
      expect(
        await run(
          Effect.flatMap(KnowledgeService, (service) =>
            Effect.flip(service.read(userId, reference)),
          ),
        ),
      ).toMatchObject({ _tag: "KnowledgeNotAvailable" });
    }
    await run(grantFixture(collectionId, recipient));
    const detail = await run(
      Effect.flatMap(KnowledgeService, (service) => service.detail(recipient, collectionId)),
    );
    expect(detail.collection).toMatchObject({ name: "Private notes", canEdit: false });
    expect(
      await run(Effect.flatMap(KnowledgeService, (service) => service.read(recipient, reference))),
    ).toMatchObject({ content: "The full", endOffset: 8, totalChars: 29, nextOffset: 8 });
    for (const mutation of [
      Effect.flatMap(KnowledgeService, (service) => service.remove(recipient, collectionId)),
      Effect.flatMap(KnowledgeService, (service) =>
        service.update(recipient, { collectionId, name: "Overwritten", description: "" }),
      ),
      Effect.flatMap(KnowledgeService, (service) =>
        service.removeDocument(recipient, document.documentId),
      ),
      Effect.flatMap(KnowledgeService, (service) =>
        service.addNote(recipient, { collectionId, title: "Injected", content: "Not allowed." }),
      ),
      Effect.flatMap(KnowledgeService, (service) => service.reindex(recipient, collectionId)),
    ])
      expect(await run(Effect.flip(mutation))).toMatchObject({ _tag: "KnowledgeNotAvailable" });
    expect(
      await run(
        Effect.flatMap(KnowledgeService, (service) =>
          Effect.flip(service.read(owner, { ...reference, documentId: uuidv7() })),
        ),
      ),
    ).toMatchObject({ _tag: "KnowledgeNotAvailable" });
    expect(
      await run(
        Effect.flatMap(KnowledgeService, (service) =>
          Effect.flip(service.read(owner, { ...reference, maxChars: 16_001 })),
        ),
      ),
    ).toMatchObject({ _tag: "KnowledgeRejected" });
    await run(revokeFixture(collectionId, recipient));
    expect(
      await run(
        Effect.flatMap(KnowledgeService, (service) =>
          Effect.flip(service.read(recipient, reference)),
        ),
      ),
    ).toMatchObject({ _tag: "KnowledgeNotAvailable" });
    expect(
      events.every(
        (event) =>
          ["resources.changed", "knowledge.index.changed"].includes(event.type) &&
          Object.keys(event).length === 1,
      ),
    ).toBe(true);
  });

  it("disposes the worker layer during PDF extraction and reclaims its expired lease after restart", async () => {
    await configureEmbeddings({ spaceId: null, enabled: false });
    await drainIndexer();
    const owner = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.create(owner, { name: "Worker restart", description: "" }),
      ),
    );
    const document = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.upload(owner, {
          collectionId,
          title: "PDF",
          fileName: "source.pdf",
          declaredMediaType: "application/pdf",
          bytes: new TextEncoder().encode("%PDF-1.7\nFake parser fixture"),
        }),
      ),
    );
    const { repo, space } = await run(Effect.all({ repo: KnowledgeRepo, space: EmbeddingSpace }));
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let aborted = false;
    const parsed = {
      text: "[page 1]\nRecovered source.",
      parsedWith: "pdf-3",
      truncated: false,
      totalPages: 1,
      pageCount: 1,
    };
    const workerRuntime = (parsePdf: DocumentParser["Service"]["parsePdf"]) =>
      ManagedRuntime.make(
        KnowledgeIndexer.workers.pipe(
          Layer.provideMerge(KnowledgeIndexer.layer),
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.succeed(KnowledgeRepo, repo),
              Layer.succeed(EmbeddingSpace, space),
              Layer.succeed(
                DocumentParser,
                DocumentParser.of({
                  parsePdf,
                  availability: () =>
                    Effect.succeed({ configured: true, enabled: true, scanEngine: "off" }),
                }),
              ),
              MemoryBlobStore,
              FakeGateway,
              FakeSync,
            ),
          ),
        ),
      );
    const first = workerRuntime(() =>
      Effect.promise(
        (signal) =>
          new Promise<typeof parsed>((resolve) => {
            markStarted();
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                resolve(parsed);
              },
              { once: true },
            );
          }),
      ),
    );
    let oldLease: string;
    try {
      await first.runPromise(Effect.void);
      await started;
      const row = (
        await exec(
          `select status, lease_token from knowledge_document_versions where id = '${document.versionId}'`,
        )
      ).rows[0]!;
      expect(row.status).toBe("extracting");
      oldLease = row.lease_token as string;
    } finally {
      await first.dispose();
    }
    expect(aborted).toBe(true);
    expect(
      (
        await exec(
          `select status, attempts, text from knowledge_document_versions where id = '${document.versionId}'`,
        )
      ).rows[0],
    ).toEqual({ status: "extracting", attempts: 1, text: null });
    await exec(
      `update knowledge_document_versions set lease_until = now() - interval '1 second' where id = '${document.versionId}'`,
    );
    const restarted = workerRuntime(() => Effect.succeed(parsed));
    try {
      await restarted.runPromise(Effect.void);
      await expect
        .poll(
          async () =>
            (
              await exec(
                `select status, attempts, text from knowledge_document_versions where id = '${document.versionId}'`,
              )
            ).rows[0],
          { timeout: 5_000, interval: 20 },
        )
        .toEqual({ status: "ready", attempts: 2, text: parsed.text });
      expect(
        await run(
          Effect.flatMap(KnowledgeRepo, (knowledge) =>
            knowledge.completeExtraction({
              versionId: document.versionId,
              leaseToken: oldLease!,
              text: "Late obsolete text",
              chunks: chunkDocument("Late obsolete text"),
              pageCount: 1,
              truncated: { truncated: false, reason: null },
            }),
          ),
        ),
      ).toBe(false);
    } finally {
      await restarted.dispose();
    }
    expect(
      (
        await run(
          Effect.flatMap(KnowledgeService, (service) =>
            service.read(owner, {
              collectionId,
              ...document,
              startOffset: 0,
              maxChars: 100,
            }),
          ),
        )
      ).content,
    ).toBe(parsed.text);
  });

  it("waits out a scan reader's rate limit, then publishes what it read on the last attempt", async () => {
    await configureEmbeddings({ spaceId: null, enabled: false });
    await drainIndexer();
    const owner = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.create(owner, { name: "Scans", description: "" }),
      ),
    );
    const document = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.upload(owner, {
          collectionId,
          title: "Scanned PDF",
          fileName: "scan.pdf",
          declaredMediaType: "application/pdf",
          bytes: new TextEncoder().encode("%PDF-1.7\nFake scanned fixture"),
        }),
      ),
    );
    const { repo, space } = await run(Effect.all({ repo: KnowledgeRepo, space: EmbeddingSpace }));
    const owners: Array<string | undefined> = [];
    const partial = {
      text: "[page 1]\nCover\n\n[page 2]\n(scanned page, not read: Mistral is rate limiting)",
      parsedWith: "pdf-3+scan:mistral-ocr-4-1+incomplete",
      truncated: false,
      totalPages: 2,
      pageCount: 2,
      skippedPages: [2],
      retryable: { afterMs: 3_600_000 },
    };
    const indexer = ManagedRuntime.make(
      KnowledgeIndexer.workers.pipe(
        Layer.provideMerge(KnowledgeIndexer.layer),
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(KnowledgeRepo, repo),
            Layer.succeed(EmbeddingSpace, space),
            Layer.succeed(
              DocumentParser,
              DocumentParser.of({
                parsePdf: (input) =>
                  Effect.sync(() => {
                    owners.push(input.owner);
                    return partial;
                  }),
                availability: () =>
                  Effect.succeed({
                    configured: true,
                    enabled: true,
                    scanEngine: "mistral-ocr-4-1",
                  }),
              }),
            ),
            MemoryBlobStore,
            FakeGateway,
            FakeSync,
          ),
        ),
      ),
    );
    const version = () =>
      exec(
        `select status, attempts, lease_until > now() as waiting, truncated, pipeline_fingerprint from knowledge_document_versions where id = '${document.versionId}'`,
      ).then((result) => result.rows[0]);
    try {
      await indexer.runPromise(Effect.void);
      // The first attempt is put back with the reader's delay, not retried at once.
      await expect
        .poll(version, { timeout: 5_000, interval: 20 })
        .toMatchObject({ status: "queued", attempts: 1, waiting: true });
      expect(owners).toEqual([owner]);
      // The delay passes, and the last attempt publishes the pages it has.
      await exec(
        `update knowledge_document_versions set attempts = 2, lease_until = now() - interval '1 second' where id = '${document.versionId}'`,
      );
      await indexer.runPromise(
        Effect.flatMap(KnowledgeIndexer, (worker) => worker.runExtraction()),
      );
      await expect.poll(version, { timeout: 5_000, interval: 20 }).toMatchObject({
        status: "ready",
        attempts: 3,
        truncated: {
          truncated: true,
          reason: "Page 2 is a scan that wasn’t read.",
        },
        pipeline_fingerprint: `${partial.parsedWith}:chunker-${CHUNKER_REVISION}`,
      });
    } finally {
      await indexer.dispose();
    }
  });

  it("does not queue PDF extraction while parsing is disabled, but repairs usable embeddings", async () => {
    await configureEmbeddings({
      spaceId: "disabled-parser",
      enabled: true,
      modelId: embeddingModelId,
    });
    await drainIndexer();
    const owner = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.create(owner, { name: "PDF repair", description: "" }),
      ),
    );
    const doc = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.addNote(owner, { collectionId, title: "PDF", content: "Extracted invoice text." }),
      ),
    );
    await drainIndexer();
    // A published text fixture models a retained PDF; the disabled fake parser must never run.
    await exec(
      `update knowledge_document_versions set kind = 'file', media_type = 'application/pdf', pipeline_fingerprint = 'local:old' where id = '${doc.versionId}'`,
    );
    await exec(`delete from knowledge_embedding_jobs where version_id = '${doc.versionId}'`);
    expect(
      await run(
        Effect.flatMap(KnowledgeService, (service) => service.rebuildIndex(owner, collectionId)),
      ),
    ).toEqual({ reextracted: 0, reembedded: 1 });
    await drainIndexer();
    expect(
      (
        await exec(
          `select count(*)::int as n from knowledge_document_versions where document_id = '${doc.documentId}'`,
        )
      ).rows[0],
    ).toEqual({ n: 1 });
  });

  it("explicit rebuild retargets pending extraction without admitting it to an embedding worker", async () => {
    await configureEmbeddings({
      spaceId: "pending-original",
      enabled: true,
      modelId: embeddingModelId,
    });
    await drainIndexer();
    const owner = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.create(owner, { name: "Pending repair", description: "" }),
      ),
    );
    const doc = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.addNote(owner, {
          collectionId,
          title: "Pending",
          content: "Invoice payment terms.",
        }),
      ),
    );
    await configureEmbeddings({
      spaceId: "pending-next",
      enabled: true,
      modelId: embeddingModelId,
    });
    expect(
      (
        await exec(
          `select space_id from knowledge_embedding_jobs where version_id = '${doc.versionId}'`,
        )
      ).rows[0],
    ).toEqual({ space_id: "pending-original" });
    expect(
      await run(
        Effect.flatMap(KnowledgeService, (service) => service.rebuildIndex(owner, collectionId)),
      ),
    ).toEqual({ reextracted: 0, reembedded: 1 });
    expect(
      (
        await exec(
          `select space_id from knowledge_embedding_jobs where version_id = '${doc.versionId}'`,
        )
      ).rows[0],
    ).toEqual({ space_id: "pending-next" });
    expect(await run(Effect.flatMap(KnowledgeIndexer, (indexer) => indexer.runEmbedding()))).toBe(
      false,
    );
    await drainIndexer();
    expect(
      (
        await exec(
          `select status from knowledge_embedding_jobs where version_id = '${doc.versionId}'`,
        )
      ).rows[0],
    ).toEqual({ status: "ready" });
  });

  it("rebuilds only documents whose text predates the current pipeline, retaining old versions", async () => {
    await configureEmbeddings({ spaceId: null, enabled: false });
    await drainIndexer();
    const owner = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.create(owner, { name: "Provenance", description: "" }),
      ),
    );
    const note = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.addNote(owner, { collectionId, title: "Note", content: "The note source." }),
      ),
    );
    await drainIndexer();
    // Publication records the pipeline that produced the text.
    expect(
      (
        await exec(
          `select pipeline_fingerprint from knowledge_document_versions where id = '${note.versionId}'`,
        )
      ).rows[0],
    ).toEqual({ pipeline_fingerprint: `none:chunker-${CHUNKER_REVISION}` });

    // Nothing to do while every document already matches.
    expect(
      await run(
        Effect.flatMap(KnowledgeService, (service) => service.rebuildContent(owner, collectionId)),
      ),
    ).toBe(0);

    // An older chunker: the content is still citable, it just predates a change.
    await exec(
      `update knowledge_document_versions set pipeline_fingerprint = 'none:chunker-1' where id = '${note.versionId}'`,
    );
    expect(
      await run(
        Effect.flatMap(KnowledgeService, (service) => service.rebuildContent(owner, collectionId)),
      ),
    ).toBe(1);
    // The published version keeps answering until the new one is ready.
    expect(
      (
        await run(
          Effect.flatMap(KnowledgeService, (service) => service.detail(owner, collectionId)),
        )
      ).documents[0],
    ).toMatchObject({ versionId: note.versionId, replacement: { status: "queued" } });
    expect(
      (
        await run(
          Effect.flatMap(KnowledgeService, (service) =>
            service.read(owner, { collectionId, ...note, startOffset: 0, maxChars: 50 }),
          ),
        )
      ).content,
    ).toBe("The note source.");

    await drainIndexer();
    const after = (
      await run(Effect.flatMap(KnowledgeService, (service) => service.detail(owner, collectionId)))
    ).documents[0]!;
    expect(after.versionId).not.toBe(note.versionId);
    expect(after.replacement).toBeNull();
    // The retained version still resolves for citations made against it.
    expect(
      (
        await run(
          Effect.flatMap(KnowledgeService, (service) =>
            service.read(owner, { collectionId, ...note, startOffset: 0, maxChars: 50 }),
          ),
        )
      ).content,
    ).toBe("The note source.");
    expect(
      (
        await exec(
          `select count(*)::int as total from knowledge_document_versions where document_id = '${note.documentId}'`,
        )
      ).rows[0],
    ).toEqual({ total: 2 });
    // A second pass has nothing left to rebuild.
    expect(
      await run(
        Effect.flatMap(KnowledgeService, (service) => service.rebuildContent(owner, collectionId)),
      ),
    ).toBe(0);
  });

  it("rebuilds only what is stale: old text is re-extracted, missing vectors re-embedded, current ones left alone", async () => {
    await configureEmbeddings({
      spaceId: "rebuild-index",
      enabled: true,
      modelId: embeddingModelId,
    });
    await drainIndexer();
    const owner = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.create(owner, { name: "Rebuild index", description: "" }),
      ),
    );
    const add = (title: string) =>
      run(
        Effect.flatMap(KnowledgeService, (service) =>
          service.addNote(owner, { collectionId, title, content: `${title} payment terms.` }),
        ),
      );
    const current = await add("Current");
    const stale = await add("Stale text");
    const unembedded = await add("Unembedded");
    await drainIndexer();
    const before = embedCalls;
    // One document predates the chunker; one lost its vectors; one is healthy.
    await exec(
      `update knowledge_document_versions set pipeline_fingerprint = 'none:chunker-1' where id = '${stale.versionId}'`,
    );
    await exec(`delete from knowledge_embedding_jobs where version_id = '${unembedded.versionId}'`);

    const first = await run(
      Effect.flatMap(KnowledgeService, (service) => service.rebuildIndex(owner, collectionId)),
    );
    expect(first).toEqual({ reextracted: 1, reembedded: 1 });
    await drainIndexer();
    // The healthy document was not touched: its job row and vectors are the originals.
    expect(
      (
        await exec(
          `select count(*)::int as total from knowledge_document_versions where document_id = '${current.documentId}'`,
        )
      ).rows[0],
    ).toEqual({ total: 1 });
    const detail = await run(
      Effect.flatMap(KnowledgeService, (service) => service.detail(owner, collectionId)),
    );
    expect(detail.documents.map((d) => [d.title, d.status, d.semanticStatus])).toEqual([
      ["Current", "ready", "ready"],
      ["Stale text", "ready", "ready"],
      ["Unembedded", "ready", "ready"],
    ]);
    expect(embedCalls).toBeGreaterThan(before);

    // Running it again on a healthy collection queues nothing.
    const calls = embedCalls;
    expect(
      await run(
        Effect.flatMap(KnowledgeService, (service) => service.rebuildIndex(owner, collectionId)),
      ),
    ).toEqual({ reextracted: 0, reembedded: 0 });
    await drainIndexer();
    expect(embedCalls).toBe(calls);
  });

  it("leaves a document mid-replacement alone and refuses a rebuild from a non-owner", async () => {
    await configureEmbeddings({ spaceId: null, enabled: false });
    await drainIndexer();
    const owner = await createUser();
    const stranger = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.create(owner, { name: "Pending", description: "" }),
      ),
    );
    const note = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.addNote(owner, { collectionId, title: "Note", content: "Original." }),
      ),
    );
    await drainIndexer();
    await exec(
      `update knowledge_document_versions set pipeline_fingerprint = 'none:chunker-1' where id = '${note.versionId}'`,
    );
    // A queued replacement already owns this document's next version.
    await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.replaceNote(owner, {
          collectionId,
          documentId: note.documentId,
          title: "Note",
          content: "Edited while stale.",
        }),
      ),
    );
    expect(
      await run(
        Effect.flatMap(KnowledgeService, (service) => service.rebuildContent(owner, collectionId)),
      ),
    ).toBe(0);
    expect(
      (
        await exec(
          `select count(*)::int as total from knowledge_document_versions where document_id = '${note.documentId}'`,
        )
      ).rows[0],
    ).toEqual({ total: 2 });
    expect(
      await run(
        Effect.flatMap(KnowledgeService, (service) =>
          Effect.flip(service.rebuildContent(stranger, collectionId)),
        ),
      ),
    ).toMatchObject({ _tag: "KnowledgeNotAvailable" });
    await drainIndexer();
  });

  it("publishes text containing NUL by stripping it, instead of failing every attempt", async () => {
    // Postgres rejects U+0000 in text columns. Before the fix this note's
    // insert died on each lease and the owner saw a document stuck "indexing"
    // until the attempts ran out, indistinguishable from a timeout.
    await configureEmbeddings({ spaceId: null, enabled: false });
    await drainIndexer();
    const owner = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.create(owner, { name: "Control characters", description: "" }),
      ),
    );
    const nul = String.fromCharCode(0);
    const note = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.addNote(owner, {
          collectionId,
          title: "Ticket",
          content: `LOVE AT FIRST SLIDE ${nul}${nul} Presenterticket`,
        }),
      ),
    );
    await drainIndexer();
    const detail = await run(
      Effect.flatMap(KnowledgeService, (service) => service.detail(owner, collectionId)),
    );
    expect(detail.documents[0]).toMatchObject({ status: "ready", error: null, truncated: false });
    const text = (
      await run(
        Effect.flatMap(KnowledgeService, (service) =>
          service.read(owner, { collectionId, ...note, startOffset: 0, maxChars: 200 }),
        ),
      )
    ).content;
    expect(text).toBe("LOVE AT FIRST SLIDE  Presenterticket");
    expect(text.includes(nul)).toBe(false);
  });

  it("publishes a document with scanned pages as ready-but-partial, and says which pages", async () => {
    await configureEmbeddings({ spaceId: null, enabled: false });
    await drainIndexer();
    const owner = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.create(owner, { name: "Mixed scan", description: "" }),
      ),
    );
    const document = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.addNote(owner, { collectionId, title: "Placeholder", content: "placeholder" }),
      ),
    );
    // Drive the publication the worker performs for a parser that skipped
    // page 2: exact text for pages 1 and 3, a bare marker for page 2.
    const claim = (await run(Effect.flatMap(KnowledgeRepo, (repo) => repo.claimExtraction())))!;
    expect(claim.version.id).toBe(document.versionId);
    const text = "[page 1]\nReadable introduction\n\n[page 2]\n\n[page 3]\nReadable conclusion";
    expect(
      await run(
        Effect.flatMap(KnowledgeRepo, (repo) =>
          repo.completeExtraction({
            versionId: document.versionId,
            leaseToken: claim.leaseToken,
            text,
            pageCount: 3,
            truncated: {
              truncated: true,
              reason: "Page 2 has no extractable text (probably scanned) and was skipped.",
            },
            chunks: chunkDocument(text),
            parsedWith: "pdf-3",
          }),
        ),
      ),
    ).toBe(true);
    const detail = await run(
      Effect.flatMap(KnowledgeService, (service) => service.detail(owner, collectionId)),
    );
    expect(detail.documents[0]).toMatchObject({
      status: "ready",
      truncated: true,
      pageCount: 3,
    });
    // The present pages are exact, citable text; the manifest flags the gap so
    // direct context is refused and the model is told coverage is partial.
    const manifest = await run(
      Effect.flatMap(KnowledgeService, (service) => service.manifest(owner, [collectionId])),
    );
    expect(manifest[0]).toMatchObject({ status: "ready", truncated: true });
    const hits = await run(
      Effect.flatMap(KnowledgeSearch, (search) =>
        search.search({
          userId: owner,
          versionIds: [document.versionId],
          query: "conclusion",
          limit: 3,
        }),
      ),
    );
    expect(hits.passages[0]?.page).toBe(3);
  });

  it("reuses identical note submissions across queued, published and concurrent replacement saves", async () => {
    await configureEmbeddings({
      spaceId: "unchanged-notes",
      enabled: true,
      modelId: embeddingModelId,
    });
    await drainIndexer();
    const owner = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.create(owner, { name: "Unchanged notes", description: "" }),
      ),
    );
    const input = { collectionId, title: "Original", content: "The payment terms." };
    const original = await run(
      Effect.flatMap(KnowledgeService, (service) => service.addNote(owner, input)),
    );
    const save = (title = input.title, content = input.content) =>
      run(
        Effect.flatMap(KnowledgeService, (service) =>
          service.replaceNote(owner, {
            collectionId,
            documentId: original.documentId,
            title,
            content,
          }),
        ),
      );
    expect(await save()).toEqual(original);
    await drainIndexer();
    const calls = embedCalls;
    expect(await save()).toEqual(original);
    await drainIndexer();
    expect(embedCalls).toBe(calls);
    const concurrent = await Promise.all([save("Edited"), save("Edited"), save("Edited")]);
    expect(new Set(concurrent.map((result) => result.versionId)).size).toBe(1);
    expect(concurrent[0]!.versionId).not.toBe(original.versionId);
    expect(
      (
        await exec(
          `select count(*)::int as total from knowledge_document_versions where document_id = '${original.documentId}'`,
        )
      ).rows[0],
    ).toEqual({ total: 2 });
    expect(
      (
        await exec(
          `select count(*)::int as total from knowledge_embedding_jobs j join knowledge_document_versions v on v.id = j.version_id where v.document_id = '${original.documentId}'`,
        )
      ).rows[0],
    ).toEqual({ total: 2 });
    // Reverting an older submission supersedes the latest pending replacement;
    // it must not accidentally leave that newer content scheduled to publish.
    const reverted = await save();
    expect(reverted.versionId).not.toBe(original.versionId);
    expect(reverted.versionId).not.toBe(concurrent[0]!.versionId);
    expect(await save()).toEqual(reverted);
    await drainIndexer();
  });

  it("keeps an unchanged failed submission failed until an explicit retry", async () => {
    await configureEmbeddings({ spaceId: null, enabled: false });
    await drainIndexer();
    const owner = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.create(owner, { name: "Explicit retry", description: "" }),
      ),
    );
    const input = { collectionId, title: "Source", content: "Original source." };
    const original = await run(
      Effect.flatMap(KnowledgeService, (service) => service.addNote(owner, input)),
    );
    const claim = await run(Effect.flatMap(KnowledgeRepo, (repo) => repo.claimExtraction()));
    expect(claim?.version.id).toBe(original.versionId);
    await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.failExtraction({
          versionId: original.versionId,
          leaseToken: claim!.leaseToken,
          error: "test parser failure",
          retryable: false,
        }),
      ),
    );
    expect(
      await run(
        Effect.flatMap(KnowledgeService, (service) =>
          service.replaceNote(owner, { ...input, documentId: original.documentId }),
        ),
      ),
    ).toEqual(original);
    expect(
      (
        await exec(
          `select status, attempts from knowledge_document_versions where id = '${original.versionId}'`,
        )
      ).rows[0],
    ).toEqual({ status: "failed", attempts: 1 });
    await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.retryDocument(owner, original.documentId),
      ),
    );
    expect(
      (
        await exec(
          `select status, attempts from knowledge_document_versions where id = '${original.versionId}'`,
        )
      ).rows[0],
    ).toEqual({ status: "queued", attempts: 0 });
    await drainIndexer();
  });

  it("deduplicates unchanged file revisions while retaining versioned filename and title changes", async () => {
    await configureEmbeddings({ spaceId: null, enabled: false });
    const owner = await createUser();
    const stranger = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.create(owner, { name: "Unchanged files", description: "" }),
      ),
    );
    const upload = (documentId?: string, fileName = "source.txt", title = "Source") =>
      run(
        Effect.flatMap(KnowledgeService, (service) =>
          service.upload(owner, {
            collectionId,
            title,
            fileName,
            declaredMediaType: "text/plain",
            bytes: new TextEncoder().encode("Identical source bytes."),
            ...(documentId ? { documentId } : {}),
          }),
        ),
      );
    const original = await upload();
    const keys = [...blobs.keys()];
    expect(await upload(original.documentId)).toEqual(original);
    const simultaneous = await Promise.all([
      upload(original.documentId),
      upload(original.documentId),
    ]);
    expect(simultaneous).toEqual([original, original]);
    expect([...blobs.keys()]).toEqual(keys);
    await drainIndexer();
    expect(await upload(original.documentId)).toEqual(original);
    const renamedFile = await upload(original.documentId, "renamed.txt");
    const renamedTitle = await upload(original.documentId, "renamed.txt", "New title");
    expect(new Set([original.versionId, renamedFile.versionId, renamedTitle.versionId]).size).toBe(
      3,
    );
    expect(
      (await exec(`select count(*)::int as total from attachments where user_id = '${owner}'`))
        .rows[0],
    ).toEqual({ total: 0 });
    expect(
      (await exec(`select count(*)::int as total from attachment_blobs where user_id = '${owner}'`))
        .rows[0],
    ).toEqual({ total: 1 });
    expect(
      (
        await exec(
          `select count(*)::int as total from knowledge_document_versions where document_id = '${original.documentId}'`,
        )
      ).rows[0],
    ).toEqual({ total: 3 });
    const blobId = (
      await exec(
        `select blob_id from knowledge_document_versions where id = '${original.versionId}'`,
      )
    ).rows[0]!.blob_id as string;
    expect(
      await run(
        Effect.flatMap(KnowledgeRepo, (repo) =>
          repo.replaceFileDocument(stranger, {
            collectionId,
            documentId: original.documentId,
            title: "New title",
            blobId,
            fileName: "renamed.txt",
            mediaType: "text/plain",
            byteSize: 23,
          }),
        ),
      ),
    ).toBeNull();
    await drainIndexer();
  });

  it("retains published content during pending and failed replacements, including old citation reads", async () => {
    await configureEmbeddings({ spaceId: null, enabled: false });
    const owner = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.create(owner, { name: "Revisions", description: "" }),
      ),
    );
    const original = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.addNote(owner, {
          collectionId,
          title: "Original",
          content: "The original source.",
        }),
      ),
    );
    expect(
      (
        await run(
          Effect.flatMap(KnowledgeService, (service) => service.detail(owner, collectionId)),
        )
      ).documents[0],
    ).toMatchObject({ status: "queued", versionId: original.versionId, replacement: null });
    await drainIndexer();
    const replacement = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.replaceNote(owner, {
          collectionId,
          documentId: original.documentId,
          title: "Replacement",
          content: "The replacement source.",
        }),
      ),
    );
    const detail = () =>
      run(Effect.flatMap(KnowledgeService, (service) => service.detail(owner, collectionId)));
    expect((await detail()).documents[0]).toMatchObject({
      title: "Original",
      status: "ready",
      versionId: original.versionId,
      replacement: { versionId: replacement.versionId, title: "Replacement", status: "queued" },
    });
    expect(
      (
        await run(
          Effect.flatMap(KnowledgeService, (service) => service.manifest(owner, [collectionId])),
        )
      )[0],
    ).toMatchObject({ versionId: original.versionId, title: "Original" });
    await drainIndexer();
    expect((await detail()).documents[0]).toMatchObject({
      title: "Replacement",
      status: "ready",
      versionId: replacement.versionId,
      replacement: null,
    });
    expect(
      await run(
        Effect.flatMap(KnowledgeService, (service) =>
          service.read(owner, { collectionId, ...original, startOffset: 0, maxChars: 100 }),
        ),
      ),
    ).toMatchObject({ title: "Original", content: "The original source." });
    // Simulate a parser-stage failure after accepting a replacement.
    const failed = (await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.replaceNoteDocument(owner, {
          collectionId,
          documentId: original.documentId,
          title: "Failed",
          content: " ",
        }),
      ),
    ))!;
    await drainIndexer();
    expect((await detail()).documents[0]).toMatchObject({
      title: "Replacement",
      status: "ready",
      versionId: replacement.versionId,
      replacement: { versionId: failed.versionId, status: "failed" },
    });
    await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.removeDocument(owner, original.documentId),
      ),
    );
    expect(
      await run(
        Effect.flatMap(KnowledgeService, (service) =>
          Effect.flip(
            service.read(owner, { collectionId, ...original, startOffset: 0, maxChars: 100 }),
          ),
        ),
      ),
    ).toMatchObject({ _tag: "KnowledgeNotAvailable" });
  });

  it("does not let an older replacement finish over a newer published revision", async () => {
    await configureEmbeddings({ spaceId: null, enabled: false });
    await drainIndexer();
    const owner = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.create(owner, { name: "Publication order", description: "" }),
      ),
    );
    const original = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.addNote(owner, { collectionId, title: "Original", content: "First source." }),
      ),
    );
    await drainIndexer();
    const older = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.replaceNote(owner, {
          collectionId,
          documentId: original.documentId,
          title: "Older",
          content: "Older source.",
        }),
      ),
    );
    const olderClaim = (await run(
      Effect.flatMap(KnowledgeRepo, (repo) => repo.claimExtraction()),
    ))!;
    expect(olderClaim.version.id).toBe(older.versionId);
    const newer = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.replaceNote(owner, {
          collectionId,
          documentId: original.documentId,
          title: "Newer",
          content: "Newer source.",
        }),
      ),
    );
    await run(Effect.flatMap(KnowledgeIndexer, (indexer) => indexer.runExtraction()));
    expect(
      await run(
        Effect.flatMap(KnowledgeRepo, (repo) =>
          repo.completeExtraction({
            versionId: older.versionId,
            leaseToken: olderClaim.leaseToken,
            text: "Older source.",
            pageCount: null,
            truncated: { truncated: false, reason: null },
            chunks: chunkDocument("Older source."),
          }),
        ),
      ),
    ).toBe(true);
    expect(
      (
        await run(
          Effect.flatMap(KnowledgeService, (service) => service.detail(owner, collectionId)),
        )
      ).documents[0],
    ).toMatchObject({ title: "Newer", versionId: newer.versionId, replacement: null });
  });

  it("queues validated file versions before indexing and releases only the temporary attachment", async () => {
    await configureEmbeddings({ spaceId: uuidv7(), enabled: true, modelId: embeddingModelId });
    const owner = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.create(owner, { name: "Files", description: "" }),
      ),
    );
    const before = embedCalls;
    const upload = (content: string, documentId?: string) =>
      run(
        Effect.flatMap(KnowledgeService, (service) =>
          service.upload(owner, {
            collectionId,
            title: "Text file",
            fileName: "../source.md",
            declaredMediaType: "application/octet-stream",
            bytes: new TextEncoder().encode(content),
            ...(documentId ? { documentId } : {}),
          }),
        ),
      );
    const first = await upload("The first file source.");
    expect(embedCalls).toBe(before);
    expect(
      (
        await run(
          Effect.flatMap(KnowledgeService, (service) => service.detail(owner, collectionId)),
        )
      ).documents[0],
    ).toMatchObject({
      status: "queued",
      fileName: "source.md",
      mediaType: "text/plain",
      byteSize: 22,
    });
    expect(
      (await exec(`select count(*)::int as total from attachments where user_id = '${owner}'`))
        .rows[0],
    ).toEqual({ total: 0 });
    await drainIndexer();
    const second = await upload("The replacement file source.", first.documentId);
    await drainIndexer();
    expect(
      (
        await run(
          Effect.flatMap(KnowledgeService, (service) => service.detail(owner, collectionId)),
        )
      ).documents[0],
    ).toMatchObject({ versionId: second.versionId, replacement: null });
    const original = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.download(owner, { collectionId, ...first }),
      ),
    );
    expect(new TextDecoder().decode(original.bytes)).toBe("The first file source.");
    await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.removeDocument(owner, first.documentId),
      ),
    );
    expect(
      (await exec(`select count(*)::int as total from attachment_blobs where user_id = '${owner}'`))
        .rows[0],
    ).toEqual({ total: 0 });
    expect(
      await run(
        Effect.flatMap(KnowledgeService, (service) =>
          Effect.flip(service.download(owner, { collectionId, ...first })),
        ),
      ),
    ).toMatchObject({ _tag: "KnowledgeNotAvailable" });
  });

  it("cleans a failed upload registration without disturbing another resource's blob", async () => {
    const owner = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.create(owner, { name: "Full", description: "" }),
      ),
    );
    await exec(
      `insert into knowledge_documents (id, collection_id, title, kind) select '${collectionId}-' || n, '${collectionId}', 'Fixture', 'note' from generate_series(1, 500) n`,
    );
    const before = blobs.size;
    expect(
      await run(
        Effect.flatMap(KnowledgeService, (service) =>
          Effect.flip(
            service.upload(owner, {
              collectionId,
              title: "Overflow",
              fileName: "source.txt",
              declaredMediaType: "text/plain",
              bytes: new TextEncoder().encode("Unique unregistered file."),
            }),
          ),
        ),
      ),
    ).toMatchObject({ _tag: "KnowledgeRejected" });
    expect(blobs.size).toBe(before);
    expect(
      (await exec(`select count(*)::int as total from attachment_blobs where user_id = '${owner}'`))
        .rows[0],
    ).toEqual({ total: 0 });
  });

  it("cascades user deletion through attachments and retained knowledge versions", async () => {
    const owner = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.create(owner, { name: "Owner lifecycle", description: "" }),
      ),
    );
    const file = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.upload(owner, {
          collectionId,
          title: "Source",
          fileName: "source.txt",
          declaredMediaType: "text/plain",
          bytes: new TextEncoder().encode("Owned source."),
        }),
      ),
    );
    await drainIndexer();
    const direct = await run(
      Effect.flatMap(Db, (db) =>
        Effect.result(
          db.execute(`delete from attachment_blobs where user_id = '${owner}'` as never),
        ),
      ),
    );
    expect(direct._tag).toBe("Failure");
    await exec(`delete from "user" where id = '${owner}'`);
    expect(
      (
        await exec(
          `select count(*)::int as total from knowledge_document_versions where document_id = '${file.documentId}'`,
        )
      ).rows[0],
    ).toEqual({ total: 0 });
    expect(
      (await exec(`select count(*)::int as total from attachment_blobs where user_id = '${owner}'`))
        .rows[0],
    ).toEqual({ total: 0 });
  });

  it("retries only the latest failed extraction without replacing published content", async () => {
    await configureEmbeddings({ spaceId: null, enabled: false });
    const owner = await createUser();
    const recipient = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.create(owner, { name: "Retry", description: "" }),
      ),
    );
    const original = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.addNote(owner, { collectionId, title: "Original", content: "Published source." }),
      ),
    );
    await drainIndexer();
    await run(grantFixture(collectionId, recipient));
    expect(
      await run(
        Effect.flatMap(KnowledgeService, (service) =>
          Effect.flip(service.retryDocument(recipient, original.documentId)),
        ),
      ),
    ).toMatchObject({ _tag: "KnowledgeNotAvailable" });
    expect(
      await run(
        Effect.flatMap(KnowledgeService, (service) =>
          Effect.flip(service.retryDocument(owner, original.documentId)),
        ),
      ),
    ).toMatchObject({ _tag: "KnowledgeRejected" });
    const replacement = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.replaceNote(owner, {
          collectionId,
          documentId: original.documentId,
          title: "Replacement",
          content: "Replacement source.",
        }),
      ),
    );
    const claim = (await run(Effect.flatMap(KnowledgeRepo, (repo) => repo.claimExtraction())))!;
    expect(claim.version.id).toBe(replacement.versionId);
    await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.failExtraction({
          versionId: replacement.versionId,
          leaseToken: claim.leaseToken,
          error: "temporary extraction failure",
          retryable: false,
        }),
      ),
    );
    await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.retryDocument(owner, original.documentId),
      ),
    );
    expect(
      (
        await run(
          Effect.flatMap(KnowledgeService, (service) => service.detail(owner, collectionId)),
        )
      ).documents[0],
    ).toMatchObject({
      versionId: original.versionId,
      replacement: { status: "queued", error: null },
    });
    expect(
      await run(
        Effect.flatMap(KnowledgeService, (service) =>
          Effect.flip(service.retryDocument(owner, original.documentId)),
        ),
      ),
    ).toMatchObject({ _tag: "KnowledgeRejected" });
    await drainIndexer();
    expect(
      (
        await run(
          Effect.flatMap(KnowledgeService, (service) => service.detail(owner, collectionId)),
        )
      ).documents[0],
    ).toMatchObject({ versionId: replacement.versionId, replacement: null });
  });

  it("rejects partially inaccessible selections, but accepts an accessible empty collection", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const own = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.create(owner, { name: "Empty", description: "" }),
      ),
    );
    const other = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.create(stranger, { name: "Hidden", description: "" }),
      ),
    );
    expect(
      await run(Effect.flatMap(KnowledgeService, (service) => service.manifest(owner, [own]))),
    ).toEqual([]);
    for (const id of [other, uuidv7()])
      expect(
        await run(
          Effect.flatMap(KnowledgeService, (service) =>
            Effect.flip(service.manifest(owner, [own, id])),
          ),
        ),
      ).toMatchObject({ _tag: "KnowledgeNotAvailable", resourceId: id });
    expect(
      await run(
        Effect.flatMap(KnowledgeService, (service) =>
          Effect.flip(
            service.manifest(
              owner,
              Array.from({ length: 6 }, () => uuidv7()),
            ),
          ),
        ),
      ),
    ).toMatchObject({ _tag: "KnowledgeRejected" });
  });

  it("enforces the collection limit under concurrent creates", async () => {
    const owner = await createUser();
    await exec(
      `insert into knowledge_collections (id, user_id, name) select '${owner}-' || n, '${owner}', 'Fixture' from generate_series(1, 99) n`,
    );
    const outcomes = await Promise.all(
      Array.from({ length: 4 }, () =>
        run(
          Effect.flatMap(KnowledgeService, (service) =>
            Effect.result(service.create(owner, { name: "Last slot", description: "" })),
          ),
        ),
      ),
    );
    expect(outcomes.filter((result) => result._tag === "Success")).toHaveLength(1);
    expect(outcomes.filter((result) => result._tag === "Failure")).toHaveLength(3);
    expect(
      await run(Effect.flatMap(KnowledgeService, (service) => service.list(owner))),
    ).toHaveLength(100);
  });

  it("rechecks download permission after blob storage returns", async () => {
    const owner = await createUser();
    const recipient = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.create(owner, { name: "Download", description: "" }),
      ),
    );
    const upload = await run(
      Effect.flatMap(AttachmentRepo, (repo) =>
        repo.create({
          userId: owner,
          sha256: uuidv7(),
          storageKey: uuidv7(),
          fileName: "source.txt",
          size: 4,
          mediaType: "text/plain",
        }),
      ),
    );
    const stored = (await run(
      Effect.flatMap(AttachmentRepo, (repo) => repo.findForAccess(upload.attachment.id)),
    ))!;
    blobs.set(stored.attachment.storageKey, new TextEncoder().encode("body"));
    const document = (await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.addFileDocument(owner, {
          collectionId,
          title: "Source",
          blobId: stored.attachment.blobId,
          fileName: "source.txt",
          mediaType: "text/plain",
          byteSize: 4,
        }),
      ),
    ))!;
    const reference = { collectionId, ...document };
    await run(grantFixture(collectionId, recipient));
    expect(
      (
        await run(
          Effect.flatMap(KnowledgeService, (service) => service.download(recipient, reference)),
        )
      ).bytes,
    ).toEqual(new TextEncoder().encode("body"));
    onBlobRead = () => run(revokeFixture(collectionId, recipient));
    try {
      expect(
        await run(
          Effect.flatMap(KnowledgeService, (service) =>
            Effect.flip(service.download(recipient, reference)),
          ),
        ),
      ).toMatchObject({ _tag: "KnowledgeNotAvailable" });
    } finally {
      onBlobRead = null;
    }
    await run(Effect.flatMap(KnowledgeService, (service) => service.remove(owner, collectionId)));
    expect(
      await run(Effect.flatMap(AttachmentRepo, (repo) => repo.findForAccess(upload.attachment.id))),
    ).not.toBeNull();
  });
});

describe("knowledge ingestion", () => {
  it("keeps validated text classification when an opaque resource stored the bytes first", async () => {
    const owner = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.createCollection(owner, { name: "Classification", description: "" }),
      ),
    );
    const bytes = new TextEncoder().encode(
      "A document may share bytes without sharing its file classification.",
    );
    const sha256 = uuidv7();
    const storageKey = uuidv7();
    blobs.set(storageKey, bytes);
    const opaque = await run(
      Effect.flatMap(AttachmentRepo, (repo) =>
        repo.create({
          userId: owner,
          sha256,
          storageKey,
          size: bytes.length,
          fileName: "export.bin",
          mediaType: "application/octet-stream",
        }),
      ),
    );
    const text = await run(
      Effect.flatMap(AttachmentRepo, (repo) =>
        repo.create({
          userId: owner,
          sha256,
          storageKey: uuidv7(),
          size: bytes.length,
          fileName: "export.txt",
          mediaType: "text/plain",
        }),
      ),
    );
    const textFile = (await run(
      Effect.flatMap(AttachmentRepo, (repo) => repo.findForAccess(text.attachment.id)),
    ))!;
    const opaqueFile = (await run(
      Effect.flatMap(AttachmentRepo, (repo) => repo.findForAccess(opaque.attachment.id)),
    ))!;
    expect(textFile.attachment.blobId).toBe(opaqueFile.attachment.blobId);
    expect(text.attachment.mediaType).toBe("text/plain");
    const published = (await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.addFileDocument(owner, {
          collectionId,
          title: "Export",
          blobId: textFile.attachment.blobId,
          fileName: "export.txt",
          mediaType: text.attachment.mediaType,
          byteSize: 1,
        }),
      ),
    ))!;
    const stored = await exec(
      `select media_type, byte_size from knowledge_document_versions where id = '${published.versionId}'`,
    );
    expect(stored.rows[0]).toEqual({ media_type: "text/plain", byte_size: bytes.length });
    await drainIndexer();
    const ready = await exec(
      `select status, text from knowledge_document_versions where id = '${published.versionId}'`,
    );
    expect(ready.rows[0]).toEqual({ status: "ready", text: new TextDecoder().decode(bytes) });
    const accessed = await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.readVersionForAccess(owner, { collectionId, ...published }),
      ),
    );
    expect(accessed).toMatchObject({
      status: "ready",
      fileName: "export.txt",
      mediaType: "text/plain",
      storageKey,
    });
    const blob = await exec(
      `select media_type from attachment_blobs where id = '${textFile.attachment.blobId}'`,
    );
    expect(blob.rows[0]).toEqual({ media_type: "application/octet-stream" });
  });

  it("extracts a note in the background and reports what could not be indexed", async () => {
    const owner = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.createCollection(owner, { name: "Mixed", description: "" }),
      ),
    );
    await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.addNoteDocument(owner, {
          collectionId,
          title: "Terms",
          content: "# Terms\n\nEither party may terminate with thirty days notice.",
        }),
      ),
    );

    // Adding a document returns before anything is parsed.
    const queued = await run(
      Effect.flatMap(KnowledgeRepo, (repo) => repo.listDocuments(owner, collectionId, null)),
    );
    expect(queued[0]).toMatchObject({ status: "queued", semanticStatus: "queued" });

    const blobId = uuidv7();
    blobs.set(`blobs/${owner}/de/ad/deadbeef`, new Uint8Array(10));
    await exec(
      `insert into attachment_blobs (id, user_id, sha256, storage_key, size, media_type)
       values ('${blobId}', '${owner}', 'deadbeef', 'blobs/${owner}/de/ad/deadbeef', 10, 'image/png')`,
    );
    await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.addFileDocument(owner, {
          collectionId,
          blobId,
          title: "Diagram",
          fileName: "diagram.png",
          mediaType: "image/png",
          byteSize: 10,
        }),
      ),
    );

    await drainIndexer();
    const documents = await run(
      Effect.flatMap(KnowledgeRepo, (repo) => repo.listDocuments(owner, collectionId, null)),
    );
    const byTitle = new Map(documents.map((document) => [document.title, document]));
    expect(byTitle.get("Terms")).toMatchObject({ status: "ready", truncated: false });
    // An unindexable file is reported, never silently treated as empty.
    expect(byTitle.get("Diagram")).toMatchObject({ status: "failed" });
    expect(byTitle.get("Diagram")!.error).toContain("image/png");
    // With no embedding model configured the documents are still usable.
    expect(byTitle.get("Terms")!.semanticStatus).toBe("disabled");
    // The collection list counts the failure too, as the collection page does.
    const listed = await run(Effect.flatMap(KnowledgeRepo, (repo) => repo.listCollections(owner)));
    expect(listed.find((collection) => collection.id === collectionId)).toMatchObject({
      readyCount: 1,
      failedCount: 1,
      pendingCount: 0,
    });
  });

  it("keeps a collection's bytes when the same upload is deleted from a chat", async () => {
    const owner = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.createCollection(owner, { name: "Shared bytes", description: "" }),
      ),
    );
    const blobId = uuidv7();
    const storageKey = `blobs/${owner}/aa/bb/${"c".repeat(64)}`;
    await exec(
      `insert into attachment_blobs (id, user_id, sha256, storage_key, size, media_type)
       values ('${blobId}', '${owner}', '${"c".repeat(64)}', '${storageKey}', 4, 'text/plain')`,
    );
    const attachmentId = uuidv7();
    await exec(
      `insert into attachments (id, user_id, blob_id, file_name, media_type)
       values ('${attachmentId}', '${owner}', '${blobId}', 'terms.txt', 'text/plain')`,
    );
    await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.addFileDocument(owner, {
          collectionId,
          blobId,
          title: "Terms",
          fileName: "terms.txt",
          mediaType: "text/plain",
          byteSize: 4,
        }),
      ),
    );

    // Removing the chat attachment must not take the collection's copy with it.
    const removed = await run(
      Effect.flatMap(AttachmentRepo, (repo) => repo.deleteUnclaimed(owner, attachmentId)),
    );
    expect(removed).toEqual([]);
    const remaining = await run(
      Effect.flatMap(Db, (db) =>
        db.execute(
          `select count(*)::int as total from attachment_blobs where id = '${blobId}'` as never,
        ),
      ),
    );
    expect((remaining as { rows: ReadonlyArray<{ total: number }> }).rows[0]!.total).toBe(1);

    // Deleting the document is the last reference, so now the bytes go.
    const documents = await run(
      Effect.flatMap(KnowledgeRepo, (repo) => repo.listDocuments(owner, collectionId, null)),
    );
    const keys = await run(
      Effect.flatMap(KnowledgeRepo, (repo) => repo.deleteDocument(owner, documents[0]!.id)),
    );
    expect(keys).toEqual([storageKey]);
  });
});

describe("knowledge ingestion safety", () => {
  it("fails empty and over-limit notes without publishing partial chunks", async () => {
    await configureEmbeddings({ spaceId: null, enabled: false });
    const owner = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.createCollection(owner, { name: "Limits", description: "" }),
      ),
    );
    for (const [title, content] of [
      ["Empty", "  \n\n"],
      ["Too large", "x".repeat(200_001)],
    ]) {
      await run(
        Effect.flatMap(KnowledgeRepo, (repo) =>
          repo.addNoteDocument(owner, { collectionId, title: title!, content: content! }),
        ),
      );
    }
    await drainIndexer();
    const docs = await run(
      Effect.flatMap(KnowledgeRepo, (repo) => repo.listDocuments(owner, collectionId, null)),
    );
    expect(docs).toHaveLength(2);
    expect(docs.every((doc) => doc.status === "failed")).toBe(true);
    const indexed =
      await exec(`select count(*)::int as total from knowledge_chunks c join knowledge_document_versions v on v.id = c.version_id
      join knowledge_documents d on d.id = v.document_id where d.collection_id = '${collectionId}'`);
    expect(indexed.rows[0]).toEqual({ total: 0 });
  });

  it("publishes content-free indexing transitions and stays silent when idle", async () => {
    await configureEmbeddings({ spaceId: null, enabled: false });
    await drainIndexer();
    const owner = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.createCollection(owner, { name: "Private indexing", description: "" }),
      ),
    );
    await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.addNoteDocument(owner, {
          collectionId,
          title: "Private title",
          content: "Private evidence.",
        }),
      ),
    );
    const before = events.length;
    await drainIndexer();
    expect(events.slice(before)).toEqual([
      { type: "knowledge.index.changed" },
      { type: "knowledge.index.changed" },
    ]);
    await drainIndexer();
    expect(events.length).toBe(before + 2);
  });

  it("counts heading text when splitting embedding batches", async () => {
    await configureEmbeddings({
      spaceId: "large-batches",
      enabled: true,
      modelId: embeddingModelId,
    });
    await drainIndexer();
    const owner = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.createCollection(owner, { name: "Long heading", description: "" }),
      ),
    );
    await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.addNoteDocument(owner, {
          collectionId,
          title: "Large document",
          content:
            "# " +
            "Heading ".repeat(1000) +
            "\n\n" +
            "A contractual invoice paragraph. ".repeat(4000),
        }),
      ),
    );
    const batches: number[][] = [];
    onEmbed = async (inputs) => {
      batches.push(inputs.map((text) => text.length));
    };
    try {
      await drainIndexer();
    } finally {
      onEmbed = null;
    }
    expect(batches.length).toBeGreaterThan(1);
    expect(
      batches.every(
        (batch) => batch.length <= 32 && batch.reduce((total, size) => total + size, 0) <= 160_000,
      ),
    ).toBe(true);
    expect(
      (
        await run(
          Effect.flatMap(KnowledgeService, (service) => service.detail(owner, collectionId)),
        )
      ).documents[0]!.semanticStatus,
    ).toBe("ready");
  });

  it("hands back the attempt on a rate limit and delays other provider trouble", async () => {
    await configureEmbeddings({ spaceId: "backoff", enabled: true, modelId: embeddingModelId });
    await drainIndexer();
    const owner = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.createCollection(owner, { name: "Backoff", description: "" }),
      ),
    );
    const note = await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.addNoteDocument(owner, {
          collectionId,
          title: "Holidays",
          content: "Twenty-five days a year.",
        }),
      ),
    );
    const job = async () =>
      (
        await exec(
          `select status, attempts, not_before > now() as delayed from knowledge_embedding_jobs where version_id = '${note!.versionId}'`,
        )
      ).rows[0];

    // Retry-After of zero keeps the in-memory pause from outliving this test.
    embedFailure = new ProviderUnreachable({
      providerId: "fake",
      message: "the embedding provider is rate limiting requests",
      diagnostic: { kind: "RateLimitError", status: 429, retryAfterMs: 0 },
    });
    try {
      await run(
        Effect.gen(function* () {
          const indexer = yield* KnowledgeIndexer;
          for (let step = 0; step < 50; step++) if (!(yield* indexer.runExtraction())) break;
          yield* indexer.runEmbedding();
        }),
      );
      // Queued again with no attempt spent: the page was fine, the key was busy.
      expect(await job()).toMatchObject({ status: "queued", attempts: 0 });

      embedFailure = new ProviderUnreachable({
        providerId: "fake",
        message: "the embedding provider answered 503",
        diagnostic: { kind: "InternalProviderError", status: 503 },
      });
      await run(Effect.flatMap(KnowledgeIndexer, (indexer) => indexer.runEmbedding()));
      // Counted, and not claimable until its backoff has passed.
      expect(await job()).toMatchObject({ status: "queued", attempts: 1, delayed: true });
      embedFailure = null;
      const calls = embedCalls;
      await drainIndexer();
      expect(embedCalls).toBe(calls);
    } finally {
      embedFailure = null;
    }
  });

  it("sends one input at a time to a route that refuses arrays, and finishes the page", async () => {
    await configureEmbeddings({
      spaceId: "single-input",
      enabled: true,
      modelId: embeddingModelId,
    });
    await drainIndexer();
    const owner = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.createCollection(owner, { name: "Handbook", description: "" }),
      ),
    );
    const paragraph = "Invoice payments are due monthly and travel is booked ahead. ";
    await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.addNoteDocument(owner, {
          collectionId,
          title: "Long page",
          content: Array.from(
            { length: 12 },
            (_, i) => `## Part ${i}\n\n${paragraph.repeat(40)}`,
          ).join("\n\n"),
        }),
      ),
    );
    refuseArrays = true;
    batchSizes = [];
    try {
      await drainIndexer();
    } finally {
      refuseArrays = false;
    }
    const [document] = (
      await run(Effect.flatMap(KnowledgeService, (service) => service.detail(owner, collectionId)))
    ).documents;
    expect(document).toMatchObject({ status: "ready", semanticStatus: "ready" });
    // One refused batch, then every chunk alone: no attempt spent, nothing skipped.
    const chunks = Number(
      (
        await exec(
          `select count(*) as n from knowledge_chunks where version_id = '${document!.versionId}'`,
        )
      ).rows[0]!.n,
    );
    expect(chunks).toBeGreaterThan(1);
    expect(batchSizes[0]).toBeGreaterThan(1);
    expect(batchSizes.slice(1)).toEqual(Array.from({ length: chunks }, () => 1));
  });

  it("does not retry deterministic embedding input rejections or lose lexical readiness", async () => {
    await configureEmbeddings({
      spaceId: "rejected-input",
      enabled: true,
      modelId: embeddingModelId,
    });
    await drainIndexer();
    const owner = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.createCollection(owner, { name: "Small model", description: "" }),
      ),
    );
    await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.addNoteDocument(owner, {
          collectionId,
          title: "Invoice",
          content: "Invoice payments are due monthly.",
        }),
      ),
    );
    embedFailure = new ProviderUnreachable({
      providerId: "fake",
      message: "embedding input exceeds the model context budget",
      diagnostic: { kind: "InvalidRequestError" },
    });
    const calls = embedCalls;
    try {
      await drainIndexer();
    } finally {
      embedFailure = null;
    }
    expect(embedCalls).toBe(calls + 1);
    expect(
      (
        await run(
          Effect.flatMap(KnowledgeService, (service) => service.detail(owner, collectionId)),
        )
      ).documents[0],
    ).toMatchObject({ status: "ready", semanticStatus: "failed" });
  });

  it.each(["ready", "failed"] as const)(
    "publishes an older extraction only when a newer version is not ready (%s)",
    async (newerStatus) => {
      await configureEmbeddings({ spaceId: null, enabled: false });
      await drainIndexer();
      const owner = await createUser();
      const collectionId = await run(
        Effect.flatMap(KnowledgeService, (service) =>
          service.create(owner, { name: "Publication race", description: "" }),
        ),
      );
      const older = await run(
        Effect.flatMap(KnowledgeService, (service) =>
          service.addNote(owner, {
            collectionId,
            title: "Older",
            content: "Older successful source.",
          }),
        ),
      );
      const olderClaim = (await run(
        Effect.flatMap(KnowledgeRepo, (repo) => repo.claimExtraction()),
      ))!;
      const newer = await run(
        Effect.flatMap(KnowledgeService, (service) =>
          service.replaceNote(owner, {
            collectionId,
            documentId: older.documentId,
            title: "Newer",
            content: "Newer source.",
          }),
        ),
      );
      const newerClaim = (await run(
        Effect.flatMap(KnowledgeRepo, (repo) => repo.claimExtraction()),
      ))!;
      const complete = (versionId: string, leaseToken: string, text: string) =>
        run(
          Effect.flatMap(KnowledgeRepo, (repo) =>
            repo.completeExtraction({
              versionId,
              leaseToken,
              text,
              pageCount: null,
              truncated: { truncated: false, reason: null },
              chunks: chunkDocument(text),
            }),
          ),
        );
      if (newerStatus === "ready")
        expect(await complete(newer.versionId, newerClaim.leaseToken, "Newer source.")).toBe(true);
      else
        await run(
          Effect.flatMap(KnowledgeRepo, (repo) =>
            repo.failExtraction({
              versionId: newer.versionId,
              leaseToken: newerClaim.leaseToken,
              error: "failed replacement",
              retryable: false,
            }),
          ),
        );
      expect(
        await complete(older.versionId, olderClaim.leaseToken, "Older successful source."),
      ).toBe(true);
      const document = (
        await run(
          Effect.flatMap(KnowledgeService, (service) => service.detail(owner, collectionId)),
        )
      ).documents[0]!;
      expect(document.versionId).toBe(newerStatus === "ready" ? newer.versionId : older.versionId);
      if (newerStatus === "failed")
        expect(document.replacement).toMatchObject({ status: "failed" });
    },
  );

  it("rejects expired extraction publication and records the pipeline fingerprint on a fresh claim", async () => {
    await configureEmbeddings({ spaceId: null, enabled: false });
    await drainIndexer();
    const owner = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.createCollection(owner, { name: "Lease", description: "" }),
      ),
    );
    const content = "# Stable title\n\nUnique source body.";
    const created = await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.addNoteDocument(owner, { collectionId, title: "Stable title", content }),
      ),
    );
    const first = await run(Effect.flatMap(KnowledgeRepo, (repo) => repo.claimExtraction()));
    expect(first?.version.id).toBe(created!.versionId);
    await exec(
      `update knowledge_document_versions set lease_until = now() - interval '1 second' where id = '${created!.versionId}'`,
    );
    const complete = (leaseToken: string) =>
      run(
        Effect.flatMap(KnowledgeRepo, (repo) =>
          repo.completeExtraction({
            versionId: created!.versionId,
            leaseToken,
            text: content,
            pageCount: null,
            truncated: { truncated: false, reason: null },
            chunks: chunkDocument(content),
          }),
        ),
      );
    expect(await complete(first!.leaseToken)).toBe(false);
    const second = await run(Effect.flatMap(KnowledgeRepo, (repo) => repo.claimExtraction()));
    expect(second!.leaseToken).not.toBe(first!.leaseToken);
    expect(await complete(first!.leaseToken)).toBe(false);
    expect(await complete(second!.leaseToken)).toBe(true);
    const version = await exec(
      `select status, title, pipeline_fingerprint from knowledge_document_versions where id = '${created!.versionId}'`,
    );
    expect(version.rows[0]).toEqual({
      status: "ready",
      title: "Stable title",
      pipeline_fingerprint: pipelineFingerprint(null),
    });
  });

  it.each(["expired", "missing", "queued"] as const)(
    "terminalizes exhausted %s extraction and embedding claims",
    async (state) => {
      await configureEmbeddings({ spaceId: uuidv7(), enabled: true, modelId: embeddingModelId });
      await drainIndexer();
      const owner = await createUser();
      const collectionId = await run(
        Effect.flatMap(KnowledgeRepo, (repo) =>
          repo.createCollection(owner, { name: "Exhaustion", description: "" }),
        ),
      );
      const failed = await run(
        Effect.flatMap(KnowledgeRepo, (repo) =>
          repo.addNoteDocument(owner, {
            collectionId,
            title: "Unfinished",
            content: "An interrupted extraction.",
          }),
        ),
      );
      const indexed = await run(
        Effect.flatMap(KnowledgeRepo, (repo) =>
          repo.addNoteDocument(owner, {
            collectionId,
            title: "Extracted",
            content: "An interrupted embedding.",
          }),
        ),
      );
      const lease = state === "expired" ? "now() - interval '1 second'" : "null";
      await exec(
        `update knowledge_document_versions set status = '${state === "queued" ? "queued" : "extracting"}', attempts = 3, lease_until = ${lease} where id = '${failed!.versionId}'`,
      );
      // Only extraction runs here: the second job must remain unembedded.
      await run(Effect.flatMap(KnowledgeIndexer, (indexer) => indexer.runExtraction()));
      await exec(
        `update knowledge_embedding_jobs set status = '${state === "queued" ? "queued" : "running"}', attempts = 3, lease_until = ${lease} where version_id = '${indexed!.versionId}'`,
      );
      // Recovery is independent of semantic availability, including exhausted
      // jobs left behind while the admin disables their connection.
      await configureEmbeddings({ spaceId: null, enabled: false });
      const before = embedCalls;
      const eventCount = events.length;
      expect(await run(Effect.flatMap(KnowledgeIndexer, (indexer) => indexer.runEmbedding()))).toBe(
        false,
      );
      expect(events.slice(eventCount)).toEqual([]);
      await run(Effect.flatMap(KnowledgeIndexer, (indexer) => indexer.recoverExpiredJobs()));
      expect(events.slice(eventCount)).toEqual([{ type: "knowledge.index.changed" }]);
      await drainIndexer();
      expect(events.length).toBe(eventCount + 1);
      expect(embedCalls).toBe(before);
      const versions = await exec(
        `select status, error from knowledge_document_versions where id = '${failed!.versionId}'`,
      );
      expect(versions.rows[0]).toMatchObject({
        status: "failed",
        error: expect.stringContaining("three attempts"),
      });
      const jobs = await exec(
        `select status, error from knowledge_embedding_jobs where version_id = '${indexed!.versionId}'`,
      );
      expect(jobs.rows[0]).toMatchObject({
        status: "failed",
        error: expect.stringContaining("three attempts"),
      });
    },
  );

  it("publishes only a complete vector set under a live embedding lease", async () => {
    await configureEmbeddings({ spaceId: uuidv7(), enabled: true, modelId: embeddingModelId });
    await drainIndexer();
    const owner = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.createCollection(owner, { name: "Vector publication", description: "" }),
      ),
    );
    const document = await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.addNoteDocument(owner, {
          collectionId,
          title: "Long note",
          content: "The contract requires payment. ".repeat(3500),
        }),
      ),
    );
    await run(Effect.flatMap(KnowledgeIndexer, (indexer) => indexer.runExtraction()));
    const target = (await run(Effect.flatMap(EmbeddingSpace, (space) => space.current())))!;
    const claim = (await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.claimEmbedding(target.spaceId, target.connectionRevision),
      ),
    ))!;
    expect(claim.versionId).toBe(document!.versionId);
    const chunks = await run(
      Effect.flatMap(KnowledgeRepo, (repo) => repo.listChunksForEmbedding(claim.versionId)),
    );
    expect(chunks.length).toBeGreaterThan(32);
    const vectors = chunks.map((chunk) => ({
      chunkId: chunk.id,
      embedding: fakeEmbed(chunk.content),
    }));
    const complete = (token: string, values = vectors) =>
      run(
        Effect.flatMap(KnowledgeRepo, (repo) =>
          repo.completeEmbedding({
            versionId: claim.versionId,
            leaseToken: token,
            spaceId: target.spaceId,
            connectionRevision: target.connectionRevision,
            dimensions: target.dimensions,
            vectors: values,
          }),
        ),
      );
    for (const invalid of [
      [],
      vectors.slice(1),
      vectors.map(() => vectors[0]!),
      vectors.map((v) => ({ ...v, chunkId: uuidv7() })),
      vectors.map((v) => ({ ...v, embedding: [1] })),
      vectors.map((v) => ({ ...v, embedding: Array(DIMENSIONS).fill(0) })),
    ]) {
      expect(await complete(claim.leaseToken, invalid)).toBe(false);
    }
    await exec(
      `update knowledge_embedding_jobs set lease_until = now() - interval '1 second' where version_id = '${claim.versionId}'`,
    );
    expect(await complete(claim.leaseToken)).toBe(false);
    await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.failEmbedding({ ...claim, error: "stale failure", retryable: false }),
      ),
    );
    expect(
      (
        await exec(
          `select status from knowledge_embedding_jobs where version_id = '${claim.versionId}'`,
        )
      ).rows[0],
    ).toEqual({ status: "running" });
    const renewed = (await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.claimEmbedding(target.spaceId, target.connectionRevision),
      ),
    ))!;
    expect(await complete(claim.leaseToken)).toBe(false);
    expect(await complete(renewed.leaseToken)).toBe(true);
    expect(await complete(renewed.leaseToken)).toBe(false);
    expect(
      (
        await exec(
          `select count(*)::int as total from knowledge_chunk_embeddings where version_id = '${claim.versionId}'`,
        )
      ).rows[0],
    ).toEqual({ total: chunks.length });
    await run(Effect.flatMap(KnowledgeRepo, (repo) => repo.reindexCollection(owner, collectionId)));
    const replacementClaim = (await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.claimEmbedding(target.spaceId, target.connectionRevision),
      ),
    ))!;
    const replacements = vectors.map((vector, index) => ({
      ...vector,
      embedding: [index + 1, 1, 0, 1],
    }));
    expect(await complete(replacementClaim.leaseToken, replacements)).toBe(true);
    const stored = await exec(
      `select chunk_id, embedding::text as embedding from knowledge_chunk_embeddings where version_id = '${claim.versionId}'`,
    );
    const byId = new Map(
      stored.rows.map((row) => [row.chunk_id, JSON.parse(row.embedding as string)]),
    );
    for (const vector of replacements) expect(byId.get(vector.chunkId)).toEqual(vector.embedding);
  });

  it("fails a malformed ready version without chunks instead of leaving its embedding job running", async () => {
    await configureEmbeddings({ spaceId: uuidv7(), enabled: true, modelId: embeddingModelId });
    await drainIndexer();
    const owner = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.createCollection(owner, { name: "Missing chunks", description: "" }),
      ),
    );
    const document = await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.addNoteDocument(owner, {
          collectionId,
          title: "Malformed",
          content: "A valid note before corruption.",
        }),
      ),
    );
    await run(Effect.flatMap(KnowledgeIndexer, (indexer) => indexer.runExtraction()));
    await exec(`delete from knowledge_chunks where version_id = '${document!.versionId}'`);
    const before = embedCalls;
    expect(await run(Effect.flatMap(KnowledgeIndexer, (indexer) => indexer.runEmbedding()))).toBe(
      true,
    );
    expect(embedCalls).toBe(before);
    expect(
      (
        await exec(
          `select status, error from knowledge_embedding_jobs where version_id = '${document!.versionId}'`,
        )
      ).rows[0],
    ).toEqual({ status: "failed", error: expect.stringContaining("no extracted chunks") });
  });

  it("serializes collection-reference creation with the final attachment deletion", async () => {
    await configureEmbeddings({ spaceId: null, enabled: false });
    const owner = await createUser();
    const foreign = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.createCollection(owner, { name: "Races", description: "" }),
      ),
    );
    const foreignCollection = await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.createCollection(foreign, { name: "Other", description: "" }),
      ),
    );
    for (let iteration = 0; iteration < 6; iteration++) {
      const attachment = await run(
        Effect.flatMap(AttachmentRepo, (repo) =>
          repo.create({
            userId: owner,
            sha256: uuidv7(),
            storageKey: `race-${uuidv7()}`,
            size: 4,
            mediaType: "text/plain",
            fileName: "race.txt",
          }),
        ),
      );
      const found = await run(
        Effect.flatMap(AttachmentRepo, (repo) => repo.findForAccess(attachment.attachment.id)),
      );
      const input = {
        collectionId,
        blobId: found!.attachment.blobId,
        title: "Race",
        fileName: "race.txt",
        mediaType: "text/plain",
        byteSize: 4,
      };
      expect(
        await run(
          Effect.flatMap(KnowledgeRepo, (repo) =>
            repo.addFileDocument(foreign, { ...input, collectionId: foreignCollection }),
          ),
        ),
      ).toBeNull();
      const [document, keys] = await Promise.all([
        run(Effect.flatMap(KnowledgeRepo, (repo) => repo.addFileDocument(owner, input))),
        run(
          Effect.flatMap(AttachmentRepo, (repo) =>
            repo.deleteUnclaimed(owner, attachment.attachment.id),
          ),
        ),
      ]);
      if (document) {
        expect(keys).toEqual([]);
        const lastKeys = await run(
          Effect.flatMap(KnowledgeRepo, (repo) => repo.deleteDocument(owner, document.documentId)),
        );
        expect(lastKeys).toEqual([found!.attachment.storageKey]);
      } else {
        expect(keys).toEqual([found!.attachment.storageKey]);
      }
    }
  });
});

describe("knowledge search", () => {
  const seed = async () => {
    const owner = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.createCollection(owner, { name: "Agreements", description: "" }),
      ),
    );
    await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.addNoteDocument(owner, {
          collectionId,
          title: "Vendor agreement",
          content:
            "# Vendor agreement\n\n## Termination\n\nEither party may terminate this agreement with thirty days written notice.\n\n## Invoices\n\nThe supplier issues an invoice every month and payment is due in fourteen days.",
        }),
      ),
    );
    return { owner, collectionId };
  };

  const versionIds = async (owner: string, collectionId: string) => {
    const manifest = await run(
      Effect.flatMap(KnowledgeRepo, (repo) => repo.resolveManifest(owner, [collectionId])),
    );
    return manifest.flatMap((entry) => (entry.versionId ? [entry.versionId] : []));
  };

  it("finds an exact phrase without any embedding model configured", async () => {
    await configureEmbeddings({ spaceId: null, enabled: false });
    const { owner, collectionId } = await seed();
    await drainIndexer();

    const versions = await versionIds(owner, collectionId);
    const result = await run(
      Effect.flatMap(KnowledgeSearch, (search) =>
        search.search({
          userId: owner,
          versionIds: versions,
          query: "thirty days written notice",
          limit: 3,
        }),
      ),
    );
    expect(result.mode).toBe("lexical");
    expect(result.passages[0]!.content).toContain("thirty days");
    expect(result.passages[0]!.headingPath).toBe("Vendor agreement");
    expect(result.passages[0]!.content).toContain("## Termination");
  });

  it("stores and searches vectors wider than any pgvector index allows, and refuses a mismatched width", async () => {
    // pgvector's HNSW/IVFFlat indexes stop at 2,000 dimensions; storage goes to
    // 16,000. This release scans exactly with no index and no fixed column width,
    // so a 4,096-dimension model (qwen3-embedding-8b class) has to work as-is.
    // Pin that here: adding an ANN index later must not silently break it.
    const WIDE = 4096;
    // Width on the model row first, then approve: `configureEmbeddings` snapshots
    // the connection, and an edit after approval is (correctly) a pause.
    await exec(`update models set embedding_dimensions = ${WIDE} where id = '${embeddingModelId}'`);
    await configureEmbeddings({ spaceId: "wide-space", enabled: true, modelId: embeddingModelId });
    await exec(
      `update tools set config = jsonb_set(config, '{dimensions}', '${WIDE}') where name = 'knowledge_search'`,
    );
    const owner = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.create(owner, { name: "Wide vectors", description: "" }),
      ),
    );
    const note = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.addNote(owner, { collectionId, title: "Wide", content: "Terminate the contract." }),
      ),
    );
    const previous = { embed: fakeEmbedOverride };
    // A wide fake: the concept vector padded to WIDE, still non-zero.
    fakeEmbedOverride = (text) => {
      const base = fakeEmbed(text);
      return [...base, ...Array.from({ length: WIDE - base.length }, () => 0)];
    };
    try {
      await drainIndexer();
      const detail = await run(
        Effect.flatMap(KnowledgeService, (service) => service.detail(owner, collectionId)),
      );
      expect(detail.documents[0]).toMatchObject({ status: "ready", semanticStatus: "ready" });
      const stored = (
        await exec(
          `select vector_dims(embedding) as dims from knowledge_chunk_embeddings e join knowledge_chunks c on c.id = e.chunk_id where c.version_id = '${note.versionId}'`,
        )
      ).rows[0];
      expect(stored).toEqual({ dims: WIDE });
      // Exact search over the wide space finds the paraphrase.
      const hits = await run(
        Effect.flatMap(KnowledgeSearch, (search) =>
          search.search({ userId: owner, versionIds: [note.versionId], query: "cancel", limit: 3 }),
        ),
      );
      expect(hits.mode).toBe("hybrid");
      expect(hits.passages[0]?.content).toContain("Terminate");

      // A provider that suddenly returns the old narrow width is refused, not
      // stored beside the wide vectors where a distance would be meaningless.
      fakeEmbedOverride = (text) => fakeEmbed(text);
      const narrow = await run(
        Effect.flatMap(KnowledgeService, (service) =>
          service.addNote(owner, { collectionId, title: "Narrow", content: "Pay the invoice." }),
        ),
      );
      await drainIndexer();
      const after = await run(
        Effect.flatMap(KnowledgeService, (service) => service.detail(owner, collectionId)),
      );
      expect(after.documents.find((d) => d.id === narrow.documentId)).toMatchObject({
        status: "ready",
        semanticStatus: "failed",
      });
    } finally {
      fakeEmbedOverride = previous.embed;
      await exec(
        `update models set embedding_dimensions = ${DIMENSIONS} where id = '${embeddingModelId}'`,
      );
    }
  });

  it("retrieves a paraphrase semantically and keeps working when the provider fails", async () => {
    await configureEmbeddings({ spaceId: "space-a", enabled: true, modelId: embeddingModelId });
    const { owner, collectionId } = await seed();
    await drainIndexer();
    const versions = await versionIds(owner, collectionId);

    // "cancelling" shares no word with "terminate": only the vector side can
    // find this, which is the whole reason semantic search exists here.
    const semantic = await run(
      Effect.flatMap(KnowledgeSearch, (search) =>
        search.search({
          userId: owner,
          versionIds: versions,
          query: "cancelling the contract",
          limit: 2,
        }),
      ),
    );
    expect(semantic.mode).toBe("hybrid");
    expect(semantic.passages[0]!.content).toContain("## Termination");

    const lexicalOnly = await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.searchLexical(versions, "cancelling the contract", 5),
      ),
    );
    expect(lexicalOnly).toEqual([]);

    // A provider outage degrades this one search; it never hides the documents.
    embedFails = true;
    const degraded = await run(
      Effect.flatMap(KnowledgeSearch, (search) =>
        search.search({ userId: owner, versionIds: versions, query: "invoice payment", limit: 2 }),
      ),
    );
    embedFails = false;
    expect(degraded.mode).toBe("lexical");
    expect(degraded.degradedReason).toMatch(/keyword/);
    expect(degraded.passages.length).toBeGreaterThan(0);
  });

  it("excludes vectors from another space until they are rebuilt", async () => {
    await configureEmbeddings({ spaceId: "space-a", enabled: true, modelId: embeddingModelId });
    const { owner, collectionId } = await seed();
    await drainIndexer();
    const versions = await versionIds(owner, collectionId);

    // Switching to a different model is a different geometry: the old vectors
    // must not be compared against the new query's.
    await configureEmbeddings({ spaceId: "space-b", enabled: true, modelId: embeddingModelId });
    const stale = await run(
      Effect.flatMap(KnowledgeSearch, (search) =>
        search.search({
          userId: owner,
          versionIds: versions,
          query: "cancelling the contract",
          limit: 2,
        }),
      ),
    );
    expect(stale.passages).toEqual([]);
    const listed = await run(
      Effect.flatMap(KnowledgeService, (service) => service.detail(owner, collectionId)).pipe(
        Effect.map((detail) => detail.documents),
      ),
    );
    expect(listed[0]!.semanticStatus).toBe("needs_reindex");

    const before = embedCalls;
    await run(Effect.flatMap(KnowledgeRepo, (repo) => repo.reindexCollection(owner, collectionId)));
    await drainIndexer();
    expect(embedCalls).toBeGreaterThan(before);

    const rebuilt = await run(
      Effect.flatMap(KnowledgeSearch, (search) =>
        search.search({
          userId: owner,
          versionIds: versions,
          query: "cancelling the contract",
          limit: 2,
        }),
      ),
    );
    expect(rebuilt.passages[0]!.content).toContain("## Termination");
    const ready = await run(
      Effect.flatMap(KnowledgeService, (service) => service.detail(owner, collectionId)).pipe(
        Effect.map((detail) => detail.documents),
      ),
    );
    expect(ready[0]!.semanticStatus).toBe("ready");
  });

  it("marks unfinished jobs on an old compatible connection as needing owner reindex", async () => {
    await configureEmbeddings({
      spaceId: "compatible-pending",
      enabled: true,
      modelId: embeddingModelId,
    });
    const { owner, collectionId } = await seed();
    await run(Effect.flatMap(KnowledgeIndexer, (indexer) => indexer.runExtraction()));
    await configureEmbeddings({
      spaceId: "compatible-pending",
      enabled: true,
      modelId: embeddingModelId,
    });
    const detail = await run(
      Effect.flatMap(KnowledgeService, (service) => service.detail(owner, collectionId)),
    );
    expect(detail.documents[0]).toMatchObject({ status: "ready", semanticStatus: "needs_reindex" });
    const calls = embedCalls;
    await drainIndexer();
    expect(embedCalls).toBe(calls);
    await run(Effect.flatMap(KnowledgeService, (service) => service.reindex(owner, collectionId)));
    await drainIndexer();
    const ready = await run(
      Effect.flatMap(KnowledgeService, (service) => service.detail(owner, collectionId)),
    );
    expect(ready.documents[0]!.semanticStatus).toBe("ready");
  });

  it("does not re-embed when only the provider or key behind a space changes", async () => {
    await configureEmbeddings({ spaceId: "space-a", enabled: true, modelId: embeddingModelId });
    const { owner, collectionId } = await seed();
    await drainIndexer();
    const versions = await versionIds(owner, collectionId);

    // A rotated key and a renamed model are the same vectors; the space id is
    // what decides, and it has not moved.
    await exec(
      `update providers set api_key_ciphertext = 'rotated' where id = (
         select provider_id from models where id = '${embeddingModelId}')`,
    );
    await exec(
      `update models set display_name = 'Embed (renamed)' where id = '${embeddingModelId}'`,
    );

    const before = embedCalls;
    await drainIndexer();
    // Only the query embedding is spent, not a re-index of the corpus.
    expect(embedCalls).toBe(before);
    const result = await run(
      Effect.flatMap(KnowledgeSearch, (search) =>
        search.search({
          userId: owner,
          versionIds: versions,
          query: "cancelling the contract",
          limit: 2,
        }),
      ),
    );
    expect(result.mode).toBe("hybrid");
    expect(result.passages.length).toBeGreaterThan(0);
  });
  it("requires explicit compatibility approval for cross-provider model aliases", async () => {
    await configureEmbeddings({
      spaceId: "approved-space",
      enabled: true,
      modelId: embeddingModelId,
    });
    const admin = await createUser("admin");
    const { owner, collectionId } = await seed();
    await drainIndexer();
    const before = await run(Effect.flatMap(EmbeddingSpace, (space) => space.current()));
    const providerId = uuidv7();
    const aliasId = uuidv7();
    await exec(`insert into providers (id, name, preset, base_url, api_key_ciphertext)
      values ('${providerId}', 'Alias provider', 'custom', 'http://alias.invalid/v1', 'fake')`);
    await exec(`insert into models (id, provider_id, model_key, display_name, type, embedding_dimensions)
      values ('${aliasId}', '${providerId}', 'same-model-different-name', 'Alias', 'embedding', ${DIMENSIONS})`);
    const configured = await run(
      Effect.flatMap(EmbeddingSpace, (space) =>
        space.configure(admin, {
          modelId: aliasId,
          dimensions: DIMENSIONS,
          decision: "keep",
          expectedRevision: before!.connectionRevision,
        }),
      ),
    );
    expect(configured.spaceId).toBe(before!.spaceId);
    expect(configured.connectionRevision).not.toBe(before!.connectionRevision);
    const calls = embedCalls;
    await drainIndexer();
    expect(embedCalls).toBe(calls);
    const versions = await versionIds(owner, collectionId);
    const result = await run(
      Effect.flatMap(KnowledgeSearch, (search) =>
        search.search({
          userId: owner,
          versionIds: versions,
          query: "cancelling the contract",
          limit: 2,
        }),
      ),
    );
    expect(result.mode).toBe("hybrid");
    expect(result.passages).toHaveLength(1);
  });

  it("pauses on out-of-band connection edits and rejects stale, unauthorized, or dimension-incompatible approvals", async () => {
    await configureEmbeddings({
      spaceId: "connection-edits",
      enabled: true,
      modelId: embeddingModelId,
    });
    const admin = await createUser("admin");
    const stranger = await createUser();
    const before = await run(Effect.flatMap(EmbeddingSpace, (space) => space.current()));
    await exec(`update models set model_key = 'changed-alias' where id = '${embeddingModelId}'`);
    expect(await run(Effect.flatMap(EmbeddingSpace, (space) => space.current()))).toBeNull();
    const change = {
      modelId: embeddingModelId,
      dimensions: DIMENSIONS,
      decision: "keep" as const,
      expectedRevision: before!.connectionRevision,
    };
    const denied = await run(
      Effect.flatMap(EmbeddingSpace, (space) => Effect.flip(space.configure(stranger, change))),
    );
    expect(denied.reason).toContain("admins");
    const badWidth = await run(
      Effect.flatMap(EmbeddingSpace, (space) =>
        Effect.flip(space.configure(admin, { ...change, dimensions: DIMENSIONS + 1 })),
      ),
    );
    expect(badWidth.reason).toContain("rebuild");
    const accepted = await run(
      Effect.flatMap(EmbeddingSpace, (space) => space.configure(admin, change)),
    );
    expect(accepted.spaceId).toBe(before!.spaceId);
    const stale = await run(
      Effect.flatMap(EmbeddingSpace, (space) => Effect.flip(space.configure(admin, change))),
    );
    expect(stale.reason).toContain("reload");
    await exec(
      `update models set embedding_dimensions = ${DIMENSIONS + 1} where id = '${embeddingModelId}'`,
    );
    expect(await run(Effect.flatMap(EmbeddingSpace, (space) => space.current()))).toBeNull();
    const changedOutput = await run(
      Effect.flatMap(EmbeddingSpace, (space) =>
        Effect.flip(
          space.configure(admin, {
            ...change,
            expectedRevision: accepted.connectionRevision,
          }),
        ),
      ),
    );
    expect(changedOutput.reason).toContain("rebuild");
    await exec(
      `update models set model_key = 'embed-1', embedding_dimensions = ${DIMENSIONS} where id = '${embeddingModelId}'`,
    );
  });

  it("limits configuration reads and disabling to current admins without exposing secrets", async () => {
    await configureEmbeddings({
      spaceId: "admin-config",
      enabled: true,
      modelId: embeddingModelId,
    });
    const admin = await createUser("admin");
    const regular = await createUser();
    const detail = await run(Effect.flatMap(EmbeddingSpace, (space) => space.detail(admin)));
    expect(detail).toMatchObject({
      enabled: true,
      status: "ready",
      config: { spaceId: "admin-config" },
    });
    expect(Object.keys(detail).toSorted()).toEqual(["config", "enabled", "status"]);
    expect(Object.keys(detail.config.approvedConnection!).toSorted()).toEqual([
      "baseUrl",
      "modelDimensions",
      "modelKey",
      "preprocessingRevision",
      "providerId",
    ]);
    for (const actor of [regular, uuidv7()]) {
      expect(
        (await run(Effect.flatMap(EmbeddingSpace, (space) => Effect.flip(space.detail(actor)))))
          .reason,
      ).toContain("admins");
      expect(
        (
          await run(
            Effect.flatMap(EmbeddingSpace, (space) =>
              Effect.flip(
                space.disable(actor, {
                  expectedRevision: detail.config.connectionRevision,
                }),
              ),
            ),
          )
        ).reason,
      ).toContain("admins");
    }
    await exec(`update "user" set role = 'user' where id = '${admin}'`);
    expect(
      (await run(Effect.flatMap(EmbeddingSpace, (space) => Effect.flip(space.detail(admin)))))
        .reason,
    ).toContain("admins");
    expect(await run(Effect.flatMap(EmbeddingSpace, (space) => space.current()))).not.toBeNull();
  });

  it("disabling fences work and stale drafts while preserving compatible ready vectors", async () => {
    await configureEmbeddings({
      spaceId: "disabled-space",
      enabled: true,
      modelId: embeddingModelId,
    });
    const admin = await createUser("admin");
    const { owner, collectionId } = await seed();
    await drainIndexer();
    const before = await run(Effect.flatMap(EmbeddingSpace, (space) => space.current()));
    const calls = embedCalls;
    const eventCount = events.length;
    const disabled = await run(
      Effect.flatMap(EmbeddingSpace, (space) =>
        space.disable(admin, {
          expectedRevision: before!.connectionRevision,
        }),
      ),
    );
    expect(disabled.spaceId).toBe(before!.spaceId);
    expect(disabled.connectionRevision).not.toBe(before!.connectionRevision);
    expect(events.slice(eventCount)).toEqual([{ type: "resources.changed" }]);
    expect(await run(Effect.flatMap(EmbeddingSpace, (space) => space.current()))).toBeNull();
    expect(await run(Effect.flatMap(EmbeddingSpace, (space) => space.detail(admin)))).toMatchObject(
      { status: "disabled", enabled: false },
    );
    await drainIndexer();
    expect(embedCalls).toBe(calls);
    expect(
      (
        await run(
          Effect.flatMap(KnowledgeService, (service) => service.detail(owner, collectionId)),
        )
      ).documents[0]!.status,
    ).toBe("ready");
    const change = {
      modelId: embeddingModelId,
      dimensions: DIMENSIONS,
      decision: "keep" as const,
      expectedRevision: before!.connectionRevision,
    };
    expect(
      (
        await run(
          Effect.flatMap(EmbeddingSpace, (space) => Effect.flip(space.configure(admin, change))),
        )
      ).reason,
    ).toContain("reload");
    await run(
      Effect.flatMap(EmbeddingSpace, (space) =>
        space.configure(admin, { ...change, expectedRevision: disabled.connectionRevision }),
      ),
    );
    await drainIndexer();
    expect(embedCalls).toBe(calls);
    expect(
      (
        await run(
          Effect.flatMap(KnowledgeService, (service) => service.detail(owner, collectionId)),
        )
      ).documents[0]!.semanticStatus,
    ).toBe("ready");
  });

  it("rejects generic tool writes and malformed approvals without changing embedding configuration", async () => {
    await configureEmbeddings({
      spaceId: "guarded-config",
      enabled: true,
      modelId: embeddingModelId,
    });
    const admin = await createUser("admin");
    const before = await run(Effect.flatMap(EmbeddingSpace, (space) => space.detail(admin)));
    const eventCount = events.length;
    for (const write of [
      Effect.flatMap(ToolsRepo, (repo) =>
        repo.updateTool("knowledge_search", { config: { dimensions: 12 } }),
      ).pipe(Effect.asVoid),
      Effect.flatMap(ToolsRepo, (repo) => repo.setToolEnabled("knowledge_search", false)).pipe(
        Effect.asVoid,
      ),
    ])
      expect((await run(Effect.exit(write)))._tag).toBe("Failure");
    const change = {
      modelId: embeddingModelId,
      dimensions: DIMENSIONS,
      decision: "rebuild" as const,
      expectedRevision: before.config.connectionRevision,
    };
    for (const patch of [
      { dimensions: 0 },
      { dimensions: 8193 },
      { dimensions: 1.5 },
      { decision: "automatic" },
      { modelId: "" },
    ]) {
      const denied = await run(
        Effect.flatMap(EmbeddingSpace, (space) =>
          Effect.flip(space.configure(admin, { ...change, ...patch } as typeof change)),
        ),
      );
      expect(denied.reason).toBe("invalid embedding configuration");
    }
    expect(await run(Effect.flatMap(EmbeddingSpace, (space) => space.detail(admin)))).toEqual(
      before,
    );
    expect(events.length).toBe(eventCount);
  });

  it("serializes concurrent disable and rebuild approvals with the same revision", async () => {
    await configureEmbeddings({ spaceId: "config-cas", enabled: true, modelId: embeddingModelId });
    const admin = await createUser("admin");
    const before = await run(Effect.flatMap(EmbeddingSpace, (space) => space.current()));
    const calls = embedCalls;
    const results = await Promise.allSettled([
      run(
        Effect.flatMap(EmbeddingSpace, (space) =>
          space.disable(admin, { expectedRevision: before!.connectionRevision }),
        ),
      ),
      run(
        Effect.flatMap(EmbeddingSpace, (space) =>
          space.configure(admin, {
            modelId: embeddingModelId,
            dimensions: DIMENSIONS,
            decision: "rebuild",
            expectedRevision: before!.connectionRevision,
          }),
        ),
      ),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(embedCalls).toBe(calls);
  });

  it("a rebuild leaves existing corpora untouched until their owners request reindex", async () => {
    await configureEmbeddings({ spaceId: null, enabled: false });
    const admin = await createUser("admin");
    const first = await seed();
    const other = await seed();
    // Both uploads happened before an embedding provider was approved.
    const configured = await run(
      Effect.flatMap(EmbeddingSpace, (space) =>
        space.configure(admin, {
          modelId: embeddingModelId,
          dimensions: DIMENSIONS,
          decision: "rebuild",
          expectedRevision: null,
        }),
      ),
    );
    const calls = embedCalls;
    await drainIndexer();
    expect(embedCalls).toBe(calls);
    expect(
      await run(
        Effect.flatMap(KnowledgeRepo, (repo) => repo.reindexCollection(admin, first.collectionId)),
      ),
    ).toBe(0);
    expect(
      await run(
        Effect.flatMap(KnowledgeRepo, (repo) =>
          repo.reindexCollection(first.owner, first.collectionId),
        ),
      ),
    ).toBe(1);
    await drainIndexer();
    const firstVersions = await versionIds(first.owner, first.collectionId);
    const otherVersions = await versionIds(other.owner, other.collectionId);
    expect(
      await run(
        Effect.flatMap(KnowledgeRepo, (repo) =>
          repo.semanticVersionCount(firstVersions, configured.spaceId!),
        ),
      ),
    ).toBe(1);
    expect(
      await run(
        Effect.flatMap(KnowledgeRepo, (repo) =>
          repo.semanticVersionCount(otherVersions, configured.spaceId!),
        ),
      ),
    ).toBe(0);
  });

  it("shares query embeddings only inside a generation and retries failed queries", async () => {
    await configureEmbeddings({
      spaceId: "session-cache",
      enabled: true,
      modelId: embeddingModelId,
    });
    const { owner, collectionId } = await seed();
    await drainIndexer();
    const make = Effect.gen(function* () {
      const manifest = yield* (yield* KnowledgeRepo).resolveManifest(owner, [collectionId]);
      return yield* (yield* KnowledgeSearch).session({
        userId: owner,
        collectionIds: [collectionId],
        manifest,
      });
    });
    const calls = embedCalls;
    await run(
      Effect.gen(function* () {
        const session = yield* make;
        const query = { query: "cancelling the contract", limit: 2 };
        const results = yield* Effect.all([session.search(query), session.search(query)], {
          concurrency: 2,
        });
        expect(results.every((result) => result.mode === "hybrid")).toBe(true);
        expect(embedCalls).toBe(calls + 1);
        yield* session.search(query);
        expect(embedCalls).toBe(calls + 1);
        embedFails = true;
        try {
          expect((yield* session.search({ query: "paying invoices", limit: 2 })).mode).toBe(
            "lexical",
          );
        } finally {
          embedFails = false;
        }
        expect((yield* session.search({ query: "paying invoices", limit: 2 })).mode).toBe("hybrid");
        expect(embedCalls).toBe(calls + 3);
      }).pipe(Effect.scoped),
    );
    await run(
      Effect.gen(function* () {
        const session = yield* make;
        yield* session.search({ query: "cancelling the contract", limit: 2 });
      }).pipe(Effect.scoped),
    );
    expect(embedCalls).toBe(calls + 4);
  });

  it("refuses guessed versions and cached queries after access is revoked", async () => {
    await configureEmbeddings({
      spaceId: "session-revoke",
      enabled: true,
      modelId: embeddingModelId,
    });
    const { owner, collectionId } = await seed();
    await drainIndexer();
    const recipient = await createUser();
    const admin = await createUser("admin");
    const versions = await versionIds(owner, collectionId);
    const calls = embedCalls;
    for (const userId of [recipient, admin]) {
      const denied = await run(
        Effect.flatMap(KnowledgeSearch, (search) =>
          Effect.flip(search.search({ userId, versionIds: versions, query: "invoice", limit: 2 })),
        ),
      );
      expect(denied._tag).toBe("KnowledgeNotAvailable");
    }
    expect(embedCalls).toBe(calls);
    await run(
      Effect.gen(function* () {
        const repo = yield* KnowledgeRepo;
        yield* grantFixture(collectionId, recipient);
        const manifest = yield* repo.resolveManifest(recipient, [collectionId]);
        const session = yield* (yield* KnowledgeSearch).session({
          userId: recipient,
          collectionIds: [collectionId],
          manifest,
        });
        const query = { query: "invoice", limit: 2 };
        yield* session.search(query);
        expect(embedCalls).toBe(calls + 1);
        yield* revokeFixture(collectionId, recipient);
        expect((yield* Effect.flip(session.search(query)))._tag).toBe("KnowledgeNotAvailable");
        expect(embedCalls).toBe(calls + 1);
      }).pipe(Effect.scoped),
    );
  });

  it.each(["switch", "disable", "revoke"] as const)(
    "fences a permit-blocked query after %s before sending text",
    async (change) => {
      await configureEmbeddings({
        spaceId: "dispatch-original",
        enabled: true,
        modelId: embeddingModelId,
      });
      const { owner, collectionId } = await seed();
      await drainIndexer();
      const recipient = await createUser();
      await run(grantFixture(collectionId, recipient));
      const versions = await versionIds(owner, collectionId);
      let reached!: () => void;
      const waiting = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let release!: () => void;
      const permit = new Promise<void>((resolve) => {
        release = resolve;
      });
      beforeEmbedDispatch = async () => {
        reached();
        await permit;
      };
      const calls = embedCalls;
      const query = run(
        Effect.flatMap(KnowledgeSearch, (search) =>
          Effect.result(
            search.search({ userId: recipient, versionIds: versions, query: "invoice", limit: 2 }),
          ),
        ),
      );
      try {
        await waiting;
        if (change === "revoke") await run(revokeFixture(collectionId, recipient));
        else
          await configureEmbeddings({
            spaceId: change === "switch" ? "dispatch-next" : null,
            enabled: change === "switch",
            ...(change === "switch" ? { modelId: embeddingModelId } : {}),
          });
        release();
        const result = await query;
        expect(embedCalls).toBe(calls);
        if (change === "revoke")
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "KnowledgeNotAvailable" },
          });
        else
          expect(result).toMatchObject({
            _tag: "Success",
            success: { mode: "lexical", degradedReason: expect.any(String) },
          });
      } finally {
        release();
        beforeEmbedDispatch = null;
        await query;
      }
    },
  );

  it("drops search results when access is revoked during a query embedding", async () => {
    await configureEmbeddings({
      spaceId: "query-revocation",
      enabled: true,
      modelId: embeddingModelId,
    });
    const { collectionId } = await seed();
    await drainIndexer();
    const recipient = await createUser();
    await run(grantFixture(collectionId, recipient));
    onEmbed = () => run(revokeFixture(collectionId, recipient));
    try {
      await run(
        Effect.gen(function* () {
          const manifest = yield* (yield* KnowledgeRepo).resolveManifest(recipient, [collectionId]);
          const session = yield* (yield* KnowledgeSearch).session({
            userId: recipient,
            collectionIds: [collectionId],
            manifest,
          });
          expect((yield* Effect.flip(session.search({ query: "invoice", limit: 2 })))._tag).toBe(
            "KnowledgeNotAvailable",
          );
        }).pipe(Effect.scoped),
      );
    } finally {
      onEmbed = null;
    }
  });

  it("does not reuse cached vectors after an approved connection revision changes", async () => {
    await configureEmbeddings({
      spaceId: "cache-revision",
      enabled: true,
      modelId: embeddingModelId,
    });
    const { owner, collectionId } = await seed();
    await drainIndexer();
    const calls = embedCalls;
    await run(
      Effect.gen(function* () {
        const manifest = yield* (yield* KnowledgeRepo).resolveManifest(owner, [collectionId]);
        const session = yield* (yield* KnowledgeSearch).session({
          userId: owner,
          collectionIds: [collectionId],
          manifest,
        });
        const query = { query: "invoice", limit: 2 };
        yield* session.search(query);
        yield* Effect.promise(() =>
          configureEmbeddings({
            spaceId: "cache-revision",
            enabled: true,
            modelId: embeddingModelId,
          }),
        );
        yield* session.search(query);
        expect(embedCalls).toBe(calls + 2);
      }).pipe(Effect.scoped),
    );
  });

  it("rechecks empty collections and pending documents without upgrading the saved manifest", async () => {
    await configureEmbeddings({ spaceId: null, enabled: false });
    const { owner, collectionId } = await seed();
    const recipient = await createUser();
    await run(
      Effect.gen(function* () {
        const repo = yield* KnowledgeRepo;
        yield* grantFixture(collectionId, recipient);
        const emptyId = yield* repo.createCollection(owner, {
          name: "Empty selection",
          description: "",
        });
        yield* grantFixture(emptyId, recipient);
        const collectionIds = [collectionId, emptyId];
        const manifest = yield* repo.resolveManifest(recipient, collectionIds);
        expect(manifest[0]!.versionId).toBeNull();
        const session = yield* (yield* KnowledgeSearch).session({
          userId: recipient,
          collectionIds,
          manifest,
        });
        yield* Effect.promise(drainIndexer);
        expect((yield* session.search({ query: "invoice", limit: 2 })).passages).toEqual([]);
        yield* revokeFixture(emptyId, recipient);
        expect((yield* Effect.flip(session.authorize()))._tag).toBe("KnowledgeNotAvailable");
        yield* grantFixture(emptyId, recipient);
        yield* (yield* KnowledgeService).removeDocument(owner, manifest[0]!.documentId);
        expect((yield* Effect.flip(session.authorize()))._tag).toBe("KnowledgeNotAvailable");
      }).pipe(Effect.scoped),
    );
  });

  it("validates document/version ownership together and rejects use after session closure", async () => {
    await configureEmbeddings({ spaceId: null, enabled: false });
    const first = await seed();
    const other = await seed();
    await drainIndexer();
    await run(
      Effect.gen(function* () {
        const repo = yield* KnowledgeRepo;
        yield* grantFixture(other.collectionId, first.owner);
        const collectionIds = [first.collectionId, other.collectionId];
        const manifest = yield* repo.resolveManifest(first.owner, collectionIds);
        const forged = [{ ...manifest[0]!, versionId: manifest[1]!.versionId }];
        expect(
          (yield* Effect.flip(repo.authorizeManifest(first.owner, collectionIds, forged)))._tag,
        ).toBe("KnowledgeNotAvailable");
      }),
    );
    const escaped = await run(
      Effect.gen(function* () {
        const manifest = yield* (yield* KnowledgeRepo).resolveManifest(first.owner, [
          first.collectionId,
        ]);
        return yield* (yield* KnowledgeSearch).session({
          userId: first.owner,
          collectionIds: [first.collectionId],
          manifest,
        });
      }).pipe(Effect.scoped),
    );
    expect((await run(Effect.exit(escaped.search({ query: "invoice", limit: 2 }))))._tag).toBe(
      "Failure",
    );
  });

  it("does not publish an in-flight embedding after its approved connection changes", async () => {
    await configureEmbeddings({ spaceId: "inflight", enabled: true, modelId: embeddingModelId });
    const { owner, collectionId } = await seed();
    onEmbed = () =>
      exec(`update models set model_key = 'inflight-change' where id = '${embeddingModelId}'`).then(
        () => undefined,
      );
    try {
      await drainIndexer();
    } finally {
      onEmbed = null;
    }
    const versions = await versionIds(owner, collectionId);
    expect(
      await run(
        Effect.flatMap(KnowledgeRepo, (repo) => repo.semanticVersionCount(versions, "inflight")),
      ),
    ).toBe(0);
    await exec(`update models set model_key = 'embed-1' where id = '${embeddingModelId}'`);
  });

  it("drops an in-flight query vector when the connection changes", async () => {
    await configureEmbeddings({ spaceId: "query-fence", enabled: true, modelId: embeddingModelId });
    const { owner, collectionId } = await seed();
    await drainIndexer();
    const versions = await versionIds(owner, collectionId);
    onEmbed = () =>
      exec(`update models set model_key = 'query-change' where id = '${embeddingModelId}'`).then(
        () => undefined,
      );
    try {
      const result = await run(
        Effect.flatMap(KnowledgeSearch, (search) =>
          search.search({
            userId: owner,
            versionIds: versions,
            query: "cancelling the contract",
            limit: 2,
          }),
        ),
      );
      expect(result.mode).toBe("lexical");
      expect(result.passages).toEqual([]);
      expect(result.degradedReason).toContain("unavailable");
    } finally {
      onEmbed = null;
    }
    await exec(`update models set model_key = 'embed-1' where id = '${embeddingModelId}'`);
  });
});

describe("saved agent configurations", () => {
  const settings: AgentSettings = {
    name: "Contract reviewer",
    description: "Review agreements",
    icon: "book",
    instructions: "Compare evidence, and distinguish missing information.",
    modelId: null,
    searchEnabled: false,
    planEnabled: true,
    starters: ["Review this contract"],
    collectionIds: [],
  };
  const create = (owner: string, overrides: Partial<AgentSettings> = {}) =>
    run(
      Effect.flatMap(AgentService, (service) =>
        service.create(owner, { ...settings, ...overrides }),
      ),
    );
  const detail = (actor: string, agentId: string) =>
    run(Effect.flatMap(AgentService, (service) => service.detail(actor, agentId)));
  const selection = (actor: string, agentId: string) =>
    run(Effect.flatMap(AgentService, (service) => service.selection(actor, agentId)));

  it("keeps private agents owner-only, with no administrator editing bypass", async () => {
    const owner = await createUser();
    const admin = await createUser("admin");
    const id = await create(owner);
    expect(await detail(owner, id)).toMatchObject({
      name: settings.name,
      instructions: settings.instructions,
      canEdit: true,
      configRevision: 1,
      collections: [],
    });
    expect(await run(Effect.flatMap(AgentService, (service) => service.list(admin)))).toEqual([]);
    const rejected = await run(
      Effect.flatMap(AgentService, (service) => Effect.result(service.detail(admin, id))),
    );
    expect(rejected).toMatchObject({ _tag: "Failure", failure: { _tag: "AgentNotAvailable" } });
    const removal = await run(
      Effect.flatMap(AgentService, (service) => Effect.result(service.remove(admin, id))),
    );
    expect(removal._tag).toBe("Failure");
    await run(Effect.flatMap(AgentService, (service) => service.remove(owner, id)));
    expect(await run(Effect.flatMap(AgentService, (service) => service.list(owner)))).toEqual([]);
  });

  it("does not disclose or grant agent dependencies to recipients", async () => {
    const owner = await createUser("admin");
    const recipient = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.createCollection(owner, { name: "Confidential contracts", description: "" }),
      ),
    );
    const modelId = uuidv7();
    await exec(`insert into models (id, provider_id, model_key, display_name, type, access)
      select '${modelId}', provider_id, 'private-agent-chat', 'Private model name', 'chat', 'groups' from models where id = '${embeddingModelId}'`);
    const id = await create(owner, { collectionIds: [collectionId], modelId });
    await exec(
      `insert into agent_user_grants (agent_id, user_id) values ('${id}', '${recipient}')`,
    );
    const shared = await selection(recipient, id);
    expect(shared.canEdit).toBe(false);
    expect(shared).not.toHaveProperty("instructions");
    expect(
      await run(
        Effect.flatMap(AgentService, (service) => Effect.result(service.detail(recipient, id))),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { _tag: "AgentNotAvailable" } });
    expect(shared.collections).toEqual([{ id: collectionId, name: null, available: false }]);
    expect(shared.model).toEqual({ id: modelId, name: null, available: false });
    expect(JSON.stringify(shared)).not.toMatch(/Confidential contracts|Private model name/);
    const edit = await run(
      Effect.flatMap(AgentService, (service) =>
        Effect.result(service.update(recipient, { ...settings, agentId: id, expectedRevision: 1 })),
      ),
    );
    expect(edit).toMatchObject({ _tag: "Failure", failure: { _tag: "AgentNotAvailable" } });
    await run(grantFixture(collectionId, recipient));
    expect((await selection(recipient, id)).collections[0]).toMatchObject({
      name: "Confidential contracts",
      available: true,
    });
    await run(revokeFixture(collectionId, recipient));
    expect((await selection(recipient, id)).collections[0]!.available).toBe(false);
    await exec(`delete from models where id = '${modelId}'`);
    expect((await detail(owner, id)).model).toEqual({ id: modelId, name: null, available: false });
  });

  it("rejects inaccessible collections, embedding models and oversized configuration", async () => {
    const owner = await createUser();
    const foreign = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.createCollection(foreign, { name: "Private", description: "" }),
      ),
    );
    const inputs: Partial<AgentSettings>[] = [
      { collectionIds: [collectionId] },
      { collectionIds: [uuidv7()] },
      { modelId: embeddingModelId },
      { instructions: "x".repeat(20_001) },
      { name: "   " },
      { starters: ["  "] },
    ];
    for (const input of inputs) {
      const result = await run(
        Effect.flatMap(AgentService, (service) =>
          Effect.result(service.create(owner, { ...settings, ...input })),
        ),
      );
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "AgentRejected" } });
    }
    expect(await run(Effect.flatMap(AgentService, (service) => service.list(owner)))).toEqual([]);
  });

  it("serializes revision edits and preserves explicit collection order", async () => {
    const owner = await createUser();
    const collections = await Promise.all(
      ["First", "Second"].map((name) =>
        run(
          Effect.flatMap(KnowledgeRepo, (repo) =>
            repo.createCollection(owner, { name, description: "" }),
          ),
        ),
      ),
    );
    const id = await create(owner, { collectionIds: collections });
    const updates = await Promise.all(
      ["One", "Two"].map((name) =>
        run(
          Effect.flatMap(AgentService, (service) =>
            Effect.result(
              service.update(owner, {
                ...settings,
                agentId: id,
                expectedRevision: 1,
                name,
                collectionIds: [...collections].toReversed(),
              }),
            ),
          ),
        ),
      ),
    );
    expect(updates.filter((result) => result._tag === "Success")).toHaveLength(1);
    const current = await detail(owner, id);
    expect(current.configRevision).toBe(2);
    expect(current.collections.map((collection) => collection.id)).toEqual(
      [...collections].toReversed(),
    );
  });

  it("retains deleted dependencies in agents, conversation selections and saved manifests", async () => {
    await configureEmbeddings({ spaceId: null, enabled: false });
    const owner = await createUser();
    const collectionId = await run(
      Effect.flatMap(KnowledgeRepo, (repo) =>
        repo.createCollection(owner, { name: "Soon deleted", description: "" }),
      ),
    );
    const document = await run(
      Effect.flatMap(KnowledgeService, (service) =>
        service.addNote(owner, { collectionId, title: "Original", content: "Stable content" }),
      ),
    );
    await drainIndexer();
    const id = await create(owner, { collectionIds: [collectionId] });
    const conversationId = uuidv7();
    const messageId = uuidv7();
    await exec(`insert into conversations (id,user_id) values ('${conversationId}','${owner}')`);
    await exec(
      `insert into messages (id,conversation_id,role) values ('${messageId}','${conversationId}','assistant')`,
    );
    await exec(
      `insert into conversation_agents (conversation_id,agent_id) values ('${conversationId}','${id}')`,
    );
    await exec(
      `insert into message_generation_config (message_id,collection_ids,knowledge_mode) values ('${messageId}','${JSON.stringify([collectionId])}','context')`,
    );
    await exec(
      `insert into message_knowledge_versions (message_id,version_id,document_id,collection_id,status,position) values ('${messageId}','${document.versionId}','${document.documentId}','${collectionId}','ready',0)`,
    );
    await run(Effect.flatMap(KnowledgeService, (service) => service.remove(owner, collectionId)));
    expect((await detail(owner, id)).collections).toEqual([
      { id: collectionId, name: null, available: false },
    ]);
    expect(
      (
        await exec(
          `select agent_id from conversation_agents where conversation_id = '${conversationId}'`,
        )
      ).rows,
    ).toEqual([{ agent_id: id }]);
    expect(
      (
        await exec(
          `select version_id,document_id,collection_id from message_knowledge_versions where message_id = '${messageId}'`,
        )
      ).rows,
    ).toEqual([
      {
        version_id: document.versionId,
        document_id: document.documentId,
        collection_id: collectionId,
      },
    ]);
    await exec(`delete from conversations where id = '${conversationId}'`);
    expect(
      (await exec(`select * from message_knowledge_versions where message_id = '${messageId}'`))
        .rows,
    ).toEqual([]);
    expect(
      (await exec(`select * from conversation_agents where conversation_id = '${conversationId}'`))
        .rows,
    ).toEqual([]);
  });

  it("enforces the per-owner cap under concurrent creates", async () => {
    const owner = await createUser();
    await exec(
      `insert into agents (id,user_id,name) select '${owner}-' || n, '${owner}', 'Existing' from generate_series(1,99) n`,
    );
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        run(
          Effect.flatMap(AgentService, (service) => Effect.result(service.create(owner, settings))),
        ),
      ),
    );
    expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
    expect(results.filter((result) => result._tag === "Failure")).toHaveLength(2);
  });
});

describe.each(["agent", "collection"] as const)("%s sharing boundary", (kind) => {
  const resourceFor = async (owner: string): Promise<SharedResource> => {
    const id =
      kind === "agent"
        ? await run(
            Effect.flatMap(AgentService, (service) =>
              service.create(owner, {
                name: "Shared specialist",
                description: "",
                icon: "robot",
                instructions: "Answer questions.",
                modelId: null,
                searchEnabled: false,
                planEnabled: false,
                starters: [],
                collectionIds: [],
              }),
            ),
          )
        : await run(
            Effect.flatMap(KnowledgeRepo, (repo) =>
              repo.createCollection(owner, { name: "Shared knowledge", description: "" }),
            ),
          );
    return { kind, id };
  };
  const visible = (actor: string, resource: SharedResource) =>
    kind === "agent"
      ? run(Effect.flatMap(AgentRepo, (repo) => repo.get(actor, resource.id)))
      : run(Effect.flatMap(KnowledgeRepo, (repo) => repo.getCollection(actor, resource.id)));
  const change = (
    actor: string,
    resource: SharedResource,
    mutation: Parameters<SharingService["Service"]["change"]>[2],
  ) => run(Effect.flatMap(SharingService, (service) => service.change(actor, resource, mutation)));

  it.each(["user", "group"] as const)(
    "bounds %s grants while accepting duplicates at the cap",
    async (grantKind) => {
      const owner = await createUser("admin");
      const resource = await resourceFor(owner);
      const prefix = uuidv7();
      const table =
        kind === "agent" ? `agent_${grantKind}_grants` : `knowledge_collection_${grantKind}_grants`;
      const resourceColumn = kind === "agent" ? "agent_id" : "collection_id";
      if (grantKind === "user")
        await exec(
          `insert into "user" (id, name, email, role) select '${prefix}-' || n, 'Grantee', '${prefix}-' || n || '@t.io', 'user' from generate_series(1, 101) n`,
        );
      if (grantKind === "user")
        await exec(
          `insert into user_approvals (user_id, status) select '${prefix}-' || n, 'approved' from generate_series(1, 101) n`,
        );
      else
        await exec(
          `insert into groups (id, name) select '${prefix}-' || n, '${prefix}-group-' || n from generate_series(1, 101) n`,
        );
      await exec(
        `insert into ${table} (${resourceColumn}, ${grantKind}_id) select '${resource.id}', '${prefix}-' || n from generate_series(1, 100) n`,
      );
      const mutation = (n: number) =>
        grantKind === "user"
          ? { action: "email" as const, email: `${prefix}-${n}@t.io` }
          : { action: "group" as const, groupId: `${prefix}-${n}` };
      await change(owner, resource, mutation(1));
      const denied = await run(
        Effect.flatMap(SharingService, (service) =>
          Effect.flip(service.change(owner, resource, mutation(101))),
        ),
      );
      expect(denied).toMatchObject({
        _tag: "SharingNotAllowed",
        reason: expect.stringContaining("limit reached"),
      });
      const grants = await run(
        Effect.flatMap(SharingService, (service) => service.detail(owner, resource)),
      );
      expect(grantKind === "user" ? grants.users : grants.groups).toHaveLength(100);
    },
  );

  it("offers other accounts to the sharing picker, matched by name or email", async () => {
    const actor = await createUser();
    const id = uuidv7();
    const email = `${id}@t.io`;
    await exec(
      `insert into "user" (id, name, email, role) values ('${id}', 'Marnie ${id}', '${email}', 'user')`,
    );
    const recipients = (q: string) =>
      run(Effect.flatMap(SharingService, (service) => service.recipients(actor, q)));
    // A sign-up still waiting is nobody's recipient.
    await exec(`insert into user_approvals (user_id, status) values ('${id}', 'pending')`);
    expect(await recipients(`Marnie ${id}`)).toEqual([]);
    await exec(`update user_approvals set status = 'approved' where user_id = '${id}'`);
    expect(await recipients(`Marnie ${id}`)).toEqual([{ userId: id, name: `Marnie ${id}`, email }]);
    expect(await recipients(email.toUpperCase())).toHaveLength(1);
    expect(await recipients(`no-such-person-${id}`)).toEqual([]);
    // The directory never offers the actor their own account, and a wildcard
    // typed into the search box is matched literally, not expanded.
    expect((await recipients("")).some((row) => row.userId === actor)).toBe(false);
    expect(await recipients("%")).toEqual([]);
  });

  it("allows owner-only exact-email grants, without recipient resharing or a private admin bypass", async () => {
    const owner = await createUser();
    const recipient = await createUser();
    const admin = await createUser("admin");
    const resource = await resourceFor(owner);
    const eventStart = events.length;
    await change(owner, resource, { action: "email", email: ` ${recipient.toUpperCase()}@T.IO ` });
    expect(await visible(recipient, resource)).not.toBeNull();
    expect(await visible(admin, resource)).toBeNull();
    expect(events.slice(eventStart)).toEqual([{ type: "resources.changed" }]);
    for (const actor of [recipient, admin]) {
      const details = await run(
        Effect.flatMap(SharingService, (service) => Effect.result(service.detail(actor, resource))),
      );
      expect(details).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "KnowledgeNotAvailable" },
      });
      const denied = await run(
        Effect.flatMap(SharingService, (service) =>
          Effect.result(
            service.change(actor, resource, { action: "publish", audience: "instance" }),
          ),
        ),
      );
      expect(denied).toMatchObject({ _tag: "Failure", failure: { _tag: "KnowledgeNotAvailable" } });
    }
    await change(owner, resource, { action: "revokeUser", userId: recipient });
    expect(await visible(recipient, resource)).toBeNull();
  });

  it("requires eligible group membership for new grants but preserves existing grants when policy closes", async () => {
    const owner = await createUser();
    const member = await createUser();
    const resource = await resourceFor(owner);
    const group = await run(
      Effect.flatMap(GroupRepo, (repo) => repo.createGroup(`Sharing-${uuidv7()}`)),
    );
    await run(Effect.flatMap(GroupRepo, (repo) => repo.addMember(group.id, member)));
    await run(
      Effect.flatMap(GroupRepo, (repo) =>
        repo.setMemberSharing(group.id, member, {
          agents: true,
          knowledge: true,
          skills: true,
          projects: false,
        }),
      ),
    );
    const denied = await run(
      Effect.flatMap(SharingService, (service) =>
        Effect.result(service.change(owner, resource, { action: "group", groupId: group.id })),
      ),
    );
    expect(denied).toMatchObject({ _tag: "Failure", failure: { _tag: "SharingNotAllowed" } });
    await run(Effect.flatMap(GroupRepo, (repo) => repo.addMember(group.id, owner)));
    const noPermission = await run(
      SharingService.use((service) =>
        Effect.result(service.change(owner, resource, { action: "group", groupId: group.id })),
      ),
    );
    expect(noPermission).toMatchObject({ _tag: "Failure", failure: { _tag: "SharingNotAllowed" } });
    // Permission is per kind: every other kind allowed still does not cover this one.
    const ownKind = kind === "agent" ? "agents" : "knowledge";
    await run(
      GroupRepo.use((repo) =>
        repo.setMemberSharing(group.id, owner, {
          agents: true,
          knowledge: true,
          skills: true,
          projects: false,
          [ownKind]: false,
        }),
      ),
    );
    const otherKindsOnly = await run(
      SharingService.use((service) =>
        Effect.result(service.change(owner, resource, { action: "group", groupId: group.id })),
      ),
    );
    expect(otherKindsOnly).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SharingNotAllowed" },
    });
    expect(
      (await run(SharingService.use((service) => service.detail(owner, resource)))).eligibleGroups,
    ).not.toContainEqual({ id: group.id, name: group.name });
    const otherGroup = await run(GroupRepo.use((repo) => repo.createGroup(`Isolated-${uuidv7()}`)));
    await run(GroupRepo.use((repo) => repo.addMember(otherGroup.id, owner)));
    await run(
      Effect.flatMap(GroupRepo, (repo) =>
        repo.setMemberSharing(group.id, owner, {
          agents: true,
          knowledge: true,
          skills: true,
          projects: false,
        }),
      ),
    );
    const isolated = await run(
      SharingService.use((service) =>
        Effect.result(service.change(owner, resource, { action: "group", groupId: otherGroup.id })),
      ),
    );
    expect(isolated).toMatchObject({ _tag: "Failure", failure: { _tag: "SharingNotAllowed" } });
    await run(
      GroupRepo.use((repo) =>
        repo.setMemberSharing(group.id, member, {
          agents: false,
          knowledge: false,
          skills: false,
          projects: false,
        }),
      ),
    );
    const memberResource = await resourceFor(member);
    const memberDenied = await run(
      SharingService.use((service) =>
        Effect.result(
          service.change(member, memberResource, { action: "group", groupId: group.id }),
        ),
      ),
    );
    expect(memberDenied).toMatchObject({ _tag: "Failure", failure: { _tag: "SharingNotAllowed" } });

    const detail = await run(
      Effect.flatMap(SharingService, (service) => service.detail(owner, resource)),
    );
    expect(detail.eligibleGroups).toContainEqual({ id: group.id, name: group.name });
    await change(owner, resource, { action: "group", groupId: group.id });
    expect(await visible(member, resource)).not.toBeNull();
    await run(
      Effect.flatMap(GroupRepo, (repo) =>
        repo.setMemberSharing(group.id, owner, {
          agents: false,
          knowledge: false,
          skills: false,
          projects: false,
        }),
      ),
    );
    await change(owner, resource, { action: "group", groupId: group.id });
    expect(await visible(member, resource)).not.toBeNull();
    const closed = await run(
      Effect.flatMap(SharingService, (service) => service.detail(owner, resource)),
    );
    expect(closed.eligibleGroups).not.toContainEqual({ id: group.id, name: group.name });
    const other = await resourceFor(owner);
    const blocked = await run(
      Effect.flatMap(SharingService, (service) =>
        Effect.result(service.change(owner, other, { action: "group", groupId: group.id })),
      ),
    );
    expect(blocked._tag).toBe("Failure");
    await change(owner, resource, { action: "email", email: `${member}@t.io` });
    await run(Effect.flatMap(GroupRepo, (repo) => repo.removeMember(group.id, member)));
    expect(await visible(member, resource)).not.toBeNull();
    await change(owner, resource, { action: "revokeUser", userId: member });
    expect(await visible(member, resource)).toBeNull();
    await change(owner, resource, { action: "revokeGroup", groupId: group.id });
  });

  it.each(["disable", "remove"] as const)(
    "serializes grant creation against membership %s in both transaction orders",
    async (operation) => {
      const owner = await createUser();
      const group = await run(GroupRepo.use((repo) => repo.createGroup(`Race-${uuidv7()}`)));
      await run(GroupRepo.use((repo) => repo.addMember(group.id, owner)));
      const controller = new Client({ connectionString: database.url });
      await controller.connect();
      const { rows: controllerRows } = await controller.query<{ pid: number }>(
        "select pg_backend_pid() as pid",
      );
      const controllerPid = controllerRows[0]!.pid;
      const waitForBlocked = async (blocker: number): Promise<number> => {
        // Observe actual lock waiters, never infer ordering from elapsed time.
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          // Sequential observation is the barrier: the next query depends on this result.
          // oxlint-disable-next-line no-await-in-loop
          const { rows } = await controller.query<{ pid: number }>(
            "select pid from pg_stat_activity where $1::int = any(pg_blocking_pids(pid))",
            [blocker],
          );
          if (rows[0]) return rows[0].pid;
        }
        throw new Error("Expected transaction did not reach its lock barrier");
      };
      const revoke = () =>
        run(
          Effect.flatMap(GroupRepo, (repo) =>
            operation === "disable"
              ? repo.setMemberSharing(group.id, owner, {
                  agents: false,
                  knowledge: false,
                  skills: false,
                  projects: false,
                })
              : repo.removeMember(group.id, owner),
          ),
        );
      const table = kind === "agent" ? "agent_group_grants" : "knowledge_collection_group_grants";
      const column = kind === "agent" ? "agent_id" : "collection_id";
      const trigger = `sharing_barrier_${uuidv7().replaceAll("-", "")}`;
      let grant: Promise<void> | undefined;
      let revocation: Promise<void> | undefined;
      try {
        await run(
          GroupRepo.use((repo) =>
            repo.setMemberSharing(group.id, owner, {
              agents: true,
              knowledge: true,
              skills: true,
              projects: false,
            }),
          ),
        );
        const first = await resourceFor(owner);
        await controller.query("select pg_advisory_lock(hashtext($1))", [first.id]);
        await controller.query(
          `create function ${trigger}() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(hashtext(NEW.${column})); return NEW; end $$`,
        );
        await controller.query(
          `create trigger ${trigger} before insert on ${table} for each row when (NEW.${column} = '${first.id}') execute function ${trigger}()`,
        );
        grant = change(owner, first, { action: "group", groupId: group.id });
        const grantPid = await waitForBlocked(controllerPid);
        revocation = revoke();
        await waitForBlocked(grantPid);
        await controller.query("select pg_advisory_unlock_all()");
        await Promise.all([grant, revocation]);
        expect(
          (await run(SharingService.use((service) => service.detail(owner, first)))).groups,
        ).toContainEqual({ groupId: group.id, name: group.name });
        // Existing grants remain idempotent even when permission/membership is gone.
        await change(owner, first, { action: "group", groupId: group.id });
        await controller.query(`drop trigger ${trigger} on ${table}`);
        await controller.query(`drop function ${trigger}()`);

        await run(GroupRepo.use((repo) => repo.addMember(group.id, owner)));
        await run(
          GroupRepo.use((repo) =>
            repo.setMemberSharing(group.id, owner, {
              agents: true,
              knowledge: true,
              skills: true,
              projects: false,
            }),
          ),
        );
        const second = await resourceFor(owner);
        await controller.query("begin");
        await controller.query(
          operation === "disable"
            ? `update group_members set ${kind === "agent" ? "share_agents" : "share_knowledge"} = false where group_id = $1 and user_id = $2`
            : "delete from group_members where group_id = $1 and user_id = $2",
          [group.id, owner],
        );
        const blocked = run(
          SharingService.use((service) =>
            Effect.result(service.change(owner, second, { action: "group", groupId: group.id })),
          ),
        );
        await waitForBlocked(controllerPid);
        await controller.query("commit");
        expect(await blocked).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "SharingNotAllowed" },
        });
        expect(
          (await run(SharingService.use((service) => service.detail(owner, second)))).groups,
        ).toEqual([]);
      } finally {
        await controller.query("rollback");
        await controller.query("select pg_advisory_unlock_all()");
        await Promise.allSettled([grant, revocation].filter((p) => p !== undefined));
        await controller.query(`drop trigger if exists ${trigger} on ${table}`);
        await controller.query(`drop function if exists ${trigger}()`);
        await controller.end();
      }
    },
  );

  it("allows an admin owner to publish or share to any group, never a regular owner", async () => {
    const admin = await createUser("admin");
    const owner = await createUser();
    const outsider = await createUser();
    const resource = await resourceFor(admin);
    const own = await resourceFor(owner);
    const group = await run(
      Effect.flatMap(GroupRepo, (repo) => repo.createGroup(`Closed-${uuidv7()}`)),
    );
    await change(admin, resource, { action: "group", groupId: group.id });
    await change(admin, resource, { action: "publish", audience: "instance" });
    expect(await visible(outsider, resource)).not.toBeNull();
    await change(admin, resource, { action: "publish", audience: "private" });
    expect(await visible(outsider, resource)).toBeNull();
    const denied = await run(
      Effect.flatMap(SharingService, (service) =>
        Effect.result(service.change(owner, own, { action: "publish", audience: "instance" })),
      ),
    );
    expect(denied).toMatchObject({ _tag: "Failure", failure: { _tag: "SharingNotAllowed" } });
    expect(await visible(outsider, own)).toBeNull();
  });

  it("throttles missing-account probes per actor before any grant is written", async () => {
    const owner = await createUser();
    const resource = await resourceFor(owner);
    for (let attempt = 0; attempt < 10; attempt++) {
      const result = await run(
        Effect.flatMap(SharingService, (service) =>
          Effect.result(
            service.change(owner, resource, { action: "email", email: "missing@example.invalid" }),
          ),
        ),
      );
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "SharingNotAllowed" } });
    }
    const refused = await run(
      Effect.flatMap(SharingService, (service) =>
        Effect.result(
          service.change(owner, resource, { action: "email", email: "missing@example.invalid" }),
        ),
      ),
    );
    expect(refused).toMatchObject({ _tag: "Failure", failure: { _tag: "SharingRateLimited" } });
    const detail = await run(
      Effect.flatMap(SharingService, (service) => service.detail(owner, resource)),
    );
    expect(detail.users).toEqual([]);
  });
});
