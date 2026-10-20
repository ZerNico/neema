import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { LookupAllOptions } from "node:dns";
import type { AddressInfo } from "node:net";
import { PgClient } from "@effect/sql-pg";
import {
  acceptedContent,
  createMcpHandler,
  fromJsonSchema,
  inputRequired,
  McpServer,
} from "@modelcontextprotocol/server";
import { eq, sql } from "drizzle-orm";
import { Cause, Effect, Exit, Fiber, Layer, ManagedRuntime, Redacted } from "effect";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  conversations,
  defaultCapabilities,
  integrationToolListings,
  user,
  userApprovals,
} from "~/db/schema/index.ts";
import type { ToolAccess } from "~/modules/integrations/manifest.ts";
import { mcpAdapter } from "~/modules/integrations/mcp/server/adapter.ts";
import { IntegrationApprovals } from "~/modules/integrations/server/approvals.ts";
import { IntegrationRepo } from "~/modules/integrations/server/repo.ts";
import { IntegrationService } from "~/modules/integrations/server/service.ts";
import { prepareIntegrationTools } from "~/modules/integrations/server/tools.ts";
import type { IntegrationModelResult } from "~/modules/integrations/tool-schema.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { createSourceIndexer } from "~/modules/tools/server/source-indexer.ts";
import { Db } from "~/server/db.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 5).toString("base64");

type Services = Db | KeyCipher | IntegrationRepo | IntegrationService | IntegrationApprovals;

let database: TestDatabase;
let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>;
// Names a person's own server may use: each resolves to the address given, and a
// public one is answered by the local test server. The address checks stay real.
const { names } = vi.hoisted(() => ({
  names: new Map<string, { address: string; forwardTo?: string; requests: number }>(),
}));
vi.mock("node:dns/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:dns/promises")>();
  // The one form url-safety asks in: every address of a name.
  const lookup = async (hostname: string, options: LookupAllOptions) => {
    const named = names.get(hostname);
    return named ? [{ address: named.address, family: 4 }] : real.lookup(hostname, options);
  };
  return { ...real, lookup };
});
vi.mock("~/modules/tools/server/url-safety.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("~/modules/tools/server/url-safety.ts")>();
  return {
    ...real,
    fetchPinned: (target: { url: URL }, init?: RequestInit) => {
      const named = names.get(target.url.hostname);
      if (!named?.forwardTo) return real.fetchPinned(target as never, init);
      named.requests++;
      const local = new URL(`${target.url.pathname}${target.url.search}`, named.forwardTo);
      return fetch(local, { ...init, redirect: "manual" });
    },
  };
});

const run = <A, E>(effect: Effect.Effect<A, E, Services>) => runtime.runPromise(effect);

/** Runs `f` with the person's account on an integration: their first, the one most tests connect. */
const on = <A, E, R>(
  userId: string,
  integrationId: string,
  f: (connectionId: string) => Effect.Effect<A, E, R>,
) =>
  Effect.flatMap(IntegrationRepo, (repo) => repo.listForUser(userId)).pipe(
    Effect.flatMap((rows) =>
      f(rows.find((row) => row.config.id === integrationId)?.connections[0]?.id ?? "no-account"),
    ),
  );

/** What the test server describes `search` as; a test changes it to make the tool drift. */
let searchDescription = "Search the docs.";
let deleteDescription = "Delete a page.";
/** A tool the server adds for everyone when set, claiming nothing about itself. */
let addedTool: string | null = null;
const deleted: string[] = [];

/** What every account is listed; the `editor` token also sees `drafts`. */
const ALL = ["search", "delete_page", "release", "provision"];
const EDITOR_TOKEN = "editor";

const buildServer = (context: { requestInfo?: Request | undefined }) => {
  const server = new McpServer({ name: "docs", version: "1.0.0" });
  server.registerTool(
    "search",
    {
      description: searchDescription,
      annotations: { readOnlyHint: true },
      inputSchema: fromJsonSchema<{ q: string }>({
        type: "object",
        properties: { q: { type: "string" } },
        required: ["q"],
      }),
    },
    async ({ q }) => ({ content: [{ type: "text", text: `Results for ${q}.` }] }),
  );
  server.registerTool(
    "delete_page",
    {
      description: deleteDescription,
      inputSchema: fromJsonSchema<{ id: string }>({
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      }),
    },
    async ({ id }) => {
      deleted.push(id);
      return { content: [{ type: "text", text: `Deleted ${id}.` }] };
    },
  );
  const confirmation = fromJsonSchema<{ name: string }>({
    type: "object",
    properties: { name: { type: "string", title: "Release name" } },
    required: ["name"],
  });
  server.registerTool(
    "release",
    { description: "Cut a release.", annotations: { destructiveHint: false } },
    async (ctx) => {
      const answer = acceptedContent(ctx.mcpReq.inputResponses, "name", confirmation);
      if (!answer)
        return inputRequired({
          inputRequests: {
            name: inputRequired.elicit({
              message: "Name this release.",
              requestedSchema: confirmation,
            }),
          },
        });
      return { content: [{ type: "text", text: `Released ${answer.name}.` }] };
    },
  );
  const region = fromJsonSchema<{ region: string }>({
    type: "object",
    properties: { region: { type: "string", title: "Region" } },
    required: ["region"],
  });
  server.registerTool(
    "provision",
    { description: "Set up an environment.", annotations: { destructiveHint: false } },
    async (ctx) => {
      const named = acceptedContent(ctx.mcpReq.inputResponses, "name", confirmation);
      const placed = acceptedContent(ctx.mcpReq.inputResponses, "region", region);
      if (!named || !placed)
        return inputRequired({
          inputRequests: {
            name: inputRequired.elicit({ message: "Name it.", requestedSchema: confirmation }),
            region: inputRequired.elicit({ message: "Where?", requestedSchema: region }),
          },
        });
      return { content: [{ type: "text", text: `${named.name} in ${placed.region}.` }] };
    },
  );
  // Listed per account, as a server scoping its tools to who signed in would.
  if (context.requestInfo?.headers.get("authorization") === `Bearer ${EDITOR_TOKEN}`)
    server.registerTool(
      "drafts",
      { description: "List the drafts.", annotations: { readOnlyHint: true } },
      async () => ({ content: [{ type: "text", text: "Two drafts." }] }),
    );
  if (addedTool)
    server.registerTool(addedTool, { description: "Added later." }, async () => ({
      content: [{ type: "text", text: "Done." }],
    }));
  return server;
};

const handler = createMcpHandler(buildServer);
let server: Server;
let base: string;

/**
 * Holds the next `tools/list` answer, already built, until released: a
 * check that started before the server changed and finishes after.
 */
let heldListing: { reached: () => void; release: Promise<void> } | null = null;
const holdNextListing = () => {
  let reached!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>((resolve) => (reached = resolve));
  heldListing = { reached, release: new Promise<void>((resolve) => (release = resolve)) };
  return { arrived, release };
};

/** Runs before `/refusing` turns a call away, to land something while it is in flight. */
let beforeRefusal: (() => Promise<void>) | null = null;

/** Shared-key requests must carry the admin's key; everything else is open. */
const serve = async (request: IncomingMessage, response: ServerResponse) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  const body = Buffer.concat(chunks).toString("utf8");
  if (url.pathname === "/keyed" && request.headers["x-api-key"] !== "admin-key") {
    response.writeHead(401).end();
    return;
  }
  // Lists for anyone, then refuses every call's credential, as a revoked token would.
  if (url.pathname === "/refusing" && body.includes('"tools/call"')) {
    const hook = beforeRefusal;
    beforeRefusal = null;
    if (hook) await hook();
    response.writeHead(401).end();
    return;
  }
  // Signed in, but calls need a scope the sign-in did not grant.
  if (url.pathname === "/scoped" && body.includes('"tools/call"')) {
    response
      .writeHead(403, {
        "www-authenticate": 'Bearer error="insufficient_scope", scope="docs:read docs:write"',
      })
      .end();
    return;
  }
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers))
    if (typeof value === "string") headers.set(key, value);
  const reply = await handler.fetch(
    new Request(url, { method: request.method ?? "GET", headers, ...(body ? { body } : {}) }),
  );
  const held = body.includes('"tools/list"') ? heldListing : null;
  if (held) {
    heldListing = null;
    held.reached();
    await held.release;
  }
  response.writeHead(reply.status, Object.fromEntries(reply.headers));
  if (reply.body) for await (const chunk of reply.body) response.write(chunk);
  response.end();
};

