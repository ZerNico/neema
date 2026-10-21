import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Effect, ManagedRuntime } from "effect";
import { uuidv7 } from "uuidv7";
import { attachmentBlobs, user, userApprovals } from "~/db/schema/index.ts";
import { sha256Hex } from "~/modules/attachments/server/sha256.ts";
import { GroupRepo } from "~/modules/groups/server/repo.ts";
import { StorageQuota } from "~/modules/limits/server/storage.ts";
import { Db } from "~/server/db.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";
import { engineLayer } from "./engine-harness.ts";

process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");

let database: TestDatabase;
type Services = StorageQuota | GroupRepo | Db;
let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>;

beforeAll(async () => {
  database = await createTestDatabase();
  runtime = ManagedRuntime.make(engineLayer(database.url, {}));
}, 180_000);

afterAll(async () => {
  await runtime?.dispose();
  await database?.drop();
});

const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  runtime.runPromise(effect as never) as Promise<A>;

const quota = <A, E>(f: (service: StorageQuota["Service"]) => Effect.Effect<A, E>) =>
  run(Effect.flatMap(StorageQuota, f));

const makeUser = (role: "user" | "admin" = "user") =>
  run(
    Effect.gen(function* () {
      const db = yield* Db;
      const userId = uuidv7();
      yield* db.insert(user).values({ id: userId, name: "Test", email: `${userId}@t.io`, role });
      yield* db.insert(userApprovals).values({ userId, status: "approved" });
      return userId;
    }),
  );

/** Bytes this person already stores, as an upload would have left them. */
const store = (userId: string, bytes: Uint8Array) =>
  run(
    Effect.gen(function* () {
      const db = yield* Db;
      const sha256 = sha256Hex(bytes);
      yield* db.insert(attachmentBlobs).values({
        id: uuidv7(),
        userId,
        sha256,
        storageKey: `test/${userId}/${sha256}`,
        size: bytes.length,
        mediaType: "application/octet-stream",
      });
    }),
  );

const file = (size: number, fill = 1) => new Uint8Array(size).fill(fill);

const admitted = (userId: string, files: Uint8Array[]) =>
  quota((service) => service.admit(userId, files).pipe(Effect.result));

const group = (members: ReadonlyArray<string>) =>
  run(
    Effect.gen(function* () {
      const repo = yield* GroupRepo;
      const created = yield* repo.createGroup(`Group ${uuidv7()}`);
      for (const member of members) yield* repo.addMember(created.id, member);
      return created.id;
    }),
  );

describe("storage quotas", () => {
  it("refuses an upload past everyone's quota, counting stored bytes once", async () => {
    await quota((service) => service.setEveryone(1000));
    const person = await makeUser();
    await store(person, file(600));
    expect((await admitted(person, [file(400, 2)]))._tag).toBe("Success");
    const refused = await admitted(person, [file(401, 3)]);
    expect(refused._tag).toBe("Failure");
    expect(JSON.stringify(refused)).toMatch(/Not enough storage/);
    // The same bytes again cost nothing: they are stored once.
    expect((await admitted(person, [file(600)]))._tag).toBe("Success");
    // Two copies of one new file in one upload count once.
    expect((await admitted(person, [file(300, 4), file(300, 4)]))._tag).toBe("Success");
    expect(await quota((service) => service.standing(person))).toEqual({ used: 600, quota: 1000 });
    // Admins store what they like.
    const admin = await makeUser("admin");
    expect((await admitted(admin, [file(5000)]))._tag).toBe("Success");
  });

  it("lets a group raise, lower or lift it, the most generous group winning", async () => {
    await quota((service) => service.setEveryone(1000));
    const raised = await makeUser();
    const lowered = await makeUser();
    const both = await makeUser();
    const lifted = await makeUser();
    const silent = await makeUser();
    const big = await group([raised, both]);
    const small = await group([lowered, both]);
    const free = await group([lifted]);
    await group([silent]);
    await quota((service) => service.setGroup(big, 5000));
    await quota((service) => service.setGroup(small, 100));
    await quota((service) => service.setGroup(free, null));
    const upload = [file(2000, 9)];
    expect((await admitted(raised, upload))._tag).toBe("Success");
    expect((await admitted(lowered, [file(200, 9)]))._tag).toBe("Failure");
    expect((await admitted(both, upload))._tag).toBe("Success");
    expect((await admitted(lifted, [file(10_000, 9)]))._tag).toBe("Success");
    expect((await admitted(silent, upload))._tag).toBe("Failure");
    // Handed back, the group's members are held to everyone's again.
    await quota((service) => service.setGroup(big, undefined));
    expect((await admitted(raised, upload))._tag).toBe("Failure");
  });

  it("charges a file kept under someone else to them, telling the writer only whose it is", async () => {
    await quota((service) => service.setEveryone(1000));
    const owner = await makeUser();
    const editor = await makeUser();
    await store(owner, file(900));
    const refused = await quota((service) =>
      service.admitFor(owner, editor, [file(200, 5)]).pipe(Effect.result),
    );
    expect(JSON.stringify(refused)).toMatch(/owner of where this goes is out of storage/);
    // Neither the owner's use nor their quota is told to the writer.
    expect(JSON.stringify(refused)).not.toMatch(/\d+ (bytes|KB)/);
    // The editor's own space is not what pays.
    expect((await admitted(editor, [file(200, 5)]))._tag).toBe("Success");
    // Writing to one's own, it reads as one's own.
    expect(
      JSON.stringify(
        await quota((service) =>
          service.admitFor(owner, owner, [file(200, 5)]).pipe(Effect.result),
        ),
      ),
    ).toMatch(/Not enough storage: this needs 200 bytes and 100 bytes is free/);
  });

  it("stores without a quota once everyone's is removed, and refuses a size that cannot hold", async () => {
    await quota((service) => service.setEveryone(null));
    const person = await makeUser();
    expect((await admitted(person, [file(100_000)]))._tag).toBe("Success");
    for (const bad of [0, -5, 1.5])
      expect(
        JSON.stringify(await quota((service) => service.setEveryone(bad).pipe(Effect.result))),
      ).toMatch(/between zero and 1 PB/);
  });
});
