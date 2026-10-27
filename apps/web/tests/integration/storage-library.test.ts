import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { Effect, ManagedRuntime, Stream } from "effect";
import { Response as AiResponse } from "effect/ai";
import { uuidv7 } from "uuidv7";
import {
  attachmentBlobs,
  messageAttachments,
  messages,
  user,
  userApprovals,
} from "~/db/schema/index.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { ChatService } from "~/modules/chat/server/service.ts";
import { StreamEngine } from "~/modules/chat/server/streaming.ts";
import { StorageLibrary } from "~/modules/limits/server/library.ts";
import type { AiGateway } from "~/modules/providers/server/gateway.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { Db } from "~/server/db.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";
import { engineLayer } from "./engine-harness.ts";
import { memoryBlobStore } from "./unused-services.ts";

process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");

let database: TestDatabase;
type Services = AttachmentService | ChatService | StreamEngine | StorageLibrary | ProviderRepo | Db;
let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>;
let modelId: string;

const gateway = {
  streamChat: () =>
    Stream.make(
      AiResponse.makePart("text-delta", { id: "t", delta: "answer" }),
      AiResponse.makePart("finish", {
        reason: "stop",
        usage: new AiResponse.Usage({
          inputTokens: {
            uncached: undefined,
            total: 1,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 1, text: undefined, reasoning: undefined },
        }),
      }),
    ),
} satisfies Partial<AiGateway["Service"]>;

const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  runtime.runPromise(effect as never) as Promise<A>;

beforeAll(async () => {
  database = await createTestDatabase();
  // Files are stored here, so they need somewhere to go.
  runtime = ManagedRuntime.make(
    engineLayer(database.url, { gateway, services: memoryBlobStore() }),
  );
  const providerId = uuidv7();
  await run(
    Effect.flatMap(Db, (db) =>
      db.execute(
        `insert into providers (id, name, preset, base_url, api_key_ciphertext)
         values ('${providerId}', 'Prov', 'openrouter', 'http://x', 'x')` as never,
      ),
    ),
  );
  const model = await run(
    Effect.flatMap(ProviderRepo, (providers) =>
      providers.createModel({
        providerId,
        modelKey: `key-${uuidv7()}`,
        displayName: "Model",
        type: "chat",
        contextLength: null,
        embeddingDimensions: null,
        capabilities: {
          imageOutput: false,
          reasoning: false,
          tools: false,
          vision: false,
          files: false,
        },
        pricing: null,
        enabled: true,
        access: "public",
        groupIds: [],
      }),
    ),
  );
  modelId = model.id;
}, 180_000);

afterAll(async () => {
  await runtime?.dispose();
  await database?.drop();
});

const makeUser = () =>
  run(
    Effect.gen(function* () {
      const db = yield* Db;
      const userId = uuidv7();
      yield* db.insert(user).values({ id: userId, name: "Test", email: `${userId}@t.io` });
      yield* db.insert(userApprovals).values({ userId, status: "approved" });
      return userId;
    }),
  );

const upload = (userId: string, text: string, fileName = "notes.txt") =>
  run(
    Effect.flatMap(AttachmentService, (files) =>
      files.upload({
        userId,
        fileName,
        declaredMediaType: "text/plain",
        bytes: new TextEncoder().encode(text),
      }),
    ),
  );

const sendWith = async (userId: string, attachmentIds: string[]) => {
  const turn = await run(
    Effect.flatMap(ChatService, (chat) =>
      chat.sendMessage({
        userId,
        conversation: { kind: "new", id: uuidv7() },
        modelId,
        content: "Look at this",
        searchEnabled: false,
        researchEnabled: false,
        attachmentIds,
      }),
    ),
  );
  await run(
    Effect.flatMap(StreamEngine, (engine) =>
      engine.subscribe(turn.assistantMessageId, 0).pipe(Stream.runCollect),
    ),
  );
  return turn;
};