beforeAll(async () => {
  server = createServer((request, response) => void serve(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  database = await createTestDatabase();
  const Infra = Layer.mergeAll(Db.layer, KeyCipher.layer).pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(database.url), maxConnections: 8 })),
  );
  const Base = Layer.mergeAll(IntegrationRepo.layer, SyncBus.layer).pipe(Layer.provideMerge(Infra));
  runtime = ManagedRuntime.make(
    Layer.mergeAll(IntegrationService.layer, IntegrationApprovals.layer).pipe(
      Layer.provideMerge(Base),
    ),
  );
});

afterAll(async () => {
  await runtime?.dispose();
  await database?.drop();
  await handler.close();
  await new Promise((resolve) => server.close(resolve));
});

/** Saves a connection under the integration's current revision, as a sign-in that just began would. */
const saveAtCurrent = (
  repo: IntegrationRepo["Service"],
  input: Omit<Parameters<IntegrationRepo["Service"]["saveConnection"]>[0], "revision">,
) =>
  repo.getConfig(input.integrationId).pipe(
    Effect.flatMap((row) => repo.saveConnection({ ...input, revision: row!.revision })),
    Effect.flatMap((saved) => (saved ? Effect.succeed(saved) : Effect.die("setup moved"))),
  );

/** An approved account, as anyone using integrations has. */
const newUser = () =>
  run(
    Effect.gen(function* () {
      const id = uuidv7();
      const db = yield* Db;
      yield* db.insert(user).values({ id, name: "Ada", email: `${id}@t.io` });
      yield* db.insert(userApprovals).values({ userId: id, status: "approved" });
      return id;
    }),
  );

const newConversation = (userId: string) =>
  run(
    Effect.gen(function* () {
      const id = uuidv7();
      yield* (yield* Db).insert(conversations).values({ id, userId });
      return id;
    }),
  );

/** An MCP integration as an admin sets it up; returns its id. */
const setUp = (name: string, config: Record<string, string>, sharedKey?: string) =>
  run(
    Effect.gen(function* () {
      const service = yield* IntegrationService;
      const created = yield* service.createIntegration({ kind: "mcp", name });
      yield* service.saveConfig({
        id: created.id,
        name,
        enabled: true,
        config,
        oauthClientId: "",
        allowApiKeys: true,
        ...(sharedKey ? { sharedCredential: { token: sharedKey } } : {}),
      });
      return created.id;
    }),
  );

const checkTools = (adminId: string, integrationId: string) =>
  run(Effect.flatMap(IntegrationService, (s) => s.checkTools(adminId, integrationId)));

const setTool = (
  integrationId: string,
  tool: string,
  setting: { off: boolean; access: ToolAccess | null },
) => run(Effect.flatMap(IntegrationService, (s) => s.setTool(integrationId, tool, setting)));

const connectToken = (userId: string, integrationId: string, token: string, account?: string) =>
  run(
    Effect.flatMap(IntegrationService, (s) =>
      s.connectApiKey(userId, integrationId, { token }, account),
    ),
  );

const connectOpen = (userId: string, integrationId: string) =>
  run(Effect.flatMap(IntegrationService, (s) => s.connectOpen(userId, integrationId)));

/** A person's accounts on one integration, oldest first. */
const accountsOf = (userId: string, integrationId: string) =>
  run(Effect.flatMap(IntegrationService, (s) => s.listForUser(userId))).then(
    (rows) => rows.find((row) => row.id === integrationId)?.connections ?? [],
  );

const listingsOf = (integrationId: string) =>
  run(Effect.flatMap(IntegrationRepo, (repo) => repo.toolListings(integrationId)));

/** Makes this integration's listings due and every other one not, so a sweep takes only these. */
const makeDue = (integrationId: string) =>
  run(
    Effect.flatMap(Db, (db) =>
      db
        .update(integrationToolListings)
        .set({
          nextCheckAt: sql`case when ${integrationToolListings.integrationId} = ${integrationId} then now() - interval '1 minute' else now() + interval '1 day' end`,
        })
        .pipe(Effect.orDie),
    ),
  );

/** One integration's offered tools: one turned on for everyone in an earlier test is offered too. */
const offeredNames = (userId: string, conversationId: string, integrationId: string) =>
  run(
    Effect.flatMap(IntegrationService, (s) =>
      s.resolveOffer({ userId, conversationId, grants: null }),
    ),
  ).then((offers) =>
    offers
      .filter((offer) => offer.integrationId === integrationId)
      .flatMap((offer) => offer.session.tools.map((tool) => tool.name)),
  );

/** The prepared tools for one person's chat, as a generation builds them. */
const toolsFor = (
  userId: string,
  conversationId: string,
  unattended = false,
  /** Counts permission reads, to know how far calls have got without sleeping. */
  reads = { permissions: 0 },
) =>
  run(
    Effect.gen(function* () {
      const service = yield* IntegrationService;
      const approvals = yield* IntegrationApprovals;
      const offered = (yield* service.resolveOffer({ userId, conversationId, grants: null })).map(
        (offer) =>
          unattended
            ? { ...offer, unattended: { access: "write" as const, allowances: {} } }
            : offer,
      );
      return prepareIntegrationTools({
        offered,
        indexer: createSourceIndexer([]),
        approvals,
        owner: { userId, conversationId, messageId: "answer" },
        permissionsFor: (connectionId) =>
          Effect.sync(() => void reads.permissions++).pipe(
            Effect.andThen(service.permissionsFor(userId, conversationId, connectionId)),
          ),
        sessionFor: (connectionId) =>
          service.session(userId, connectionId).pipe(Effect.orElseSucceed(() => null)),
        // One durable row per provider call, as the stream observer mints it.
        rowIdFor: (providerCallId) => Effect.succeed(`row-${providerCallId}-${conversationId}`),
        reportAuthFailure: (_session, failure) => service.reportAuthFailure({ userId, failure }),
        reportMissingScopes: (session, scopes) =>
          service.reportMissingScopes(
            { userId, connectionId: session.connectionId, accountEpoch: session.accountEpoch },
            scopes,
          ),
        allowanceUses: { reserve: () => Effect.succeed(true), release: () => Effect.void },
      });
    }),
  );

type Handler = (
  args: unknown,
  context: { toolCallId: string },
) => Effect.Effect<IntegrationModelResult>;
const handlerOf = (prepared: Awaited<ReturnType<typeof toolsFor>>, name: string) =>
  prepared?.group.handlers[name] as Handler | undefined;

const waitForPending = (userId: string) =>
  Effect.flatMap(IntegrationApprovals, (approvals) => approvals.pending(userId)).pipe(
    Effect.repeat({ until: (pending) => pending.length > 0 }),
  );

