import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PgClient } from "@effect/sql-pg";
import { eq } from "drizzle-orm";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Redacted, Stream } from "effect";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  conversations,
  defaultCapabilities,
  documents,
  groupMembers,
  groups,
  projectGroupGrants,
  projectMemories,
  user,
  userApprovals,
} from "~/db/schema/index.ts";
import { toMarkdown } from "~/modules/documents/editor/markdown.ts";
import { fsBlobStoreLayer } from "~/modules/attachments/server/fs-blob-store.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { DocumentRepo } from "~/modules/documents/server/document-repo.ts";
import { DocumentService } from "~/modules/documents/server/document-service.ts";
import { ALL_CAPABILITIES } from "~/modules/groups/policy.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { StorageQuota } from "~/modules/limits/server/storage.ts";
import { resolveProject } from "~/modules/projects/server/access.ts";
import { ProjectMemoryService } from "~/modules/projects/server/project-memory.ts";
import { PROJECT_LIMITS } from "~/modules/projects/schema.ts";
import { ProjectService } from "~/modules/projects/server/service.ts";
import type { SyncEvent } from "~/modules/sync/events.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import { collabEditor } from "../fixtures/collab-editor.ts";
import { seedEligibleSession } from "../fixtures/eligible-session.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

process.env.BLOB_STORE_ROOT = mkdtempSync(join(tmpdir(), "projects-it-"));

let database: TestDatabase;
type Services = Db | ProjectService | ProjectMemoryService | DocumentService | FeaturePolicy;
let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>;
const run = <A, E>(effect: Effect.Effect<A, E, Services>) => runtime.runPromise(effect);
const exit = <A, E>(effect: Effect.Effect<A, E, Services>) => runtime.runPromiseExit(effect);
/** The typed failure a refused call ended with, or the exit itself when it did not fail. */
const failureOf = (result: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(result) ? Cause.squash(result.cause) : result;
const events: Array<{ userId: string | null; event: SyncEvent }> = [];
const TestBus = Layer.succeed(SyncBus, {
  publish: (userId, event) => Effect.sync(() => void events.push({ userId, event })),
  publishGlobal: (event) => Effect.sync(() => void events.push({ userId: null, event })),
  signals: Stream.make({ type: "ready" } as const).pipe(Stream.concat(Stream.never)),
  subscribe: () => Stream.empty,
});

beforeAll(async () => {
  database = await createTestDatabase();
  const infrastructure = Db.layer.pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(database.url), maxConnections: 8 })),
  );
  const core = Layer.mergeAll(
    DocumentRepo.layer,
    AttachmentRepo.layer,
    TestBus,
    fsBlobStoreLayer,
  ).pipe(
    Layer.provideMerge(FeaturePolicy.layer),
    Layer.provideMerge(StorageQuota.layer),
    Layer.provideMerge(infrastructure),
  );
  runtime = ManagedRuntime.make(
    Layer.mergeAll(DocumentService.layer, ProjectService.layer, ProjectMemoryService.layer).pipe(
      Layer.provideMerge(core),
    ),
  );
}, 180_000);
afterAll(async () => {
  await runtime?.dispose();
  await database?.drop();
});

const db = <A>(body: (db: Db["Service"]) => Effect.Effect<A, unknown>) =>
  run(Effect.flatMap(Db, body));
const createUser = async (role: "user" | "admin" = "user") => {
  const id = uuidv7();
  await db((d) =>
    d.insert(user).values({ id, name: `User ${id.slice(-4)}`, email: `${id}@t.io`, role }),
  );
  await run(seedEligibleSession(id));
  return id;
};
const email = (id: string) => `${id}@t.io`;
const projects = <A, E>(body: (service: ProjectService["Service"]) => Effect.Effect<A, E>) =>
  run(Effect.flatMap(ProjectService, body));
const memory = <A, E>(body: (service: ProjectMemoryService["Service"]) => Effect.Effect<A, E>) =>
  run(Effect.flatMap(ProjectMemoryService, body));