const list = (userId: string) =>
  run(Effect.flatMap(StorageLibrary, (library) => library.list(userId)));

const blobsOf = (userId: string) =>
  run(
    Effect.flatMap(Db, (db) =>
      db
        .select({ id: attachmentBlobs.id })
        .from(attachmentBlobs)
        .where(eq(attachmentBlobs.userId, userId)),
    ),
  );

describe("the storage library", () => {
  it("lists each file once with every place, and takes one out of its chat for room", async () => {
    const person = await makeUser();
    const sent = await upload(person, "x".repeat(300), "report.txt");
    const turn = await sendWith(person, [sent.id]);
    const unsent = await upload(person, "draft", "draft.txt");
    const listed = await list(person);
    expect(listed.files.map((file) => file.size)).toEqual([300, 5]);
    expect(listed.files[0]!.places).toEqual([
      expect.objectContaining({
        kind: "chat",
        name: "report.txt",
        conversationId: turn.conversationId,
        removable: true,
        deleted: false,
      }),
    ]);
    expect(listed.files[1]!.places).toEqual([
      { kind: "upload", attachmentId: unsent.id, name: "draft.txt" },
    ]);
    // Nobody else's files show.
    expect((await list(await makeUser())).files).toEqual([]);

    // While the chat answers, its files stay where they are.
    await run(
      Effect.flatMap(Db, (db) =>
        db
          .update(messages)
          .set({ status: "streaming", generationLeaseUntil: sql`now() + interval '1 minute'` })
          .where(eq(messages.id, turn.assistantMessageId)),
      ),
    );
    const busy = await run(
      Effect.flatMap(AttachmentService, (files) =>
        files.removeFromChat({ userId: person, attachmentId: sent.id }).pipe(Effect.result),
      ),
    );
    expect(busy).toMatchObject({ _tag: "Failure", failure: { _tag: "AttachmentBusy" } });
    await run(
      Effect.flatMap(Db, (db) =>
        db
          .update(messages)
          .set({ status: "complete" })
          .where(eq(messages.id, turn.assistantMessageId)),
      ),
    );
    // Someone else cannot take it out.
    const other = await makeUser();
    const stranger = await run(
      Effect.flatMap(AttachmentService, (files) =>
        files.removeFromChat({ userId: other, attachmentId: sent.id }).pipe(Effect.result),
      ),
    );
    expect(stranger).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "AttachmentNotAvailable" },
    });

    await run(
      Effect.flatMap(AttachmentService, (files) =>
        files.removeFromChat({ userId: person, attachmentId: sent.id }),
      ),
    );
    const links = await run(
      Effect.flatMap(Db, (db) =>
        db.select().from(messageAttachments).where(eq(messageAttachments.attachmentId, sent.id)),
      ),
    );
    expect(links).toEqual([]);
    expect((await list(person)).files.map((file) => file.size)).toEqual([5]);
    expect(await blobsOf(person)).toHaveLength(1);
  }, 60_000);

  it("leaves an answer's own files in place: its output names them too", async () => {
    const person = await makeUser();
    const turn = await sendWith(person, []);
    const made = await upload(person, "z".repeat(50), "chart.png.txt");
    await run(
      Effect.flatMap(Db, (db) =>
        db
          .insert(messageAttachments)
          .values({ messageId: turn.assistantMessageId, attachmentId: made.id, position: 0 }),
      ),
    );
    const [file] = (await list(person)).files;
    expect(file!.places).toEqual([expect.objectContaining({ kind: "chat", removable: false })]);
    const refused = await run(
      Effect.flatMap(AttachmentService, (files) =>
        files.removeFromChat({ userId: person, attachmentId: made.id }).pipe(Effect.result),
      ),
    );
    expect(refused).toMatchObject({ _tag: "Failure", failure: { _tag: "AttachmentNotAvailable" } });
  }, 60_000);
});