describe("an MCP server set up by an admin", () => {
  it("offers everything an open server lists as soon as it is saved, at the access each claims", async () => {
    const admin = await newUser();
    const id = await setUp("Docs", { url: `${base}/mcp`, ways: "anonymous", anonymous: "open" });
    const listed = await run(Effect.flatMap(IntegrationService, (s) => s.listForUser(admin)));
    expect(listed.find((row) => row.id === id)).toMatchObject({
      available: true,
      methods: { oauth: false, apiKey: false, open: "none" },
      tools: [
        { name: "search", access: "read" },
        { name: "delete_page", access: "destructive" },
        { name: "release", access: "write" },
        { name: "provision", access: "write" },
      ],
    });
    const view = (await run(Effect.flatMap(IntegrationService, (s) => s.adminList()))).find(
      (row) => row.id === id,
    );
    expect(view).toMatchObject({ listings: { failing: 0, error: null } });
    expect(view?.tools).toHaveLength(4);
    // Nothing on the server says what delete_page does, so it is taken as the most dangerous.
    expect(view?.tools.find((tool) => tool.name === "delete_page")).toMatchObject({
      access: "destructive",
      claimed: "destructive",
      off: false,
    });

    await connectOpen(admin, id);
    const conversationId = await newConversation(admin);
    expect(await offeredNames(admin, conversationId, id)).toEqual(ALL);
  });

  it("offers a tool as the server changed or added it after the next listing, unasked", async () => {
    const admin = await newUser();
    const id = await setUp("Docs drift", {
      url: `${base}/mcp`,
      ways: "anonymous",
      anonymous: "open",
    });
    await connectOpen(admin, id);
    const conversationId = await newConversation(admin);
    expect(await offeredNames(admin, conversationId, id)).toEqual(ALL);

    searchDescription = "Search the docs, now with filters.";
    addedTool = "archive";
    try {
      // The background sweep, not the admin, notices.
      await makeDue(id);
      await run(Effect.flatMap(IntegrationService, (s) => s.checkDueListings()));
      expect(await offeredNames(admin, conversationId, id)).toEqual([...ALL, "archive"]);
      const prepared = await toolsFor(admin, conversationId);
      expect(prepared?.names.get(`int_${id}__search`)?.tool.description).toBe(
        "Search the docs, now with filters.",
      );
      // Claiming nothing, the new tool asks every time and never runs unattended.
      expect(prepared?.names.get(`int_${id}__archive`)?.tool.access).toBe("destructive");
      const unattended = await toolsFor(admin, conversationId, true);
      const result = await run(
        handlerOf(unattended, `int_${id}__archive`)!({}, { toolCallId: "added" }),
      );
      expect(result).toMatchObject({ ok: false });
      expect(JSON.stringify(result)).not.toContain("Done.");
    } finally {
      searchDescription = "Search the docs.";
      addedTool = null;
    }
  });

  it("offers each account what the server lists to it, and lists an open server once for all", async () => {
    const editor = await newUser();
    const reader = await newUser();
    const id = await setUp("Docs per account", { url: `${base}/mcp`, ways: "token" });
    await connectToken(editor, id, EDITOR_TOKEN);
    await connectToken(reader, id, "reader");
    expect(await offeredNames(editor, await newConversation(editor), id)).toEqual([
      ...ALL,
      "drafts",
    ]);
    expect(await offeredNames(reader, await newConversation(reader), id)).toEqual(ALL);
    // The admin sees every tool any account was listed, once each.
    const view = (await run(Effect.flatMap(IntegrationService, (s) => s.adminList()))).find(
      (row) => row.id === id,
    );
    expect(view?.tools.map((tool) => tool.name).toSorted()).toEqual([...ALL, "drafts"].toSorted());

    // One person with both: a tool goes out only as an account its server lists it to.
    const both = await newUser();
    await connectToken(both, id, "reader");
    await connectToken(both, id, EDITOR_TOKEN);
    const [readerAccount, editorAccount] = await accountsOf(both, id);
    await run(
      Effect.flatMap(IntegrationService, (s) =>
        Effect.all([
          s.updatePreferences(both, readerAccount!.id, { name: "Reading" }),
          s.updatePreferences(both, editorAccount!.id, { name: "Editing" }),
        ]),
      ),
    );
    const prepared = await toolsFor(both, await newConversation(both));
    const drafts = handlerOf(prepared, `int_${id}__drafts`)!;
    const asReader = await run(drafts({ account: "Reading" }, { toolCallId: "dr" }));
    expect(asReader).toMatchObject({ ok: false, error: expect.stringMatching(/not allowed/) });
    const asEditor = await run(drafts({ account: "Editing" }, { toolCallId: "de" }));
    expect(asEditor).toEqual({ ok: true, result: { content: "Two drafts." } });

    // An open server lists to nobody in particular: one listing, whoever connects.
    const open = await setUp("Docs open once", {
      url: `${base}/mcp`,
      ways: "anonymous",
      anonymous: "open",
    });
    await connectOpen(editor, open);
    await connectOpen(reader, open);
    expect(await listingsOf(open)).toMatchObject([{ id: open, connectionId: null }]);
  });

  it("lets the admin turn a tool off for every account and correct the access it claims", async () => {
    const editor = await newUser();
    const reader = await newUser();
    const id = await setUp("Docs settings", { url: `${base}/mcp`, ways: "token" });
    await connectToken(editor, id, EDITOR_TOKEN);
    await connectToken(reader, id, "reader");
    const editorChat = await newConversation(editor);
    const readerChat = await newConversation(reader);

    await setTool(id, "search", { off: true, access: null });
    expect(await offeredNames(editor, editorChat, id)).toEqual([
      "delete_page",
      "release",
      "provision",
      "drafts",
    ]);
    expect(await offeredNames(reader, readerChat, id)).toEqual([
      "delete_page",
      "release",
      "provision",
    ]);
    const [account] = await accountsOf(reader, id);
    expect(account?.tools.map((tool) => tool.name)).not.toContain("search");

    // Corrected to a read, a tool that claimed nothing runs without asking.
    const view = await setTool(id, "delete_page", { off: false, access: "read" });
    expect(view.tools.find((tool) => tool.name === "delete_page")).toMatchObject({
      access: "read",
      claimed: "destructive",
      off: false,
    });
    expect(view.tools.find((tool) => tool.name === "search")).toMatchObject({ off: true });
    deleted.length = 0;
    const prepared = await toolsFor(reader, readerChat);
    const outcome = await run(
      handlerOf(prepared, `int_${id}__delete_page`)!({ id: "p-9" }, { toolCallId: "corrected" }),
    );
    expect(outcome).toMatchObject({ ok: true, result: { content: "Deleted p-9." } });
    expect(deleted).toEqual(["p-9"]);
    expect(await run(Effect.flatMap(IntegrationApprovals, (a) => a.pending(reader)))).toEqual([]);

    // Cleared, both are back as the server describes them.
    await setTool(id, "delete_page", { off: false, access: null });
    await setTool(id, "search", { off: false, access: null });
    const restored = await toolsFor(reader, readerChat);
    expect(restored?.names.get(`int_${id}__delete_page`)?.tool.access).toBe("destructive");
    expect(await offeredNames(reader, readerChat, id)).toEqual(ALL);
  });

  describe("lists in the background as each account", () => {
    it("with that account's own credential, for each due listing", async () => {
      const editor = await newUser();
      const reader = await newUser();
      const id = await setUp("Docs swept", { url: `${base}/mcp`, ways: "token" });
      await connectToken(editor, id, EDITOR_TOKEN);
      await connectToken(reader, id, "reader");
      addedTool = "archive";
      try {
        await makeDue(id);
        await run(Effect.flatMap(IntegrationService, (s) => s.checkDueListings()));
      } finally {
        addedTool = null;
      }
      const [editorAccount] = await accountsOf(editor, id);
      const [readerAccount] = await accountsOf(reader, id);
      expect(editorAccount?.tools.map((tool) => tool.name)).toEqual([...ALL, "drafts", "archive"]);
      expect(readerAccount?.tools.map((tool) => tool.name)).toEqual([...ALL, "archive"]);
      // Each check settled its lease and set when it is next due.
      for (const listing of await listingsOf(id)) {
        expect(listing.checkLeaseUntil).toBeNull();
        expect(listing.nextCheckAt.getTime()).toBeGreaterThan(Date.now());
      }
    });

    it("not as an account that may no longer act here, banned since it connected", async () => {
      const person = await newUser();
      const id = await setUp("Docs banned", { url: `${base}/mcp`, ways: "token" });
      await connectToken(person, id, EDITOR_TOKEN);
      const [account] = await accountsOf(person, id);
      await run(
        Effect.flatMap(Db, (db) =>
          db.update(user).set({ banned: true }).where(eq(user.id, person)).pipe(Effect.orDie),
        ),
      );
      addedTool = "archive";
      try {
        await makeDue(id);
        await run(Effect.flatMap(IntegrationService, (s) => s.checkDueListings()));
      } finally {
        addedTool = null;
      }
      const listing = await run(
        Effect.flatMap(IntegrationRepo, (repo) => repo.toolListing(id, account!.id)),
      );
      expect(listing?.checkError).toMatch(/can no longer use it/);
      expect(listing?.tools?.map((tool) => tool.mcpName)).not.toContain("archive");
    });

    it("not once the admin closed the way in it uses", async () => {
      const person = await newUser();
      const id = await setUp("Docs closed way", {
        url: `${base}/mcp`,
        ways: "token anonymous",
        anonymous: "open",
      });
      await connectToken(person, id, "t");
      await run(
        Effect.flatMap(IntegrationService, (s) =>
          s.saveConfig({
            id,
            name: "Docs closed way",
            enabled: true,
            config: { url: `${base}/mcp`, ways: "anonymous", anonymous: "open" },
            oauthClientId: "",
            allowApiKeys: true,
          }),
        ),
      );
      await makeDue(id);
      await run(Effect.flatMap(IntegrationService, (s) => s.checkDueListings()));
      const [account] = await accountsOf(person, id);
      const own = await run(
        Effect.flatMap(IntegrationRepo, (repo) => repo.toolListing(id, account!.id)),
      );
      expect(own?.checkError).toMatch(/can no longer use it/);
      // The listing without an account is still checked, as nobody.
      const shared = await run(
        Effect.flatMap(IntegrationRepo, (repo) => repo.toolListing(id, null)),
      );
      expect(shared).toMatchObject({ checkError: null });
    });
  });

  it("never lets a slower, older check undo what a newer one found", async () => {
    const admin = await newUser();
    const id = await setUp("Docs race", {
      url: `${base}/mcp`,
      ways: "anonymous",
      anonymous: "open",
    });
    await connectOpen(admin, id);
    const conversationId = await newConversation(admin);
    const descriptionOf = async () =>
      (await toolsFor(admin, conversationId))?.names.get(`int_${id}__search`)?.tool.description;

    const { arrived, release } = holdNextListing();
    const slow = run(
      Effect.flatMap(IntegrationService, (s) => Effect.flip(s.checkTools(admin, id))),
    );
    await arrived;
    searchDescription = "Search the docs, and send them to me.";
    try {
      await checkTools(admin, id);
      expect(await descriptionOf()).toBe("Search the docs, and send them to me.");
      release();
      expect(await slow).toMatchObject({ reason: expect.stringMatching(/newer check/) });
      // The old listing did not bring the old description back.
      expect(await descriptionOf()).toBe("Search the docs, and send them to me.");
    } finally {
      release();
      searchDescription = "Search the docs.";
    }
  });

  it("drops every listing when the admin moves it to another server, and a check from before records nothing", async () => {
    const admin = await newUser();
    const person = await newUser();
    const config = (url: string) => ({ url, ways: "token" });
    const id = await setUp("Docs moved", config(`${base}/mcp`));
    await connectToken(admin, id, "t");
    await connectToken(person, id, EDITOR_TOKEN);
    expect(await listingsOf(id)).toHaveLength(2);

    // A check of the old address still running when the admin saves is dropped too.
    const { arrived, release } = holdNextListing();
    const stale = run(
      Effect.flatMap(IntegrationService, (s) => Effect.flip(s.checkTools(admin, id))),
    );
    await arrived;
    const moved = await run(
      Effect.flatMap(IntegrationService, (s) =>
        s.saveConfig({
          id,
          name: "Docs moved",
          enabled: true,
          config: config(`${base}/elsewhere`),
          oauthClientId: "",
          allowApiKeys: true,
        }),
      ),
    );
    release();
    expect(await stale).toMatchObject({ reason: expect.stringMatching(/newer check/) });
    expect(moved.tools).toEqual([]);
    expect(await listingsOf(id)).toEqual([]);

    // Reconnected at the new address, the account is listed afresh.
    const [account] = await accountsOf(admin, id);
    await connectToken(admin, id, "t", account!.id);
    expect(await offeredNames(admin, await newConversation(admin), id)).toEqual(ALL);
    expect(await listingsOf(id)).toMatchObject([{ id: account!.id, connectionId: account!.id }]);
  });

  it("takes a token beside open use, and closing one way leaves the other connected", async () => {
    const admin = await newUser();
    const person = await newUser();
    const save = (ways: string) =>
      run(
        Effect.flatMap(IntegrationService, (s) =>
          s.saveConfig({
            id,
            name: "Docs either",
            enabled: true,
            config: { url: `${base}/mcp`, ways, anonymous: "open" },
            oauthClientId: "",
            allowApiKeys: true,
          }),
        ),
      );
    const id = await setUp("Docs either", {
      url: `${base}/mcp`,
      ways: "anonymous",
      anonymous: "open",
    });
    await run(Effect.flatMap(IntegrationService, (s) => s.connectOpen(admin, id)));
    const adminChat = await newConversation(admin);
    const personChat = await newConversation(person);

    // Offering tokens too asks nobody to reconnect and keeps what was listed.
    await save("token anonymous");
    const listed = await run(Effect.flatMap(IntegrationService, (s) => s.listForUser(person)));
    expect(listed.find((row) => row.id === id)?.methods).toEqual({
      oauth: false,
      apiKey: true,
      open: "none",
      everyone: false,
    });
    expect(await offeredNames(admin, adminChat, id)).toEqual(ALL);
    await connectToken(person, id, EDITOR_TOKEN);
    // Their own token is listed as them, beside the listing without an account.
    expect(await offeredNames(person, personChat, id)).toEqual([...ALL, "drafts"]);

    // Closing tokens again stops only the token.
    await save("anonymous");
    expect(await offeredNames(person, personChat, id)).toEqual([]);
    const after = await run(Effect.flatMap(IntegrationService, (s) => s.listForUser(person)));
    expect(after.find((row) => row.id === id)?.connections[0]).toMatchObject({
      authKind: "api_key",
      status: "needs_reauth",
    });
    expect(await offeredNames(admin, adminChat, id)).toEqual(ALL);
  });

  it("drops the listing without an account once that way in closes", async () => {
    const id = await setUp("Docs closing", {
      url: `${base}/mcp`,
      ways: "token anonymous",
      anonymous: "open",
    });
    expect((await listingsOf(id)).map((listing) => listing.connectionId)).toEqual([null]);
    await run(
      Effect.flatMap(IntegrationService, (s) =>
        s.saveConfig({
          id,
          name: "Docs closing",
          enabled: true,
          config: { url: `${base}/mcp`, ways: "token" },
          oauthClientId: "",
          allowApiKeys: true,
        }),
      ),
    );
    expect(await listingsOf(id)).toEqual([]);
  });

  it("lists a server open to everyone on the first read, when nobody listed it yet", async () => {
    const person = await newUser();
    const id = await setUp("Docs never listed", {
      url: `${base}/mcp`,
      ways: "anonymous",
      anonymous: "open",
      everyone: "everyone",
    });
    // As an install from before listings were kept per account: no listing at all.
    await run(
      Effect.flatMap(Db, (db) =>
        db
          .delete(integrationToolListings)
          .where(eq(integrationToolListings.integrationId, id))
          .pipe(Effect.orDie),
      ),
    );
    const [account] = await accountsOf(person, id);
    expect(account?.authKind).toBe("none");
    expect((await accountsOf(person, id))[0]?.tools.map((tool) => tool.name)).toEqual(ALL);
  });

  it("turns on for everyone at once, and leaves a person's own account theirs", async () => {
    const person = await newUser();
    const config = (url: string, ways = "token anonymous") => ({
      url,
      ways,
      anonymous: "open",
      everyone: "everyone",
    });
    const id = await setUp("Docs for all", config(`${base}/mcp`));
    const connectionOf = () =>
      run(Effect.flatMap(IntegrationService, (s) => s.listForUser(person))).then(
        (rows) => rows.find((row) => row.id === id)?.connections[0],
      );

    // Nobody pressed anything, and a new chat already has it.
    const chat = await newConversation(person);
    expect(await offeredNames(person, chat, id)).toEqual(ALL);
    expect(await connectionOf()).toMatchObject({
      authKind: "none",
      status: "active",
      offerByDefault: true,
    });

    // Their own token replaces it, and disconnecting goes back to the open way.
    await run(
      Effect.flatMap(IntegrationService, (s) => s.connectApiKey(person, id, { token: "t" })),
    );
    expect(await connectionOf()).toMatchObject({ authKind: "api_key" });
    await run(
      Effect.flatMap(IntegrationService, (s) =>
        on(person, id, (account) => s.disconnect(person, account)),
      ),
    );
    expect(await connectionOf()).toMatchObject({ authKind: "none", status: "active" });

    // Moved to another server, the open connection follows; a token would need reconnecting.
    await run(
      Effect.flatMap(IntegrationService, (s) =>
        s.saveConfig({
          id,
          name: "Docs for all",
          enabled: true,
          config: config(`${base}/elsewhere`),
          oauthClientId: "",
          allowApiKeys: true,
        }),
      ),
    );
    expect(await connectionOf()).toMatchObject({ authKind: "none", status: "active" });
    // Reachable without an account, the new address was listed on save.
    expect(await offeredNames(person, chat, id)).toEqual(ALL);
    expect(await listingsOf(id)).toMatchObject([{ id, checkError: null }]);

    // With one shared key, everyone is on it.
    const shared = await setUp(
      "Docs shared for all",
      { url: `${base}/mcp`, ways: "anonymous", anonymous: "shared", everyone: "everyone" },
      "admin-key",
    );
    const listed = await run(Effect.flatMap(IntegrationService, (s) => s.listForUser(person)));
    expect(listed.find((row) => row.id === shared)).toMatchObject({
      methods: { open: "shared", everyone: true },
      connections: [{ authKind: "shared", accountLabel: "Shared key" }],
    });
  });

  it("never hands a session made for one address the credential saved for the next", async () => {
    const person = await newUser();
    const id = await setUp("Docs tokens", {
      url: `${base}/mcp`,
      ways: "token",
    });
    const connect = (token: string, connectionId?: string) =>
      run(
        Effect.flatMap(IntegrationService, (s) =>
          s.connectApiKey(person, id, { token }, connectionId),
        ),
      );
    await connect("first");
    const before = await run(
      Effect.flatMap(IntegrationService, (s) =>
        on(person, id, (account) => s.session(person, account)),
      ),
    );
    await run(
      Effect.flatMap(IntegrationService, (s) =>
        s.saveConfig({
          id,
          name: "Docs tokens",
          enabled: true,
          config: { url: `${base}/elsewhere`, ways: "token" },
          oauthClientId: "",
          allowApiKeys: true,
        }),
      ),
    );
    // Reconnecting the same account, as Settings does once the address moved.
    await connect("second", before.connectionId);
    // A call prepared before the move still names the old address: it gets nothing.
    const stale = await runtime.runPromiseExit(before.credential);
    expect(Exit.isFailure(stale) && Cause.squash(stale.cause)).toMatchObject({
      _tag: "IntegrationRequestFailed",
      message: "This integration is no longer connected.",
    });
    const after = await run(
      Effect.flatMap(IntegrationService, (s) =>
        on(person, id, (account) => s.session(person, account)),
      ),
    );
    expect(await run(after.credential)).toMatchObject({
      kind: "api_key",
      values: { token: "second" },
    });
  });

  it("pins the admin's client to one issuer, beside the registrations, for one revision", async () => {
    const id = await setUp("Docs pinned", {
      url: `${base}/mcp`,
      ways: "oauth",
    });
    const save = (clientId: string) =>
      run(
        Effect.flatMap(IntegrationService, (s) =>
          s.saveConfig({
            id,
            name: "Docs pinned",
            enabled: true,
            config: { url: `${base}/mcp`, ways: "oauth" },
            oauthClientId: clientId,
            allowApiKeys: true,
          }),
        ),
      );
    const revision = () =>
      run(Effect.flatMap(IntegrationRepo, (repo) => repo.getConfig(id))).then(
        (row) => row!.revision,
      );
    await save("admin-client");
    const first = await revision();
    const registered = {
      clientId: "dyn",
      clientSecret: "dyn-secret",
      method: "dynamic" as const,
      redirectUri: "https://chat.example.com/cb",
    };
    const outcome = await run(
      Effect.gen(function* () {
        const repo = yield* IntegrationRepo;
        yield* repo.saveOAuthClient(id, "https://as.example.com", registered);
        // Two first sign-ins at once: one issuer wins, and both see which.
        const pins = yield* Effect.all(
          [
            repo.pinClientIssuer(id, first, "https://as.example.com"),
            repo.pinClientIssuer(id, first, "https://evil.example.com"),
          ],
          { concurrency: "unbounded" },
        );
        return { pins, kept: yield* repo.oauthClient(id, "https://as.example.com", "dyn") };
      }),
    );
    expect(new Set(outcome.pins).size).toBe(1);
    expect(outcome.kept).toEqual(registered);

    // Saving without a change keeps the revision and the pin.
    await save("admin-client");
    expect(await revision()).toBe(first);
    // Another client, even the same one again later, is a new revision: a sign-in
    // that started before it pins nothing, and the next one pins afresh.
    await save("other-client");
    await save("admin-client");
    const latest = await revision();
    expect(latest).toBe(first + 2);
    const stale = await run(
      Effect.flatMap(IntegrationRepo, (repo) =>
        repo.pinClientIssuer(id, first, "https://old.example.com"),
      ),
    );
    expect(stale).toBeNull();
    const repinned = await run(
      Effect.flatMap(IntegrationRepo, (repo) =>
        repo.pinClientIssuer(id, latest, "https://idp.example.com"),
      ),
    );
    expect(repinned).toBe("https://idp.example.com");
  });

  it("keeps every client registered with an issuer, so each sign-in finds its own secret", async () => {
    const id = await setUp("Docs registrations", {
      url: `${base}/mcp`,
      ways: "oauth",
    });
    const client = (clientId: string, redirectUri = "https://chat.example.com/cb") => ({
      clientId,
      clientSecret: `${clientId}-secret`,
      method: "dynamic" as const,
      redirectUri,
    });
    const found = await run(
      Effect.gen(function* () {
        const repo = yield* IntegrationRepo;
        // Two first sign-ins each registered; a later one came from another origin.
        yield* repo.saveOAuthClient(id, "https://as.example.com", client("first"));
        yield* repo.saveOAuthClient(id, "https://as.example.com", client("second"));
        yield* repo.saveOAuthClient(
          id,
          "https://as.example.com",
          client("desktop", "https://desk.example.com/cb"),
        );
        return {
          first: yield* repo.oauthClient(id, "https://as.example.com", "first"),
          second: yield* repo.oauthClient(id, "https://as.example.com", "second"),
          reuse: yield* repo.reusableOAuthClient(
            id,
            "https://as.example.com",
            "https://chat.example.com/cb",
          ),
        };
      }),
    );
    expect(found.first?.clientSecret).toBe("first-secret");
    expect(found.second?.clientSecret).toBe("second-secret");
    expect(found.reuse?.clientId).toBe("second");
  });

  it("calls a read straight away and asks before a destructive call, showing every argument", async () => {
    const admin = await newUser();
    const id = await setUp("Docs calls", {
      url: `${base}/mcp`,
      ways: "anonymous",
      anonymous: "open",
    });
    await run(Effect.flatMap(IntegrationService, (s) => s.connectOpen(admin, id)));
    const conversationId = await newConversation(admin);
    const prepared = await toolsFor(admin, conversationId);

    const found = await run(
      handlerOf(prepared, `int_${id}__search`)!({ q: "billing" }, { toolCallId: "a" }),
    );
    expect(found).toEqual({ ok: true, result: { content: "Results for billing." } });

    deleted.length = 0;
    const outcome = await run(
      Effect.gen(function* () {
        const approvals = yield* IntegrationApprovals;
        const waiting = yield* Effect.forkChild(
          handlerOf(prepared, `int_${id}__delete_page`)!({ id: "p-1" }, { toolCallId: "b" }),
        );
        const [pending] = yield* waitForPending(admin);
        expect(pending).toMatchObject({
          kind: "approval",
          access: "destructive",
          details: [{ key: "id", value: "p-1" }],
        });
        // The short list showed everything, so nothing more is sent along.
        expect(pending?.inFull).toBeUndefined();
        // Nothing went out while the person decides.
        expect(deleted).toEqual([]);
        yield* approvals.decide(admin, pending!.callId, "allow");
        return yield* Fiber.join(waiting);
      }),
    );
    expect(outcome).toMatchObject({ ok: true, result: { content: "Deleted p-1." } });
    expect(deleted).toEqual(["p-1"]);
  });

  it("puts everything a call sends to the person when the short list would hide some", async () => {
    const admin = await newUser();
    const id = await setUp("Docs long", {
      url: `${base}/mcp`,
      ways: "anonymous",
      anonymous: "open",
    });
    await run(Effect.flatMap(IntegrationService, (s) => s.connectOpen(admin, id)));
    const conversationId = await newConversation(admin);
    const prepared = await toolsFor(admin, conversationId);
    const long = `p-${"x".repeat(400)}-and-also-the-archive`;
    const pending = await run(
      Effect.gen(function* () {
        const approvals = yield* IntegrationApprovals;
        const waiting = yield* Effect.forkChild(
          handlerOf(prepared, `int_${id}__delete_page`)!({ id: long }, { toolCallId: "l" }),
        );
        const [asked] = yield* waitForPending(admin);
        yield* approvals.decide(admin, asked!.callId, "deny", { via: "Claude" });
        yield* Fiber.join(waiting);
        return asked;
      }),
    );
    // Declined in a connected app: the stored activity names it.
    expect(prepared!.take("l").decided).toEqual({ decision: "deny", app: "Claude" });
    expect(pending?.details?.[0]?.value).not.toContain("and-also-the-archive");
    expect(pending?.inFull).toContain(`"id": "${long}"`);
  });

  it("does not run a call whose tool was turned off, reclassified or changed while it waited", async () => {
    const admin = await newUser();
    const id = await setUp("Docs revoked", {
      url: `${base}/mcp`,
      ways: "anonymous",
      anonymous: "open",
    });
    await connectOpen(admin, id);
    const conversationId = await newConversation(admin);
    /** Starts a delete prepared now, lands `change` while it waits for approval, then allows it. */
    const allowAfter = async (callId: string, change: () => Promise<unknown>) => {
      const prepared = await toolsFor(admin, conversationId);
      deleted.length = 0;
      const outcome = await run(
        Effect.gen(function* () {
          const approvals = yield* IntegrationApprovals;
          const waiting = yield* Effect.forkChild(
            handlerOf(prepared, `int_${id}__delete_page`)!({ id: callId }, { toolCallId: callId }),
          );
          const [pending] = yield* waitForPending(admin);
          yield* Effect.promise(change);
          yield* approvals.decide(admin, pending!.callId, "allow");
          return yield* Fiber.join(waiting);
        }),
      );
      expect(outcome).toMatchObject({ ok: false, refused: true });
      expect(JSON.stringify(outcome)).toMatch(/changed since this answer started/);
      expect(deleted).toEqual([]);
    };

    await allowAfter("off", () => setTool(id, "delete_page", { off: true, access: null }));
    await setTool(id, "delete_page", { off: false, access: null });
    await allowAfter("reclassified", () =>
      setTool(id, "delete_page", { off: false, access: "write" }),
    );
    await setTool(id, "delete_page", { off: false, access: null });
    // The server describing it otherwise is another version of the tool.
    try {
      await allowAfter("changed", async () => {
        deleteDescription = "Delete a page and everything under it.";
        await checkTools(admin, id);
      });
    } finally {
      deleteDescription = "Delete a page.";
    }
  });

  it("checks a change queued behind another only once its turn comes", async () => {
    const admin = await newUser();
    const id = await setUp("Docs queued", {
      url: `${base}/mcp`,
      ways: "anonymous",
      anonymous: "open",
    });
    await run(Effect.flatMap(IntegrationService, (s) => s.connectOpen(admin, id)));
    await run(
      Effect.flatMap(IntegrationService, (s) =>
        on(admin, id, (account) =>
          s.updatePreferences(admin, account, {
            toolPermissions: { release: "allow", delete_page: "allow" },
          }),
        ),
      ),
    );
    const conversationId = await newConversation(admin);
    const reads = { permissions: 0 };
    const prepared = await toolsFor(admin, conversationId, false, reads);
    deleted.length = 0;
    const outcome = await run(
      Effect.gen(function* () {
        const approvals = yield* IntegrationApprovals;
        // The release holds the change permit while it waits for an answer.
        const first = yield* Effect.forkChild(
          handlerOf(prepared, `int_${id}__release`)!({}, { toolCallId: "w1" }),
        );
        const [question] = yield* waitForPending(admin);
        const second = yield* Effect.forkChild(
          handlerOf(prepared, `int_${id}__delete_page`)!({ id: "p-3" }, { toolCallId: "w2" }),
        );
        // Its two checks before the permit (the release made three).
        yield* Effect.sync(() => reads.permissions).pipe(
          Effect.repeat({ until: (count) => count >= 5 }),
        );
        yield* Effect.promise(() => setTool(id, "delete_page", { off: true, access: null }));
        yield* approvals.answer(admin, question!.callId, question!.promptId!, {
          action: "accept",
          values: { name: "v3" },
        });
        yield* Fiber.join(first);
        return yield* Fiber.join(second);
      }),
    );
    expect(JSON.stringify(outcome)).toMatch(/changed since this answer started/);
    expect(deleted).toEqual([]);
  });

  it("puts a server's question to the person mid-call, and declines it in a scheduled run", async () => {
    const admin = await newUser();
    const id = await setUp("Docs release", {
      url: `${base}/mcp`,
      ways: "anonymous",
      anonymous: "open",
    });
    await run(Effect.flatMap(IntegrationService, (s) => s.connectOpen(admin, id)));
    await run(
      Effect.flatMap(IntegrationService, (s) =>
        on(admin, id, (account) =>
          s.updatePreferences(admin, account, { toolPermissions: { release: "allow" } }),
        ),
      ),
    );
    const conversationId = await newConversation(admin);
    const prepared = await toolsFor(admin, conversationId);
    const answered = await run(
      Effect.gen(function* () {
        const approvals = yield* IntegrationApprovals;
        const waiting = yield* Effect.forkChild(
          handlerOf(prepared, `int_${id}__release`)!({}, { toolCallId: "c" }),
        );
        const [pending] = yield* waitForPending(admin);
        expect(pending).toMatchObject({
          kind: "elicitation",
          prompt: {
            mode: "form",
            message: "Name this release.",
            fields: [{ key: "name", required: true }],
          },
        });
        yield* approvals.answer(admin, pending!.callId, pending!.promptId!, {
          action: "accept",
          values: { name: "v2" },
        });
        return yield* Fiber.join(waiting);
      }),
    );
    expect(answered).toMatchObject({ ok: true, result: { content: "Released v2." } });

    const unattended = await toolsFor(admin, conversationId, true);
    const result = await run(handlerOf(unattended, `int_${id}__release`)!({}, { toolCallId: "d" }));
    expect(JSON.stringify(result)).not.toContain("Released");
    expect(await run(Effect.flatMap(IntegrationApprovals, (a) => a.pending(admin)))).toEqual([]);
  });

  it("asks one question at a time, and an answer to an earlier one cannot answer the next", async () => {
    const admin = await newUser();
    const id = await setUp("Docs provision", {
      url: `${base}/mcp`,
      ways: "anonymous",
      anonymous: "open",
    });
    await run(Effect.flatMap(IntegrationService, (s) => s.connectOpen(admin, id)));
    await run(
      Effect.flatMap(IntegrationService, (s) =>
        on(admin, id, (account) =>
          s.updatePreferences(admin, account, { toolPermissions: { provision: "allow" } }),
        ),
      ),
    );
    const conversationId = await newConversation(admin);
    const prepared = await toolsFor(admin, conversationId);
    const valueFor = { "Name it.": { name: "staging" }, "Where?": { region: "eu" } } as const;
    const answered = await run(
      Effect.gen(function* () {
        const approvals = yield* IntegrationApprovals;
        const waiting = yield* Effect.forkChild(
          handlerOf(prepared, `int_${id}__provision`)!({}, { toolCallId: "p" }),
        );
        const [first] = yield* waitForPending(admin);
        expect(yield* approvals.pending(admin)).toHaveLength(1);
        const firstMessage = first!.prompt!.message as keyof typeof valueFor;
        expect(
          yield* approvals.answer(admin, first!.callId, first!.promptId!, {
            action: "accept",
            values: valueFor[firstMessage],
          }),
        ).toBe(true);
        const [second] = yield* approvals.pending(admin).pipe(
          Effect.repeat({
            until: (pending) => pending[0] !== undefined && pending[0].promptId !== first!.promptId,
          }),
        );
        expect(second!.callId).toBe(first!.callId);
        const secondMessage = second!.prompt!.message as keyof typeof valueFor;
        expect(secondMessage).not.toBe(firstMessage);
        // A tab still showing the first question cannot answer the second.
        expect(
          yield* approvals.answer(admin, first!.callId, first!.promptId!, {
            action: "accept",
            values: valueFor[firstMessage],
          }),
        ).toBe(false);
        yield* approvals.answer(admin, second!.callId, second!.promptId!, {
          action: "accept",
          values: valueFor[secondMessage],
        });
        return yield* Fiber.join(waiting);
      }),
    );
    expect(answered).toMatchObject({ ok: true, result: { content: "staging in eu." } });
  });

  it("remembers the scopes a call lacked, so the next sign-in asks for them", async () => {
    const admin = await newUser();
    const config = { url: `${base}/scoped`, ways: "oauth" };
    const id = await setUp("Docs scoped", config);
    const normalized = mcpAdapter.normalizeConfig(config);
    if ("error" in normalized) throw new Error(normalized.error);
    await run(
      Effect.flatMap(IntegrationRepo, (repo) =>
        saveAtCurrent(repo, {
          accountKey: null,
          userId: admin,
          integrationId: id,
          authKind: "oauth",
          credentials: { kind: "oauth", accessToken: "t", refreshToken: null, expiresAt: null },
          accountLabel: "ada",
          fingerprint: normalized.fingerprint,
        }),
      ),
    );
    // Saved straight to the store, so listed as the admin's own account would be on connecting.
    await checkTools(admin, id);
    const conversationId = await newConversation(admin);
    const prepared = await toolsFor(admin, conversationId);
    const refused = await run(
      handlerOf(prepared, `int_${id}__search`)!({ q: "x" }, { toolCallId: "s" }),
    );
    expect(JSON.stringify(refused)).toMatch(/Grant more access/);
    const listed = await run(Effect.flatMap(IntegrationService, (s) => s.listForUser(admin)));
    expect(listed.find((row) => row.id === id)?.connections[0]).toMatchObject({
      status: "active",
      requiredScopes: ["docs:read", "docs:write"],
    });

    // A server naming new scopes on every refusal stops adding past the limit.
    const connectionId = listed.find((row) => row.id === id)!.connections[0]!.id;
    const held = await run(
      Effect.flatMap(IntegrationRepo, (repo) => repo.getConnectionById(connectionId)),
    );
    const connection = { connectionId, accountEpoch: held!.accountEpoch };
    await run(
      Effect.flatMap(IntegrationRepo, (repo) =>
        Effect.forEach(
          Array.from({ length: 30 }, (_, batch) => [`s${batch}a`, `s${batch}b`]),
          (scopes) => repo.addRequiredScopes(connection, scopes),
        ),
      ),
    );
    const capped = await run(
      Effect.flatMap(IntegrationRepo, (repo) => repo.getConnectionById(connectionId)),
    );
    expect(capped?.requiredScopes?.length).toBeLessThanOrEqual(50);

    // A first refusal naming more than fit still records the first fifty.
    await run(Effect.flatMap(IntegrationRepo, (repo) => repo.clearRequiredScopes(connectionId)));
    await run(
      Effect.flatMap(IntegrationRepo, (repo) =>
        repo.addRequiredScopes(
          connection,
          Array.from({ length: 60 }, (_, index) => `many${String(index).padStart(2, "0")}`),
        ),
      ),
    );
    const first = await run(
      Effect.flatMap(IntegrationRepo, (repo) => repo.getConnectionById(connectionId)),
    );
    expect(first?.requiredScopes).toHaveLength(50);
    expect(capped?.requiredScopes).toEqual(expect.arrayContaining(["docs:read", "docs:write"]));
  });

  it("drops a lacking-scope report from a sign-in a reconnect replaced", async () => {
    const person = await newUser();
    const config = { url: `${base}/scoped`, ways: "oauth" };
    const id = await setUp("Docs rescoped", config);
    const normalized = mcpAdapter.normalizeConfig(config);
    if ("error" in normalized) throw new Error(normalized.error);
    // MCP names no account, so signing in again is a reconnect of the one it names.
    const connect = (accessToken: string, connectionId?: string) =>
      run(
        Effect.flatMap(IntegrationRepo, (repo) =>
          saveAtCurrent(repo, {
            accountKey: null,
            userId: person,
            integrationId: id,
            authKind: "oauth",
            credentials: { kind: "oauth", accessToken, refreshToken: null, expiresAt: null },
            accountLabel: "ada",
            fingerprint: normalized.fingerprint,
            connectionId: connectionId ?? null,
          }),
        ),
      );
    await connect("narrow");
    const stale = await run(
      Effect.flatMap(IntegrationService, (s) =>
        on(person, id, (account) => s.session(person, account)),
      ),
    );
    // The person signs in again with more access before the old call's refusal lands.
    await connect("wide", stale.connectionId);
    await run(
      Effect.flatMap(IntegrationService, (s) =>
        s.reportMissingScopes(
          { userId: person, connectionId: stale.connectionId, accountEpoch: stale.accountEpoch },
          ["docs:write"],
        ),
      ),
    );
    const current = await run(
      Effect.flatMap(IntegrationRepo, (repo) => repo.getConnectionById(stale.connectionId)),
    );
    expect(current?.requiredScopes ?? null).toBeNull();
  });

  it("marks the connection whose token the server refused, and not one that replaced it", async () => {
    const admin = await newUser();
    const id = await setUp("Docs refusing", { url: `${base}/refusing`, ways: "token" });
    const connect = (userId: string, token: string, reconnect = false) =>
      run(
        Effect.flatMap(IntegrationService, (s) =>
          reconnect
            ? on(userId, id, (account) => s.connectApiKey(userId, id, { token }, account))
            : s.connectApiKey(userId, id, { token }),
        ),
      );
    const statusOf = (userId: string) =>
      run(Effect.flatMap(IntegrationService, (s) => s.listForUser(userId))).then(
        (rows) => rows.find((row) => row.id === id)?.connections[0]?.status,
      );
    await connect(admin, "revoked");
    const conversationId = await newConversation(admin);
    const refused = await run(
      handlerOf(await toolsFor(admin, conversationId), `int_${id}__search`)!(
        { q: "x" },
        { toolCallId: "refused" },
      ),
    );
    expect(refused).toMatchObject({
      ok: false,
      error: expect.stringMatching(/refused the saved sign-in/),
    });
    expect(await statusOf(admin)).toBe("needs_reauth");

    // A refusal of the old token that lands after a reconnect leaves the new one alone.
    const person = await newUser();
    await connect(person, "old");
    const prepared = await toolsFor(person, await newConversation(person));
    beforeRefusal = () => connect(person, "new", true);
    const late = await run(
      handlerOf(prepared, `int_${id}__search`)!({ q: "x" }, { toolCallId: "late" }),
    );
    expect(beforeRefusal).toBeNull();
    expect(late).toMatchObject({
      ok: false,
      error: expect.stringMatching(/refused the saved sign-in/),
    });
    expect(await statusOf(person)).toBe("active");
  });

  it("with one key for everyone, only reads are ever offered", async () => {
    const id = await setUp(
      "Docs shared",
      { url: `${base}/keyed`, ways: "anonymous", anonymous: "shared", header: "X-Api-Key" },
      "admin-key",
    );
    const person = await newUser();
    await run(Effect.flatMap(IntegrationService, (s) => s.connectOpen(person, id)));
    const listed = await run(Effect.flatMap(IntegrationService, (s) => s.listForUser(person)));
    expect(listed.find((row) => row.id === id)).toMatchObject({
      connections: [{ authKind: "shared", accountLabel: "Shared key" }],
      tools: [{ name: "search", access: "read" }],
    });
    const conversationId = await newConversation(person);
    const prepared = await toolsFor(person, conversationId);
    expect(
      [...(prepared?.names.keys() ?? [])].filter((name) => name.startsWith(`int_${id}__`)),
    ).toEqual([`int_${id}__search`]);
    const found = await run(
      handlerOf(prepared, `int_${id}__search`)!({ q: "x" }, { toolCallId: "e" }),
    );
    expect(found).toMatchObject({ ok: true });

    // The admin calling a destructive tool "reads only" narrows nothing for the key:
    // it still offers only what reads by the server's own word as well.
    const destructive = (
      await run(Effect.flatMap(IntegrationRepo, (repo) => repo.toolListing(id, null)))
    )?.tools?.find((tool) => tool.access === "destructive");
    expect(destructive).toBeDefined();
    await run(
      Effect.flatMap(IntegrationService, (s) =>
        s.setTool(id, destructive!.mcpName, { off: false, access: "read" }),
      ),
    );
    const corrected = await toolsFor(person, await newConversation(person));
    expect(
      [...(corrected?.names.keys() ?? [])].filter((name) => name.startsWith(`int_${id}__`)),
    ).toEqual([`int_${id}__search`]);

    // A personal token would make it theirs, with every tool: not on offer here.
    const refused = await run(
      Effect.flatMap(IntegrationService, (s) =>
        Effect.flip(s.connectApiKey(person, id, { token: "admin-key" })),
      ),
    );
    expect(refused).toMatchObject({ reason: "API keys are turned off for this integration." });
    const after = await run(Effect.flatMap(IntegrationService, (s) => s.listForUser(person)));
    expect(after.find((row) => row.id === id)?.connections[0]?.authKind).toBe("shared");

    // A key the server stops taking is the admin's to fix: nobody is signed out for it.
    await run(
      Effect.flatMap(IntegrationService, (s) =>
        s.saveConfig({
          id,
          name: "Docs shared",
          enabled: true,
          config: {
            url: `${base}/keyed`,
            ways: "anonymous",
            anonymous: "shared",
            header: "X-Api-Key",
          },
          oauthClientId: "",
          allowApiKeys: true,
          sharedCredential: { token: "revoked-key" },
        }),
      ),
    );
    const failed = await run(
      handlerOf(prepared, `int_${id}__search`)!({ q: "x" }, { toolCallId: "f" }),
    );
    expect(JSON.stringify(failed)).toMatch(/refused the shared key/);
    const still = await run(Effect.flatMap(IntegrationService, (s) => s.listForUser(person)));
    expect(still.find((row) => row.id === id)?.connections[0]?.status).toBe("active");
  });
});