const docs = <A, E>(body: (service: DocumentService["Service"]) => Effect.Effect<A, E>) =>
  run(Effect.flatMap(DocumentService, body));
/** The stored tree as Markdown, as one member may read it. */
const markdownOf = (userId: string, documentId: string) =>
  docs((s) => s.read(userId, documentId)).then((read) => toMarkdown(read!.doc));
const newProject = (owner: string, name = "Launch") =>
  projects((s) => s.create(owner, { name, instructions: "Write in British English." }));
const role = (userId: string, projectId: string) =>
  projects((s) => s.get(userId, projectId)).then(
    (detail) => detail.role,
    () => null,
  );
const createGroup = async (members: ReadonlyArray<{ userId: string; shareProjects?: boolean }>) => {
  const id = uuidv7();
  await db((d) => d.insert(groups).values({ id, name: `Group ${id}` }));
  for (const member of members)
    // oxlint-disable-next-line eslint/no-await-in-loop -- A handful of rows, in order.
    await db((d) =>
      d.insert(groupMembers).values({
        groupId: id,
        userId: member.userId,
        shareProjects: member.shareProjects ?? false,
      }),
    );
  return id;
};
/** A person's editor, seeded from the feed like the panel's. */
const openEditor = (userId: string, documentId: string) => collabEditor(run, userId, documentId);

describe("roles", () => {
  it("gives the owner, direct members and group members their roles and nobody else any", async () => {
    const owner = await createUser();
    const editor = await createUser();
    const viewer = await createUser();
    const grouped = await createUser();
    const stranger = await createUser();
    const project = await newProject(owner);
    expect(project).toMatchObject({ role: "owner", instructions: "Write in British English." });
    await projects((s) =>
      s.changeMembers(owner, project.id, {
        action: "addUser",
        email: email(editor),
        role: "editor",
      }),
    );
    await projects((s) =>
      s.changeMembers(owner, project.id, {
        action: "addUser",
        email: email(viewer),
        role: "viewer",
      }),
    );
    const group = await createGroup([{ userId: grouped }, { userId: viewer }]);
    const admin = await createUser("admin");
    // An admin may grant to any group, but only as the project's owner would: not theirs.
    expect(
      failureOf(
        await exit(
          Effect.flatMap(ProjectService, (s) =>
            s.changeMembers(admin, project.id, {
              action: "addGroup",
              groupId: group,
              role: "viewer",
            }),
          ),
        ),
      ),
    ).toMatchObject({ _tag: "ProjectNotAvailable", projectId: project.id });
    await db((d) =>
      d.insert(groupMembers).values({ groupId: group, userId: owner, shareProjects: true }),
    );
    await projects((s) =>
      s.changeMembers(owner, project.id, { action: "addGroup", groupId: group, role: "editor" }),
    );

    expect(await role(owner, project.id)).toBe("owner");
    expect(await role(editor, project.id)).toBe("editor");
    expect(await role(grouped, project.id)).toBe("editor");
    // Roles add up: the group's editor outranks the direct viewer membership.
    expect(await role(viewer, project.id)).toBe("editor");
    expect(await role(stranger, project.id)).toBeNull();
    expect((await projects((s) => s.list(stranger))).map((p) => p.id)).not.toContain(project.id);
    expect((await projects((s) => s.list(grouped))).map((p) => p.id)).toContain(project.id);
    // Hints reach everyone in it, including through the group.
    expect(events.some((e) => e.userId === grouped && e.event.type === "project.changed")).toBe(
      true,
    );
  });

  it("refuses a group grant from an owner without that group's sharing right", async () => {
    const owner = await createUser();
    const project = await newProject(owner);
    const group = await createGroup([{ userId: owner, shareProjects: false }]);
    const result = await exit(
      Effect.flatMap(ProjectService, (s) =>
        s.changeMembers(owner, project.id, { action: "addGroup", groupId: group, role: "viewer" }),
      ),
    );
    expect(result).toMatchObject({ _tag: "Failure" });
    expect((await projects((s) => s.members(owner, project.id))).eligibleGroups).toEqual([]);
  });

  it("shares a project with at most as many groups as it may have members", async () => {
    const owner = await createUser();
    const project = await newProject(owner);
    const ids = Array.from({ length: PROJECT_LIMITS.members + 1 }, () => uuidv7());
    await db((d) => d.insert(groups).values(ids.map((id) => ({ id, name: `Group ${id}` }))));
    await db((d) =>
      d
        .insert(groupMembers)
        .values(ids.map((groupId) => ({ groupId, userId: owner, shareProjects: true }))),
    );
    await db((d) =>
      d.insert(projectGroupGrants).values(
        ids.slice(0, PROJECT_LIMITS.members).map((groupId) => ({
          projectId: project.id,
          groupId,
          role: "viewer" as const,
        })),
      ),
    );
    const grant = (groupId: string, given: "viewer" | "editor") =>
      run(
        Effect.match(
          Effect.flatMap(ProjectService, (s) =>
            s.changeMembers(owner, project.id, { action: "addGroup", groupId, role: given }),
          ),
          { onSuccess: () => "granted", onFailure: (error) => error._tag },
        ),
      );
    // One more is refused; changing the role of one already there is not.
    expect(await grant(ids.at(-1)!, "viewer")).toBe("ProjectRejected");
    expect(await grant(ids[0]!, "editor")).toBe("granted");
  });

  it("lets only the owner manage members, and anyone leave", async () => {
    const owner = await createUser();
    const editor = await createUser();
    const other = await createUser();
    const project = await newProject(owner);
    await projects((s) =>
      s.changeMembers(owner, project.id, {
        action: "addUser",
        email: email(editor),
        role: "editor",
      }),
    );
    const byEditor = await exit(
      Effect.flatMap(ProjectService, (s) =>
        s.changeMembers(editor, project.id, {
          action: "addUser",
          email: email(other),
          role: "viewer",
        }),
      ),
    );
    expect(failureOf(byEditor)).toMatchObject({
      _tag: "ProjectRejected",
      reason: "only the project's owner can do that",
    });
    await projects((s) =>
      s.changeMembers(editor, project.id, { action: "removeUser", userId: editor }),
    );
    expect(await role(editor, project.id)).toBeNull();
  });

  it("adds only accounts that may use the app, refusing pending, turned-down and banned ones", async () => {
    const owner = await createUser();
    const project = await newProject(owner);
    const add = (id: string) =>
      run(
        Effect.match(
          Effect.flatMap(ProjectService, (s) =>
            s.changeMembers(owner, project.id, {
              action: "addUser",
              email: email(id),
              role: "viewer",
            }),
          ),
          { onSuccess: () => "added", onFailure: (error) => error._tag },
        ),
      );
    const pending = await createUser();
    await db((d) =>
      d.update(userApprovals).set({ status: "pending" }).where(eq(userApprovals.userId, pending)),
    );
    const rejected = await createUser();
    await db((d) =>
      d.update(userApprovals).set({ status: "rejected" }).where(eq(userApprovals.userId, rejected)),
    );
    const banned = await createUser();
    await db((d) => d.update(user).set({ banned: true }).where(eq(user.id, banned)));
    const active = await createUser();
    expect({
      pending: await add(pending),
      rejected: await add(rejected),
      banned: await add(banned),
      active: await add(active),
    }).toEqual({
      pending: "ProjectRejected",
      rejected: "ProjectRejected",
      banned: "ProjectRejected",
      active: "added",
    });
    expect(await role(pending, project.id)).toBeNull();
  });

  it("suspends a project for everyone once its owner loses the right to create projects", async () => {
    const owner = await createUser();
    const member = await createUser();
    const project = await newProject(owner);
    await projects((s) =>
      s.changeMembers(owner, project.id, {
        action: "addUser",
        email: email(member),
        role: "viewer",
      }),
    );
    const group = await createGroup([{ userId: owner }]);
    await db((d) =>
      d
        .update(groups)
        .set({ capabilities: { ...ALL_CAPABILITIES, projectsCreate: false } })
        .where(eq(groups.id, group)),
    );
    expect(await role(owner, project.id)).toBeNull();
    expect(await role(member, project.id)).toBeNull();
    await db((d) =>
      d.update(groups).set({ capabilities: ALL_CAPABILITIES }).where(eq(groups.id, group)),
    );
    expect(await role(member, project.id)).toBe("viewer");
    // Untouched, but keeps the default row honest for other tests.
    expect((await db((d) => d.select().from(defaultCapabilities))).length).toBe(1);
  });
});