describe("an MCP server a person adds for themselves", () => {
  const allowServers = (allowed: boolean) =>
    run(
      Effect.flatMap(Db, (db) =>
        db
          .update(defaultCapabilities)
          .set({
            capabilities: sql`${defaultCapabilities.capabilities} || ${JSON.stringify({ mcpServers: allowed })}::jsonb`,
          })
          .pipe(Effect.orDie),
      ),
    );
  const activeUser = newUser;
  const save = (userId: string, name: string, url: string, integrationId: string | null = null) =>
    run(
      Effect.flatMap(IntegrationService, (s) =>
        s.savePersonalServer(userId, {
          integrationId,
          name,
          config: { url, ways: "anonymous" },
        }),
      ).pipe(Effect.result),
    );
  afterAll(() => allowServers(false));

  it("is listed and used by its owner alone, with no approval step, while they may add servers", async () => {
    names.set("mcp.example.test", { address: "93.184.216.34", forwardTo: base, requests: 0 });
    const owner = await activeUser();
    const other = await activeUser();
    const admin = await newUser();
    await run(
      Effect.flatMap(Db, (db) =>
        db.update(user).set({ role: "admin" }).where(eq(user.id, admin)).pipe(Effect.orDie),
      ),
    );

    await allowServers(false);
    expect(JSON.stringify(await save(owner, "Mine", "https://mcp.example.test/mcp"))).toMatch(
      /has not let you/,
    );
    await allowServers(true);
    expect(JSON.stringify(await save(owner, "Mine", "http://mcp.example.test/mcp"))).toMatch(
      /https:/,
    );
    const saved = await save(owner, "Mine", "https://mcp.example.test/mcp");
    if (saved._tag !== "Success") throw new Error(JSON.stringify(saved));
    const id = saved.success.id;
    // Needing no account, saving it turned it on for its owner and listed it, through the public address.
    expect(saved.success.listing).toMatchObject({ count: 4, checkError: null });
    expect(names.get("mcp.example.test")!.requests).toBeGreaterThan(0);
    // Another person may use the same name for theirs.
    expect((await save(other, "Mine", "https://mcp.example.test/mcp"))._tag).toBe("Success");

    // Nobody else sees it or may change it, admins included.
    const service = <A, E>(f: (s: IntegrationService["Service"]) => Effect.Effect<A, E>) =>
      run(Effect.flatMap(IntegrationService, f));
    const others = await service((s) => s.listForUser(other));
    expect(others.filter((row) => row.id === id)).toEqual([]);
    expect((await service((s) => s.directory(other))).map((row) => row.id)).not.toContain(id);
    expect((await service((s) => s.adminList())).map((row) => row.id)).not.toContain(id);
    const adminCheck = await service((s) => s.checkTools(admin, id).pipe(Effect.result));
    expect(adminCheck._tag).toBe("Failure");
    const adminSetting = await service((s) =>
      s.setTool(id, "search", { off: true, access: null }).pipe(Effect.result),
    );
    expect(adminSetting._tag).toBe("Failure");
    const otherCheck = await service((s) => s.checkOwnTools(other, id).pipe(Effect.result));
    expect(otherCheck._tag).toBe("Failure");

    // Everything it lists is on offer at once, as it claims.
    const chat = await newConversation(owner);
    expect(await offeredNames(owner, chat, id)).toEqual(ALL);
    // No account behind it, so the composer names none.
    expect(
      (await service((s) => s.chatIntegrations(owner, chat))).find(
        (entry) => entry.integrationId === id,
      ),
    ).toMatchObject({ enabled: true, account: null });
    expect((await service((s) => s.listForUser(owner))).find((row) => row.id === id)).toMatchObject(
      { personal: true, connections: [{ authKind: "none" }] },
    );

    // The owner lists it again on demand, and what changed is offered straight away.
    names.get("mcp.example.test")!.requests = 0;
    addedTool = "archive";
    try {
      await service((s) => s.checkOwnTools(owner, id));
    } finally {
      addedTool = null;
    }
    expect(names.get("mcp.example.test")!.requests).toBeGreaterThan(0);
    expect(await offeredNames(owner, chat, id)).toEqual([...ALL, "archive"]);
    expect(
      (await service((s) => s.personalServers(owner))).servers.find((row) => row.id === id),
    ).toMatchObject({ listing: { count: 5 } });

    // Taking the capability away stops it without deleting it.
    await allowServers(false);
    expect(await offeredNames(owner, chat, id)).toEqual([]);
    await allowServers(true);
    expect(await offeredNames(owner, chat, id)).toEqual([...ALL, "archive"]);

    await service((s) => s.deletePersonalServer(owner, id));
    expect(
      (await service((s) => s.personalServers(owner))).servers.map((row) => row.id),
    ).not.toContain(id);
  });

  it("asks its owner to connect before listing a server that needs an account", async () => {
    await allowServers(true);
    names.set("token.example.test", { address: "93.184.216.34", forwardTo: base, requests: 0 });
    const owner = await activeUser();
    const saved = await run(
      Effect.flatMap(IntegrationService, (s) =>
        s.savePersonalServer(owner, {
          integrationId: null,
          name: "Token only",
          config: { url: "https://token.example.test/mcp", ways: "token" },
        }),
      ),
    );
    expect(saved.listing).toBeNull();
    const refused = await run(
      Effect.flatMap(IntegrationService, (s) => Effect.flip(s.checkOwnTools(owner, saved.id))),
    );
    expect(refused).toMatchObject({ reason: "Connect it first." });
    expect(names.get("token.example.test")!.requests).toBe(0);
  });

  it("starts no check of a server deleted after the sweep claimed it", async () => {
    await allowServers(true);
    names.set("gone.example.test", { address: "93.184.216.34", forwardTo: base, requests: 0 });
    const owner = await activeUser();
    const saved = await save(owner, "Gone", "https://gone.example.test/mcp");
    if (saved._tag !== "Success") throw new Error(JSON.stringify(saved));
    const id = saved.success.id;
    await makeDue(id);
    const claimed = await run(
      Effect.flatMap(IntegrationRepo, (repo) =>
        repo.claimDueListings({ kinds: ["mcp"], limit: 10, leaseMs: 60_000 }),
      ),
    );
    const mine = claimed.find((entry) => entry.integrationId === id);
    expect(mine).toMatchObject({ id, connectionId: null });
    await run(Effect.flatMap(IntegrationService, (s) => s.deletePersonalServer(owner, id)));
    // As the sweep would, holding a claim taken before the delete.
    const started = await run(
      Effect.flatMap(IntegrationRepo, (repo) => repo.startListing(id, mine!.connectionId)),
    );
    expect(started).toBeNull();
    expect(await listingsOf(id)).toEqual([]);
  });

  it("refuses a private address, also when a public name later points inside", async () => {
    await allowServers(true);
    const owner = await activeUser();
    names.set("inside.example.test", { address: "10.0.0.5", requests: 0 });
    expect(JSON.stringify(await save(owner, "Inside", "https://inside.example.test/mcp"))).toMatch(
      /public address/,
    );
    expect(JSON.stringify(await save(owner, "Local", `https://127.0.0.1/mcp`))).toMatch(
      /public address/,
    );

    names.set("moves.example.test", { address: "93.184.216.34", forwardTo: base, requests: 0 });
    const saved = await save(owner, "Moves", "https://moves.example.test/mcp");
    if (saved._tag !== "Success") throw new Error(JSON.stringify(saved));
    names.set("moves.example.test", { address: "10.0.0.5", forwardTo: base, requests: 0 });
    const checked = await run(
      Effect.flatMap(IntegrationService, (s) => s.checkOwnTools(owner, saved.success.id)).pipe(
        Effect.result,
      ),
    );
    expect(checked._tag).toBe("Failure");
    expect(names.get("moves.example.test")!.requests).toBe(0);
  });
});