describe("what each role may change", () => {
  /** A fresh project with one member of each role, so no check sees another's change. */
  const setUp = async () => {
    const owner = await createUser();
    const editor = await createUser();
    const viewer = await createUser();
    const stranger = await createUser();
    const project = await newProject(owner);
    for (const [id, given] of [
      [editor, "editor"],
      [viewer, "viewer"],
    ] as const)
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two members, in order.
      await projects((s) =>
        s.changeMembers(owner, project.id, { action: "addUser", email: email(id), role: given }),
      );
    const fact = await memory((s) => s.add(owner, project.id, "Ships in May."));
    return { actors: { owner, editor, viewer, stranger }, owner, editor, viewer, project, fact };
  };
  type Fixture = Awaited<ReturnType<typeof setUp>>;
  const outcome = <E extends { readonly _tag: string }>(
    effect: Effect.Effect<unknown, E, Services>,
  ) => run(Effect.match(effect, { onSuccess: () => "ok", onFailure: (error) => error._tag }));
  const rejected = "ProjectRejected";
  const hidden = "ProjectNotAvailable";
  const cases: ReadonlyArray<{
    name: string;
    change: (
      actor: string,
      fixture: Fixture,
    ) => Effect.Effect<unknown, { readonly _tag: string }, Services>;
    expected: Record<"owner" | "editor" | "viewer" | "stranger", string>;
  }> = [
    {
      name: "rename it and change its instructions",
      change: (actor, { project }) =>
        Effect.flatMap(ProjectService, (s) =>
          s.update(actor, { projectId: project.id, name: "Renamed", instructions: "Shout." }),
        ),
      expected: { owner: "ok", editor: "ok", viewer: rejected, stranger: hidden },
    },
    {
      name: "delete it",
      change: (actor, { project }) =>
        Effect.flatMap(ProjectService, (s) => s.remove(actor, project.id)),
      expected: { owner: "ok", editor: hidden, viewer: hidden, stranger: hidden },
    },
    {
      name: "add a member",
      change: (actor, { project }) =>
        Effect.gen(function* () {
          const added = yield* Effect.promise(() => createUser());
          yield* Effect.flatMap(ProjectService, (s) =>
            s.changeMembers(actor, project.id, {
              action: "addUser",
              email: email(added),
              role: "editor",
            }),
          );
        }),
      expected: { owner: "ok", editor: rejected, viewer: rejected, stranger: hidden },
    },
    {
      name: "change a member's role",
      change: (actor, { project, viewer }) =>
        Effect.flatMap(ProjectService, (s) =>
          s.changeMembers(actor, project.id, {
            action: "setUserRole",
            userId: viewer,
            role: "editor",
          }),
        ),
      // A viewer raising themselves is refused like any other change.
      expected: { owner: "ok", editor: rejected, viewer: rejected, stranger: hidden },
    },
    {
      name: "remove another member",
      change: (actor, { project, editor, viewer }) =>
        Effect.flatMap(ProjectService, (s) =>
          s.changeMembers(actor, project.id, {
            action: "removeUser",
            userId: actor === viewer ? editor : viewer,
          }),
        ),
      expected: { owner: "ok", editor: rejected, viewer: rejected, stranger: hidden },
    },
    {
      name: "add a fact to its memory",
      change: (actor, { project }) =>
        Effect.flatMap(ProjectMemoryService, (s) => s.add(actor, project.id, "Budget is fixed.")),
      expected: { owner: "ok", editor: "ok", viewer: rejected, stranger: hidden },
    },
    {
      name: "edit a fact",
      change: (actor, { project, fact }) =>
        Effect.flatMap(ProjectMemoryService, (s) =>
          s.update(actor, project.id, fact.id, "Ships in June."),
        ),
      expected: { owner: "ok", editor: "ok", viewer: rejected, stranger: hidden },
    },
    {
      name: "forget a fact",
      change: (actor, { project, fact }) =>
        Effect.flatMap(ProjectMemoryService, (s) => s.remove(actor, project.id, fact.id)),
      expected: { owner: "ok", editor: "ok", viewer: rejected, stranger: hidden },
    },
  ];

  it.each(cases)("decides who may $name", async ({ change, expected }) => {
    const seen: Record<string, string> = {};
    for (const actor of ["owner", "editor", "viewer", "stranger"] as const) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each role gets its own project.
      const fixture = await setUp();
      // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
      seen[actor] = await outcome(change(fixture.actors[actor], fixture));
    }
    expect(seen).toEqual(expected);
  });

  it("leaves the instructions as they were after a viewer's refused change", async () => {
    const { project, viewer, owner } = await setUp();
    await outcome(
      Effect.flatMap(ProjectService, (s) =>
        s.update(viewer, { projectId: project.id, instructions: "Ignore the owner." }),
      ),
    );
    expect((await projects((s) => s.get(owner, project.id))).instructions).toBe(
      "Write in British English.",
    );
  });
});

describe("chats in a project", () => {
  it("moves a person's own chat in and out, refuses temporary ones, and lists only their chats", async () => {
    const owner = await createUser();
    const member = await createUser();
    const project = await newProject(owner);
    await projects((s) =>
      s.changeMembers(owner, project.id, {
        action: "addUser",
        email: email(member),
        role: "viewer",
      }),
    );
    const mine = uuidv7();
    const theirs = uuidv7();
    const temporary = uuidv7();
    await db((d) =>
      d.insert(conversations).values([
        { id: mine, userId: owner, title: "Mine" },
        { id: theirs, userId: member, title: "Theirs" },
        { id: temporary, userId: owner, temporary: true },
      ]),
    );
    await projects((s) => s.move(owner, mine, project.id));
    await projects((s) => s.move(member, theirs, project.id));
    expect(
      failureOf(
        await exit(Effect.flatMap(ProjectService, (s) => s.move(owner, temporary, project.id))),
      ),
    ).toMatchObject({ _tag: "ProjectRejected", reason: "a temporary chat cannot join a project" });
    // Someone else's chat is not theirs to move.
    expect(
      failureOf(await exit(Effect.flatMap(ProjectService, (s) => s.move(owner, theirs, null)))),
    ).toMatchObject({ _tag: "ProjectRejected", reason: "that chat is not available" });
    expect((await projects((s) => s.chats(owner, project.id))).map((c) => c.id)).toEqual([mine]);
    expect((await projects((s) => s.chats(member, project.id))).map((c) => c.id)).toEqual([theirs]);
    await projects((s) => s.move(owner, mine, null));
    expect(await projects((s) => s.chats(owner, project.id))).toEqual([]);
  });

  it("resolves the project for an attempt only while the person may use it", async () => {
    const owner = await createUser();
    const member = await createUser();
    const project = await newProject(owner);
    await projects((s) =>
      s.changeMembers(owner, project.id, {
        action: "addUser",
        email: email(member),
        role: "viewer",
      }),
    );
    const resolved = await db((d) => resolveProject(d, member, project.id));
    expect(resolved).toEqual({
      id: project.id,
      name: "Launch",
      instructions: "Write in British English.",
      role: "viewer",
    });
    await projects((s) =>
      s.changeMembers(owner, project.id, { action: "removeUser", userId: member }),
    );
    expect(await db((d) => Effect.flip(resolveProject(d, member, project.id)))).toMatchObject({
      _tag: "ProjectNotAvailable",
    });
  });

  it("turns its chats back into ordinary chats and drops its documents and memory when deleted", async () => {
    const owner = await createUser();
    const project = await newProject(owner);
    const chat = uuidv7();
    await db((d) => d.insert(conversations).values({ id: chat, userId: owner }));
    await projects((s) => s.move(owner, chat, project.id));
    const document = await docs((s) =>
      s.create(owner, { projectId: project.id, title: "Plan", content: "- [ ] ship", by: "user" }),
    );
    await memory((s) => s.add(owner, project.id, "Launch date is 3 March."));
    await projects((s) => s.remove(owner, project.id));
    const [row] = await db((d) => d.select().from(conversations).where(eq(conversations.id, chat)));
    expect(row!.projectId).toBeNull();
    expect(
      await db((d) => d.select().from(documents).where(eq(documents.id, document.document.id))),
    ).toEqual([]);
    expect(
      await db((d) =>
        d.select().from(projectMemories).where(eq(projectMemories.projectId, project.id)),
      ),
    ).toEqual([]);
  });
});

describe("project documents", () => {
  it("keeps each editor's collab id theirs, and the server's ids its own", async () => {
    const owner = await createUser();
    const editor = await createUser();
    const project = await newProject(owner);
    await projects((s) =>
      s.changeMembers(owner, project.id, {
        action: "addUser",
        email: email(editor),
        role: "editor",
      }),
    );
    const { document } = await docs((s) =>
      s.create(owner, { projectId: project.id, title: "Plan", content: "- [ ] ship", by: "user" }),
    );
    const ownerEditor = (await openEditor(owner, document.id))!;
    await ownerEditor.type((markdown) => `${markdown}\n- [ ] announce`);
    // Another member under the owner's id, then the model's: each is still theirs alone.
    for (const [taken, line] of [
      [ownerEditor.clientId, "review"],
      ["model", "invoice"],
    ] as const) {
      // Level with the server, so the impostor's step is the next the owner hears.
      // oxlint-disable-next-line eslint/no-await-in-loop -- One impostor at a time.
      await ownerEditor.catchUp();
      const before = ownerEditor.heard().length;
      // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
      const impostor = (await collabEditor(run, editor, document.id, taken))!;
      // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
      await impostor.type((markdown) => `${markdown}\n- [ ] ${line}`);
      // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
      await ownerEditor.catchUp();
      // Taken as the owner's own step, the line would never reach the owner's editor.
      expect(ownerEditor.markdown()).toContain(line);
      expect(ownerEditor.heard().slice(before)).not.toContain(taken);
    }
    expect(ownerEditor.markdown()).toBe(await markdownOf(owner, document.id));
  });

  it("lets editors write together and viewers read, move a cursor, but never change the text", async () => {
    const owner = await createUser();
    const editor = await createUser();
    const viewer = await createUser();
    const stranger = await createUser();
    const project = await newProject(owner);
    await projects((s) =>
      s.changeMembers(owner, project.id, {
        action: "addUser",
        email: email(editor),
        role: "editor",
      }),
    );
    await projects((s) =>
      s.changeMembers(owner, project.id, {
        action: "addUser",
        email: email(viewer),
        role: "viewer",
      }),
    );
    const { document } = await docs((s) =>
      s.create(owner, { projectId: project.id, title: "Plan", content: "- [ ] ship", by: "user" }),
    );
    expect(document).toMatchObject({ projectId: project.id, conversationId: null, canEdit: true });
    expect((await docs((s) => s.get(viewer, document.id)))!.canEdit).toBe(false);
    expect(await docs((s) => s.get(stranger, document.id))).toBeNull();
    expect(await openEditor(stranger, document.id)).toBeNull();

    const ownerEditor = (await openEditor(owner, document.id))!;
    const editorEditor = (await openEditor(editor, document.id))!;
    await Promise.all([
      ownerEditor.type((markdown) => `${markdown}\n- [ ] announce`),
      editorEditor.type((markdown) => `# Plan\n\n${markdown}`),
    ]);
    const stored = await markdownOf(viewer, document.id);
    expect(stored).toBe("# Plan\n\n- [ ] ship\n- [ ] announce");

    const viewerEditor = (await openEditor(viewer, document.id))!;
    expect(viewerEditor.markdown()).toBe(stored);
    await expect(viewerEditor.type((markdown) => `sneaky ${markdown}`)).rejects.toMatchObject({
      _tag: "DocumentRejected",
    });
    expect(await markdownOf(owner, document.id)).toBe(stored);
    // Every member hears of the change, not only the writer.
    expect(
      events.some(
        (e) =>
          e.userId === viewer &&
          e.event.type === "document.changed" &&
          e.event.projectId === project.id,
      ),
    ).toBe(true);

    // Renaming is editing: an editor may, a viewer or stranger may not.
    await expect(docs((s) => s.rename(viewer, document.id, "Viewer's"))).rejects.toMatchObject({
      _tag: "DocumentRejected",
    });
    await expect(docs((s) => s.rename(stranger, document.id, "Mine"))).rejects.toMatchObject({
      _tag: "DocumentNotAvailable",
    });
    const renamed = await docs((s) => s.rename(editor, document.id, "Launch plan"));
    expect(renamed.title).toBe("Launch plan");
    expect((await docs((s) => s.get(viewer, document.id)))!.title).toBe("Launch plan");
    // The text is untouched by a rename.
    expect(await markdownOf(owner, document.id)).toBe(stored);

    await expect(docs((s) => s.remove(viewer, document.id))).rejects.toMatchObject({
      _tag: "DocumentRejected",
    });
    await docs((s) => s.remove(editor, document.id));
    expect(await docs((s) => s.list(owner, { projectId: project.id }))).toEqual([]);
  });
});

describe("project memory", () => {
  it("keeps facts for the project, deduplicated, and only editors change them", async () => {
    const owner = await createUser();
    const viewer = await createUser();
    const project = await newProject(owner);
    await projects((s) =>
      s.changeMembers(owner, project.id, {
        action: "addUser",
        email: email(viewer),
        role: "viewer",
      }),
    );
    const added = await memory((s) => s.add(owner, project.id, "We ship on Tuesdays."));
    expect(added).toMatchObject({ content: "We ship on Tuesdays.", origin: "manual" });
    expect((await memory((s) => s.list(viewer, project.id))).map((m) => m.content)).toEqual([
      "We ship on Tuesdays.",
    ]);
    await expect(
      memory((s) => s.add(viewer, project.id, "Viewers cannot write")),
    ).rejects.toMatchObject({
      _tag: "ProjectRejected",
    });
    const chat = uuidv7();
    await db((d) => d.insert(conversations).values({ id: chat, userId: owner }));
    expect(
      await memory((s) =>
        s.saveModel(
          owner,
          {
            projectId: project.id,
            content: "we ship on tuesdays",
            sourceConversationId: chat,
          },
          () => Effect.void,
        ),
      ),
    ).toEqual({ outcome: "unchanged" });
    expect(
      await memory((s) =>
        s.saveModel(
          viewer,
          {
            projectId: project.id,
            content: "The logo is blue.",
            sourceConversationId: chat,
          },
          () => Effect.void,
        ),
      ),
    ).toEqual({ outcome: "rejected", reason: "read_only" });
    expect(
      await memory((s) =>
        s.saveModel(
          owner,
          {
            projectId: project.id,
            content: "My card is 4111 1111 1111 1111",
            sourceConversationId: chat,
          },
          () => Effect.void,
        ),
      ),
    ).toEqual({ outcome: "rejected", reason: "sensitive" });
    expect(
      await memory((s) =>
        s.saveModel(
          owner,
          {
            projectId: project.id,
            content: "The logo is blue.",
            sourceConversationId: chat,
          },
          () => Effect.void,
        ),
      ),
    ).toEqual({ outcome: "created" });
    await memory((s) => s.update(owner, project.id, added.id, "We ship on Wednesdays."));
    await memory((s) => s.remove(owner, project.id, added.id));
    expect((await memory((s) => s.list(owner, project.id))).map((m) => m.content)).toEqual([
      "The logo is blue.",
    ]);
  });
});
