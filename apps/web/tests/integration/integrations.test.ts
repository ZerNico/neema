import { createServer, type IncomingMessage, type Server } from "node:http";
import { PgClient } from "@effect/sql-pg";
import { count, eq } from "drizzle-orm";
import { Effect, Exit, Fiber, Layer, ManagedRuntime, Redacted } from "effect";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentIntegrations,
  agents,
  conversationAgents,
  conversations,
  integrationConnections,
  knowledgeCollections,
  knowledgeDocuments,
  knowledgeDocumentVersions,
  knowledgeSources,
  conversationIntegrations,
  schedules,
  messages,
  user,
} from "~/db/schema/index.ts";
import { outlineAdapter } from "~/modules/integrations/outline/server/adapter.ts";
import type { IntegrationRejected } from "~/modules/integrations/errors.ts";
import { IntegrationApprovals } from "~/modules/integrations/server/approvals.ts";
import { IntegrationRepo } from "~/modules/integrations/server/repo.ts";
import { IntegrationService } from "~/modules/integrations/server/service.ts";
import { prepareIntegrationTools } from "~/modules/integrations/server/tools.ts";
import type { IntegrationGrant } from "~/modules/integrations/grant.ts";
import type { IntegrationModelResult } from "~/modules/integrations/tool-schema.ts";
import { createSourceIndexer } from "~/modules/tools/server/source-indexer.ts";
import { KnowledgeSourceService } from "~/modules/integrations/server/sync.ts";
import { KnowledgeRepo } from "~/modules/knowledge/server/repo.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 5).toString("base64");

type Services =
  | Db
  | KeyCipher
  | IntegrationRepo
  | IntegrationService
  | IntegrationApprovals
  | KnowledgeSourceService;

let database: TestDatabase;
let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>;
const run = <A, E>(effect: Effect.Effect<A, E, Services>) => runtime.runPromise(effect);

/**
 * A stand-in Outline: the RPC methods the adapter calls plus its OAuth token
 * endpoint. Documents are mutable so a test can edit one between syncs.
 */
let outline: Server;
let baseUrl: string;
const validTokens = new Set(["ol_api_good", "a1"]);
const tokenCalls: string[] = [];
/** Every Outline API method called, to prove what an incremental sync skips. */
const apiCalls: string[] = [];
const refreshTokens = new Map([["r1", { access: "a2", refresh: "r2" }]]);
const tree = [
  {
    id: "d1",
    title: "Onboarding",
    url: "/doc/onboarding",
    children: [{ id: "d2", title: "Laptop", url: "/doc/laptop", children: [] }],
  },
  { id: "d3", title: "Holidays", url: "/doc/holidays", children: [] },
];
const bodies = new Map([
  ["d1", { text: "# Onboarding\nWelcome.", updatedAt: "2026-09-01T00:00:00.000Z" }],
  ["d2", { text: "Get a laptop.", updatedAt: "2026-09-01T00:00:00.000Z" }],
  ["d3", { text: "Twenty-five days.", updatedAt: "2026-09-01T00:00:00.000Z" }],
]);
const titles: Record<string, string> = { d1: "Onboarding", d2: "Laptop", d3: "Holidays" };
const deleted: Record<string, unknown>[] = [];
// Outline declares no allowances, so nothing here ever reserves one.
const unlimited = { reserve: () => Effect.succeed(true), release: () => Effect.void };
const created: Record<string, unknown>[] = [];

const readBody = (request: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => resolve(body));
  });

const startOutline = () =>
  new Promise<void>((resolve) => {
    outline = createServer(async (request, response) => {
      const raw = await readBody(request);
      const json = (status: number, value: unknown) =>
        response
          .writeHead(status, { "content-type": "application/json" })
          .end(JSON.stringify(value));
      if (request.url === "/oauth/token") {
        const form = new URLSearchParams(raw);
        tokenCalls.push(form.get("grant_type") ?? "");
        if (form.get("grant_type") === "authorization_code") {
          if (form.get("code") !== "good-code" || !form.get("code_verifier"))
            return json(400, { error: "invalid_grant" });
          validTokens.add("a-code");
          return json(200, { access_token: "a-code", refresh_token: "r-code", expires_in: 3600 });
        }
        // One use per refresh token, as a rotating provider would allow.
        const next = refreshTokens.get(form.get("refresh_token") ?? "");
        // What Outline really answers for a spent or unknown refresh token:
        // `invalid_request`, not the `invalid_grant` the OAuth spec asks for.
        if (!next)
          return json(400, {
            error: "invalid_request",
            error_description: "Invalid grant: refresh token is invalid",
          });
        refreshTokens.delete(form.get("refresh_token") ?? "");
        validTokens.add(next.access);
        return json(200, {
          access_token: next.access,
          refresh_token: next.refresh,
          expires_in: 3600,
        });
      }
      const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
      if (!validTokens.has(token))
        return json(401, { ok: false, error: "authentication_required" });
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      apiCalls.push(request.url ?? "");
      switch (request.url) {
        case "/api/auth.info":
          return json(200, {
            data: { user: { email: "ada@example.com" }, team: { name: "Acme" } },
          });
        case "/api/collections.list":
          return json(200, {
            data: body.offset ? [] : [{ id: "c1", name: "Handbook", url: "/collection/handbook" }],
          });
        case "/api/collections.documents":
          return body.id === "c1"
            ? json(200, { data: tree })
            : json(404, { ok: false, error: "not_found" });
        case "/api/documents.list":
          return json(200, {
            data: body.offset
              ? []
              : [...bodies]
                  // Newest change first, as the adapter asks.
                  .toSorted(([, a], [, b]) => b.updatedAt.localeCompare(a.updatedAt))
                  .map(([id, doc]) => ({
                    id,
                    title: titles[id],
                    url: `/doc/${id}`,
                    collectionId: "c1",
                    ...doc,
                  })),
          });
        case "/api/documents.info": {
          const id = String(body.id);
          const doc = bodies.get(id);
          return doc
            ? json(200, {
                data: { id, title: titles[id], url: `/doc/${id}`, collectionId: "c1", ...doc },
              })
            : json(404, { ok: false, error: "not_found" });
        }
        case "/api/documents.documents": {
          const found = tree.find((node) => node.id === body.id);
          return found ? json(200, { data: found }) : json(404, { ok: false, error: "not_found" });
        }
        case "/api/documents.create":
          created.push(body);
          return json(200, { data: { id: "created", title: body.title, url: "/doc/created" } });
        case "/api/documents.delete":
          // Recorded, not applied, so later syncs still see the whole tree.
          deleted.push(body);
          return json(200, { success: true });
        default:
          return json(404, { ok: false, error: "not_found" });
      }
    });
    outline.listen(0, "127.0.0.1", () => {
      const address = outline.address();
      baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
      resolve();
    });
  });

const newUser = () =>
  run(
    Effect.gen(function* () {
      const id = uuidv7();
      yield* (yield* Db).insert(user).values({ id, name: "Ada", email: `${id}@t.io` });
      return id;
    }),
  );

const configure = () =>
  run(
    Effect.flatMap(IntegrationService, (service) =>
      // Created on the first call; later calls only put the settings back.
      service.createIntegration({ kind: "outline", name: "Outline" }).pipe(
        Effect.ignore,
        Effect.andThen(
          service.saveConfig({
            id: "outline",
            name: "Outline",
            enabled: true,
            config: { baseUrl },
            oauthClientId: "client",
            oauthClientSecret: "secret",
            allowApiKeys: true,
          }),
        ),
      ),
    ),
  );

/** This person's Outline row in Settings, among whatever else is set up. */
const outlineFor = (userId: string) =>
  run(Effect.flatMap(IntegrationService, (s) => s.listForUser(userId))).then((rows) =>
    rows.find((row) => row.id === "outline"),
  );

const connectKey = (userId: string) =>
  run(
    Effect.flatMap(IntegrationService, (s) =>
      s.connectApiKey(userId, "outline", { key: "ol_api_good" }),
    ),
  );

const insert = <A>(f: (db: Db["Service"]) => Effect.Effect<A, unknown>) =>
  run(Effect.flatMap(Db, f));

beforeAll(async () => {
  await startOutline();
  database = await createTestDatabase();
  const url = database.url;
  const Infra = Layer.mergeAll(Db.layer, KeyCipher.layer).pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(url), maxConnections: 8 })),
  );
  const Base = Layer.mergeAll(IntegrationRepo.layer, KnowledgeRepo.layer, SyncBus.layer).pipe(
    Layer.provideMerge(Infra),
  );
  const Services = Layer.mergeAll(IntegrationService.layer, IntegrationApprovals.layer).pipe(
    Layer.provideMerge(Base),
  );
  runtime = ManagedRuntime.make(
    KnowledgeSourceService.manualLayer.pipe(Layer.provideMerge(Services)),
  );
  await configure();
});

afterAll(async () => {
  await runtime?.dispose();
  await database?.drop();
  outline?.close();
});

describe("connections", () => {
  it("limits a connection to scope items, applied to calls already running", async () => {
    const userId = await newUser();
    await connectKey(userId);
    // Outline declares nothing to limit.
    const refused = await run(
      Effect.flatMap(IntegrationService, (s) =>
        Effect.flip(s.updatePreferences(userId, "outline", { scope: ["x"] })),
      ),
    );
    expect(refused).toMatchObject({ reason: "This integration has no limits." });

    await run(
      Effect.flatMap(IntegrationService, (s) =>
        s.createIntegration({ kind: "jira", name: "Jira" }).pipe(
          Effect.andThen(
            s.saveConfig({
              id: "jira",
              name: "Jira",
              enabled: true,
              config: { site: "acme.atlassian.net" },
              oauthClientId: "",
              allowApiKeys: true,
            }),
          ),
        ),
      ),
    );
    await run(
      Effect.flatMap(IntegrationRepo, (repo) =>
        repo.saveConnection({
          userId,
          integrationId: "jira",
          authKind: "api_key",
          credentials: { kind: "api_key", values: { email: "a@acme.test", token: "t" } },
          accountLabel: "a@acme.test",
          fingerprint: "acme.atlassian.net",
        }),
      ),
    );
    const session = await run(Effect.flatMap(IntegrationService, (s) => s.session(userId, "jira")));
    expect(await run(session.scope)).toBeNull();
    const limit = (scope: string[] | null) =>
      run(
        Effect.flatMap(IntegrationService, (s) => s.updatePreferences(userId, "jira", { scope })),
      );
    await limit([" PROJ ", "OPS", "PROJ"]);
    // The same session sees the new limit: it is read per call.
    expect(await run(session.scope)).toEqual(["PROJ", "OPS"]);
    const jira = (await run(Effect.flatMap(IntegrationService, (s) => s.listForUser(userId)))).find(
      (entry) => entry.id === "jira",
    );
    expect(jira?.connection?.scope).toEqual(["PROJ", "OPS"]);
    // Choosing a limit and ticking nothing reaches nothing; it is not "all".
    await limit([]);
    expect(await run(session.scope)).toEqual([]);
    await limit(null);
    expect(await run(session.scope)).toBeNull();
  });

  it("verifies an API key with the service before storing it, encrypted", async () => {
    const userId = await newUser();
    const refused = await runtime.runPromiseExit(
      Effect.flatMap(IntegrationService, (s) =>
        s.connectApiKey(userId, "outline", { key: "ol_api_bad" }),
      ),
    );
    expect(Exit.isFailure(refused)).toBe(true);
    // A missing field is refused by the manifest's form before the service is asked.
    const calls = apiCalls.length;
    const empty = await run(
      Effect.flatMap(IntegrationService, (s) =>
        Effect.flip(s.connectApiKey(userId, "outline", { other: "x" })),
      ),
    );
    expect(empty).toMatchObject({ reason: "Enter the API key." });
    expect(apiCalls.length).toBe(calls);

    await connectKey(userId);
    const mine = await outlineFor(userId);
    expect(mine?.connection).toMatchObject({
      accountLabel: "ada@example.com · Acme",
      status: "active",
    });
    const [row] = await insert((db) =>
      db.select().from(integrationConnections).where(eq(integrationConnections.userId, userId)),
    );
    expect(row?.credentialsCiphertext).not.toContain("ol_api_good");
  });

  it("asks everyone to reconnect when the admin points it at another server", async () => {
    const userId = await newUser();
    await connectKey(userId);
    await run(
      Effect.flatMap(IntegrationService, (s) =>
        s.saveConfig({
          id: "outline",
          name: "Outline",
          enabled: true,
          config: { baseUrl: "https://elsewhere.example.com" },
          oauthClientId: "client",
          allowApiKeys: true,
        }),
      ),
    );
    const mine = await outlineFor(userId);
    expect(mine?.connection?.status).toBe("needs_reauth");
    const session = await runtime.runPromiseExit(
      Effect.flatMap(IntegrationService, (s) => s.session(userId, "outline")),
    );
    expect(Exit.isFailure(session)).toBe(true);
    await configure();
  });

  it("finishes OAuth only in the browser that started it, once", async () => {
    const userId = await newUser();
    const started = await run(
      Effect.flatMap(IntegrationService, (s) =>
        s.beginOAuth(userId, "outline", "https://chat.example.com"),
      ),
    );
    const url = new URL(started.url);
    expect(url.origin + url.pathname).toBe(`${baseUrl}/oauth/authorize`);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://chat.example.com/api/integrations/outline/callback",
    );
    const complete = (cookieState: string) =>
      runtime.runPromiseExit(
        Effect.flatMap(IntegrationService, (s) =>
          s.completeOAuth(userId, "outline", {
            code: "good-code",
            state: started.state,
            cookieState,
            iss: null,
          }),
        ),
      );

    expect(Exit.isFailure(await complete("another-browser"))).toBe(true);
    expect(Exit.isSuccess(await complete(started.state))).toBe(true);
    const mine = await outlineFor(userId);
    expect(mine?.connection).toMatchObject({ authKind: "oauth", status: "active" });
    // The state is spent once used.
    expect(Exit.isFailure(await complete(started.state))).toBe(true);
  });

  it("rotates an expired token once however many callers need it", async () => {
    const userId = await newUser();
    await run(
      Effect.flatMap(IntegrationRepo, (repo) =>
        repo.saveConnection({
          userId,
          integrationId: "outline",
          authKind: "oauth",
          credentials: {
            kind: "oauth",
            accessToken: "a-old",
            refreshToken: "r1",
            expiresAt: Date.now() - 1,
          },
          accountLabel: "ada",
          fingerprint: baseUrl,
        }),
      ),
    );
    const before = tokenCalls.length;
    const session = await run(
      Effect.flatMap(IntegrationService, (s) => s.session(userId, "outline")),
    );
    const tokens = await run(
      Effect.all(
        Array.from({ length: 5 }, () => session.credential),
        { concurrency: "unbounded" },
      ),
    );
    expect(tokens).toEqual(Array.from({ length: 5 }, () => ({ kind: "oauth", accessToken: "a2" })));
    expect(tokenCalls.slice(before)).toEqual(["refresh_token"]);
  });

  it("marks a connection whose refresh the service refuses for reconnecting", async () => {
    const userId = await newUser();
    await run(
      Effect.flatMap(IntegrationRepo, (repo) =>
        repo.saveConnection({
          userId,
          integrationId: "outline",
          authKind: "oauth",
          credentials: {
            kind: "oauth",
            accessToken: "a-old",
            refreshToken: "dead",
            expiresAt: Date.now() - 1,
          },
          accountLabel: "ada",
          fingerprint: baseUrl,
        }),
      ),
    );
    const session = await run(
      Effect.flatMap(IntegrationService, (s) => s.session(userId, "outline")),
    );
    expect(Exit.isFailure(await runtime.runPromiseExit(session.credential))).toBe(true);
    const mine = await outlineFor(userId);
    expect(mine?.connection?.status).toBe("needs_reauth");
  });

  it("asks for reconnecting when the stored credential is not one it reads", async () => {
    const userId = await newUser();
    await connectKey(userId);
    // A document in a shape this version no longer writes.
    await run(
      Effect.gen(function* () {
        const db = yield* Db;
        const cipher = yield* KeyCipher;
        const ciphertext = yield* cipher.encrypt(JSON.stringify({ kind: "api_key", apiKey: "x" }));
        yield* db
          .update(integrationConnections)
          .set({ credentialsCiphertext: ciphertext })
          .where(eq(integrationConnections.userId, userId));
      }),
    );
    const session = await run(
      Effect.flatMap(IntegrationService, (s) => s.session(userId, "outline")),
    );
    expect(Exit.isFailure(await runtime.runPromiseExit(session.credential))).toBe(true);
    const mine = await outlineFor(userId);
    expect(mine?.connection?.status).toBe("needs_reauth");
  });
});

describe("what a chat is offered", () => {
  it("follows the connection default, then the chat's own choice, then a fire's grants", async () => {
    const userId = await newUser();
    await connectKey(userId);
    const conversationId = uuidv7();
    await insert((db) => db.insert(conversations).values({ id: conversationId, userId }));
    const offered = (grants: ReadonlyArray<IntegrationGrant> | null) =>
      run(
        Effect.flatMap(IntegrationService, (s) =>
          s.resolveOffer({ userId, conversationId, grants }),
        ),
      ).then((offers) => offers.map((offer) => [offer.integrationId, offer.unattended]));

    expect(await offered(null)).toEqual([["outline", null]]);
    await run(
      Effect.flatMap(IntegrationService, (s) =>
        s.setConversationIntegration(userId, conversationId, "outline", { enabled: false }),
      ),
    );
    expect(await offered(null)).toEqual([]);
    // A fire ignores the chat's toggles: its grants are the whole offer.
    expect(await offered([{ integrationId: "outline", access: "read" }])).toEqual([
      ["outline", { access: "read", allowances: {} }],
    ]);
    expect(await offered([])).toEqual([]);
  });

  it("defaults an agent's chat to what the agent attached", async () => {
    const userId = await newUser();
    await connectKey(userId);
    const conversationId = uuidv7();
    const agentId = uuidv7();
    await insert((db) =>
      Effect.gen(function* () {
        yield* db.insert(conversations).values({ id: conversationId, userId });
        yield* db
          .insert(agents)
          .values({ id: agentId, userId, name: "Helper", instructions: "Help." });
        yield* db.insert(conversationAgents).values({ conversationId, agentId });
      }),
    );
    const chat = () =>
      run(Effect.flatMap(IntegrationService, (s) => s.chatIntegrations(userId, conversationId)));
    expect((await chat())[0]).toMatchObject({ enabled: false, defaultEnabled: false });
    await insert((db) =>
      db.insert(agentIntegrations).values({ agentId, integrationId: "outline" }),
    );
    expect((await chat())[0]).toMatchObject({ enabled: true, defaultEnabled: true });
  });

  it("merges per-tool permissions and keeps a chat's allowances to that chat", async () => {
    const userId = await newUser();
    await connectKey(userId);
    const [first, second] = [uuidv7(), uuidv7()];
    await insert((db) =>
      db.insert(conversations).values([
        { id: first, userId },
        { id: second, userId },
      ]),
    );
    const permissions = (conversationId: string) =>
      run(
        Effect.flatMap(IntegrationService, (s) =>
          s.permissionsFor(userId, conversationId, "outline"),
        ),
      );
    expect(await permissions(first)).toEqual({ permissions: {}, allowedInChat: [] });

    // Two separate changes, one tool each: the second must not erase the first.
    const set = (toolPermissions: Record<string, "allow" | "ask" | "block">) =>
      run(
        Effect.flatMap(IntegrationService, (s) =>
          s.updatePreferences(userId, "outline", { toolPermissions }),
        ),
      );
    await set({ search: "block" });
    await set({ create_document: "allow" });
    expect((await permissions(first)).permissions).toEqual({
      search: "block",
      create_document: "allow",
    });

    const allow = (tool: string) =>
      run(
        Effect.flatMap(IntegrationService, (s) =>
          s.setConversationIntegration(userId, first, "outline", { allowTool: tool }),
        ),
      );
    await allow("update_document");
    await allow("update_document");
    await allow("read_document");
    expect([...(await permissions(first)).allowedInChat].toSorted()).toEqual([
      "read_document",
      "update_document",
    ]);
    expect((await permissions(second)).allowedInChat).toEqual([]);
  });
});

describe("chat tools", () => {
  const deleteTool = outlineAdapter.handlers.delete_document!;

  it("names what a delete will take before asking, and only ever trashes", async () => {
    // Built here: `baseUrl` exists only once the fake server is listening.
    const target = {
      config: { baseUrl },
      credential: Effect.succeed({
        kind: "api_key" as const,
        values: { key: "ol_api_good" },
      }),
      scope: Effect.succeed(null),
    };
    // The approval shows the service's title and what goes with it, not the model's id.
    const prepared = await run(deleteTool(target, { id: "d1" }));
    expect(prepared.summary).toBe("“Onboarding” and 1 nested page");
    // Preparing only reads; the trash happens when the approved call runs.
    expect(deleted).toEqual([]);
    const result = await run(prepared.execute);
    expect(result.output).toMatchObject({ title: "Onboarding", nestedDocuments: 1 });
    expect(deleted).toEqual([{ id: "d1" }]);
  });
});

describe("approvals", () => {
  const call = (callId: string) => ({
    callId,
    conversationId: "c",
    messageId: "m",
    integrationId: "outline",
    tool: "create_document",
    access: "write" as const,
    summary: "“Plan”",
    targets: [],
  });
  // Waits on the registration itself rather than on time.
  const waitForPending = (userId: string) =>
    Effect.flatMap(IntegrationApprovals, (approvals) => approvals.pending(userId)).pipe(
      Effect.repeat({ until: (pending) => pending.length > 0 }),
    );

  it("parks a call until its owner answers, and only its owner", async () => {
    const answer = await run(
      Effect.gen(function* () {
        const approvals = yield* IntegrationApprovals;
        const waiting = yield* Effect.forkChild(approvals.request("owner", call("k1")));
        yield* waitForPending("owner");
        expect(yield* approvals.decide("someone-else", "k1", "allow")).toBe(false);
        expect(yield* approvals.decide("owner", "k1", "deny")).toBe(true);
        return yield* Fiber.join(waiting);
      }),
    );
    expect(answer).toBe("deny");
    expect(await run(Effect.flatMap(IntegrationApprovals, (a) => a.pending("owner")))).toEqual([]);
  });

  it("leaves nothing to approve once the answer is stopped", async () => {
    const late = await run(
      Effect.gen(function* () {
        const approvals = yield* IntegrationApprovals;
        const waiting = yield* Effect.forkChild(approvals.request("owner", call("k2")));
        yield* waitForPending("owner");
        yield* Fiber.interrupt(waiting);
        return yield* approvals.decide("owner", "k2", "allow");
      }),
    );
    expect(late).toBe(false);
  });

  it.each(["block", "disable", "allow", "unprompted"] as const)(
    "checks a tool call after %s before publishing",
    async (change) => {
      await configure();
      const userId = await newUser();
      await connectKey(userId);
      const conversationId = uuidv7();
      await insert((db) => db.insert(conversations).values({ id: conversationId, userId }));
      created.length = 0;
      const result = await run(
        Effect.gen(function* () {
          const service = yield* IntegrationService;
          const approvals = yield* IntegrationApprovals;
          const offered = yield* service.resolveOffer({ userId, conversationId, grants: null });
          const prepared = prepareIntegrationTools({
            offered,
            indexer: createSourceIndexer([]),
            approvals,
            owner: { userId, conversationId, messageId: "answer" },
            permissionsFor: (integrationId) =>
              service.permissionsFor(userId, conversationId, integrationId),
            sessionFor: (integrationId) =>
              service.session(userId, integrationId).pipe(Effect.orElseSucceed(() => null)),
            rowIdFor: () => Effect.succeed("pending-call"),
            reportAuthFailure: (session) =>
              service.reportAuthFailure({ userId, connectionId: session.connectionId }),
            allowanceUses: unlimited,
          });
          const handler = prepared?.group.handlers.int_outline__create_document as
            | ((
                args: Record<string, unknown>,
                context: { toolCallId: string },
              ) => Effect.Effect<IntegrationModelResult>)
            | undefined;
          if (!handler) throw new Error("create document was not offered");
          if (change === "unprompted")
            yield* service.updatePreferences(userId, "outline", {
              toolPermissions: { create_document: "allow" },
            });
          const waiting = yield* Effect.forkChild(
            handler({ title: "Plan", collectionId: "c1", text: "Content" }, { toolCallId: "call" }),
          );
          if (change !== "unprompted") yield* waitForPending(userId);
          if (change === "block")
            yield* service.updatePreferences(userId, "outline", {
              toolPermissions: { create_document: "block" },
            });
          if (change === "disable")
            yield* service.saveConfig({
              id: "outline",
              name: "Outline",
              enabled: false,
              config: { baseUrl },
              oauthClientId: "client",
              oauthClientSecret: "secret",
              allowApiKeys: true,
            });
          if (change !== "unprompted")
            expect(yield* approvals.decide(userId, "pending-call", "allow")).toBe(true);
          return yield* Fiber.join(waiting);
        }),
      );
      expect(result.ok).toBe(change === "allow" || change === "unprompted");
      expect(created).toHaveLength(change === "allow" || change === "unprompted" ? 1 : 0);
      await configure();
    },
  );
});

describe("prepared calls", () => {
  const offeredHandler = (
    userId: string,
    conversationId: string,
    grants: ReadonlyArray<IntegrationGrant> | null,
    tool: string,
  ) =>
    Effect.gen(function* () {
      const service = yield* IntegrationService;
      const approvals = yield* IntegrationApprovals;
      const offered = yield* service.resolveOffer({ userId, conversationId, grants });
      const prepared = prepareIntegrationTools({
        offered,
        indexer: createSourceIndexer([]),
        approvals,
        owner: { userId, conversationId, messageId: "answer" },
        permissionsFor: (integrationId) =>
          service.permissionsFor(userId, conversationId, integrationId),
        sessionFor: (integrationId) =>
          service.session(userId, integrationId).pipe(Effect.orElseSucceed(() => null)),
        rowIdFor: () => Effect.succeed("pending-call"),
        reportAuthFailure: (session) =>
          service.reportAuthFailure({ userId, connectionId: session.connectionId }),
        allowanceUses: unlimited,
      });
      return prepared?.group.handlers[`int_outline__${tool}`] as (
        args: Record<string, unknown>,
        context: { toolCallId: string },
      ) => Effect.Effect<IntegrationModelResult>;
    });

  const setup = async () => {
    await configure();
    const userId = await newUser();
    await connectKey(userId);
    const conversationId = uuidv7();
    await insert((db) => db.insert(conversations).values({ id: conversationId, userId }));
    return { userId, conversationId };
  };

  it("explains a malformed call without asking anyone", async () => {
    const { userId, conversationId } = await setup();
    const result = await run(
      Effect.gen(function* () {
        const handler = yield* offeredHandler(userId, conversationId, null, "create_document");
        return yield* handler({ text: "No title" }, { toolCallId: "call" });
      }),
    );
    expect(result).toMatchObject({ ok: false, error: "Pass `title`." });
    expect(await run(Effect.flatMap(IntegrationApprovals, (a) => a.pending(userId)))).toEqual([]);
  });

  it("names why a scheduled run may not make a change", async () => {
    const { userId, conversationId } = await setup();
    deleted.length = 0;
    const fire = (access: "read" | "write", tool: string, args: Record<string, unknown>) =>
      run(
        Effect.gen(function* () {
          const handler = yield* offeredHandler(
            userId,
            conversationId,
            [{ integrationId: "outline", access }],
            tool,
          );
          return yield* handler(args, { toolCallId: "call" });
        }),
      );
    expect(
      await fire("read", "create_document", { title: "Plan", collectionId: "c1" }),
    ).toMatchObject({ refused: true, error: expect.stringContaining("only allowed to read") });
    expect(await fire("write", "delete_document", { id: "d1" })).toMatchObject({
      refused: true,
      error: expect.stringContaining("never delete documents"),
    });
    expect(deleted).toEqual([]);
  });
});

describe("allowance uses", () => {
  const answer = async () => {
    const userId = await newUser();
    const conversationId = uuidv7();
    const messageId = uuidv7();
    await insert((db) => db.insert(conversations).values({ id: conversationId, userId }));
    await insert((db) =>
      db.insert(messages).values({
        id: messageId,
        conversationId,
        generationId: uuidv7(),
        role: "assistant",
        status: "streaming",
      }),
    );
    return messageId;
  };

  it("hands out at most the cap, however many calls race for it", async () => {
    const messageId = await answer();
    const use = { messageId, integrationId: "outline", allowanceId: "send" };
    const taken = await run(
      Effect.flatMap(IntegrationRepo, (repo) =>
        Effect.all(
          Array.from({ length: 8 }, () => repo.reserveAllowance({ ...use, cap: 3 })),
          { concurrency: "unbounded" },
        ),
      ),
    );
    expect(taken.filter(Boolean)).toHaveLength(3);
    // Each allowance and each answer counts on its own.
    expect(
      await run(
        Effect.flatMap(IntegrationRepo, (repo) =>
          repo.reserveAllowance({ ...use, allowanceId: "invite", cap: 3 }),
        ),
      ),
    ).toBe(true);
    const other = await answer();
    expect(
      await run(
        Effect.flatMap(IntegrationRepo, (repo) =>
          repo.reserveAllowance({ ...use, messageId: other, cap: 3 }),
        ),
      ),
    ).toBe(true);
  });

  it("lets a use given back be taken again", async () => {
    const messageId = await answer();
    const use = { messageId, integrationId: "outline", allowanceId: "send" };
    const again = await run(
      Effect.gen(function* () {
        const repo = yield* IntegrationRepo;
        yield* repo.reserveAllowance({ ...use, cap: 1 });
        const full = yield* repo.reserveAllowance({ ...use, cap: 1 });
        yield* repo.releaseAllowance(use);
        return { full, after: yield* repo.reserveAllowance({ ...use, cap: 1 }) };
      }),
    );
    expect(again).toEqual({ full: false, after: true });
  });
});

describe("knowledge sync", () => {
  const mirrored = (collectionId: string) =>
    insert((db) =>
      db
        .select({ externalId: knowledgeDocuments.externalId })
        .from(knowledgeDocuments)
        .where(eq(knowledgeDocuments.collectionId, collectionId)),
    ).then((rows) => rows.map((row) => row.externalId).toSorted());
  const versions = (collectionId: string) =>
    insert((db) =>
      db
        .select({ total: count() })
        .from(knowledgeDocumentVersions)
        .innerJoin(
          knowledgeDocuments,
          eq(knowledgeDocuments.id, knowledgeDocumentVersions.documentId),
        )
        .where(eq(knowledgeDocuments.collectionId, collectionId)),
    ).then(([row]) => Number(row?.total ?? 0));
  const sources = <A, E>(f: (s: KnowledgeSourceService["Service"]) => Effect.Effect<A, E>) =>
    run(Effect.flatMap(KnowledgeSourceService, f));
  const collectionFor = async (userId: string) => {
    const collectionId = uuidv7();
    await insert((db) =>
      db.insert(knowledgeCollections).values({ id: collectionId, userId, name: "Handbook" }),
    );
    return collectionId;
  };

  const handbook = (
    mode: "all" | "selected",
    rules: Array<{ nodeId: string; title: string; mode: "include" | "exclude" }> = [],
  ) => ({ nodeId: "collection:c1", title: "Handbook", mode, rules });

  it("takes everything under a root except what is left out, and follows edits", async () => {
    const userId = await newUser();
    await connectKey(userId);
    const collectionId = await collectionFor(userId);

    const source = await sources((s) =>
      s.save(userId, {
        collectionId,
        integrationId: "outline",
        root: handbook("all", [{ nodeId: "document:d1", title: "Onboarding", mode: "exclude" }]),
      }),
    );
    await sources((s) => s.tick);
    // Leaving a page out takes its child with it.
    expect(await mirrored(collectionId)).toEqual(["document:d3"]);
    const [view] = await sources((s) => s.list(userId, collectionId));
    expect(view).toMatchObject({ status: "idle", stats: { synced: 1, tooLarge: 0, overLimit: 0 } });

    // Nothing changed at the source: nothing new is published.
    const settled = await versions(collectionId);
    await sources((s) => s.syncNow(userId, source.id));
    await sources((s) => s.tick);
    expect(await versions(collectionId)).toBe(settled);

    bodies.set("d3", { text: "Thirty days now.", updatedAt: "2026-09-20T00:00:00.000Z" });
    await sources((s) => s.syncNow(userId, source.id));
    await sources((s) => s.tick);
    expect(await versions(collectionId)).toBe(settled + 1);

    await sources((s) => s.remove(userId, source.id));
    expect(await mirrored(collectionId)).toEqual([]);
  });

  it("takes only the picked pages, and pages added under them later", async () => {
    const userId = await newUser();
    await connectKey(userId);
    const collectionId = await collectionFor(userId);
    await sources((s) =>
      s.save(userId, {
        collectionId,
        integrationId: "outline",
        root: handbook("selected", [
          { nodeId: "document:d1", title: "Onboarding", mode: "include" },
        ]),
      }),
    );
    await sources((s) => s.tick);
    // The picked page and the page under it; its sibling stays out.
    expect(await mirrored(collectionId)).toEqual(["document:d1", "document:d2"]);
  });

  it("removes a page deleted at the source from the index", async () => {
    const userId = await newUser();
    await connectKey(userId);
    const collectionId = await collectionFor(userId);
    const source = await sources((s) =>
      s.save(userId, { collectionId, integrationId: "outline", root: handbook("all") }),
    );
    await sources((s) => s.tick);
    expect(await mirrored(collectionId)).toEqual(["document:d1", "document:d2", "document:d3"]);

    // Deleted in Outline: gone from its tree and its listing alike.
    const holidays = tree.splice(1, 1);
    const holidaysBody = bodies.get("d3")!;
    bodies.delete("d3");
    try {
      await sources((s) => s.syncNow(userId, source.id));
      await sources((s) => s.tick);
      expect(await mirrored(collectionId)).toEqual(["document:d1", "document:d2"]);
    } finally {
      tree.push(...holidays);
      bodies.set("d3", holidaysBody);
    }
  });

  it("lists only what changed after the first sync, and still sees added and deleted pages", async () => {
    const userId = await newUser();
    await connectKey(userId);
    const collectionId = await collectionFor(userId);
    const source = await sources((s) =>
      s.save(userId, { collectionId, integrationId: "outline", root: handbook("all") }),
    );
    await sources((s) => s.tick);
    expect(await mirrored(collectionId)).toEqual(["document:d1", "document:d2", "document:d3"]);

    // A page added in Outline arrives on the next, incremental sync, and the
    // unchanged pages are neither listed with text nor fetched one by one.
    tree.push({ id: "d4", title: "Expenses", url: "/doc/expenses", children: [] });
    titles.d4 = "Expenses";
    bodies.set("d4", { text: "Keep receipts.", updatedAt: "2026-09-22T00:00:00.000Z" });
    try {
      apiCalls.length = 0;
      await sources((s) => s.syncNow(userId, source.id));
      await sources((s) => s.tick);
      expect(await mirrored(collectionId)).toEqual([
        "document:d1",
        "document:d2",
        "document:d3",
        "document:d4",
      ]);
      expect(apiCalls.filter((call) => call === "/api/documents.info")).toEqual([]);
    } finally {
      tree.pop();
      bodies.delete("d4");
      delete titles.d4;
    }
    // Gone from the tree on the next sync, though nothing new was listed.
    await sources((s) => s.syncNow(userId, source.id));
    await sources((s) => s.tick);
    expect(await mirrored(collectionId)).toEqual(["document:d1", "document:d2", "document:d3"]);
  });

  it("does not download an oversized page again until it changes", async () => {
    const userId = await newUser();
    await connectKey(userId);
    const collectionId = await collectionFor(userId);
    const original = bodies.get("d3")!;
    bodies.set("d3", { text: "x".repeat(200_001), updatedAt: original.updatedAt });
    try {
      const source = await sources((s) =>
        s.save(userId, {
          collectionId,
          integrationId: "outline",
          root: handbook("selected", [
            { nodeId: "document:d3", title: "Holidays", mode: "include" },
          ]),
        }),
      );
      await sources((s) => s.tick);
      const [first] = await sources((s) => s.list(userId, collectionId));
      expect(first?.stats).toMatchObject({ synced: 0, tooLarge: 1 });

      apiCalls.length = 0;
      await sources((s) => s.syncNow(userId, source.id));
      await sources((s) => s.tick);
      const [second] = await sources((s) => s.list(userId, collectionId));
      expect(second?.stats).toMatchObject({ tooLarge: 1 });
      expect(apiCalls.filter((call) => call === "/api/documents.info")).toEqual([]);
    } finally {
      bodies.set("d3", original);
    }
  });

  it("shows a shared collection's sources to its readers, read-only", async () => {
    const owner = await newUser();
    const reader = await newUser();
    await connectKey(owner);
    const collectionId = await collectionFor(owner);
    await insert((db) =>
      db
        .update(knowledgeCollections)
        .set({ audience: "instance" })
        .where(eq(knowledgeCollections.id, collectionId)),
    );
    await sources((s) =>
      s.save(owner, { collectionId, integrationId: "outline", root: handbook("all") }),
    );
    expect(await sources((s) => s.list(owner, collectionId))).toMatchObject([{ canEdit: true }]);
    expect(await sources((s) => s.list(reader, collectionId))).toMatchObject([{ canEdit: false }]);
  });

  it("clears a source whose collection no longer exists and says so", async () => {
    const userId = await newUser();
    await connectKey(userId);
    const collectionId = await collectionFor(userId);
    await sources((s) =>
      s.save(userId, {
        collectionId,
        integrationId: "outline",
        root: { nodeId: "collection:gone", title: "Archive", mode: "all", rules: [] },
      }),
    );
    await sources((s) => s.tick);
    const [view] = await sources((s) => s.list(userId, collectionId));
    expect(view?.status).toBe("error");
    expect(view?.lastError).toContain("“Archive”");
  });

  it("syncs from a page as well as from a whole collection", async () => {
    const userId = await newUser();
    await connectKey(userId);
    const collectionId = await collectionFor(userId);
    await sources((s) =>
      s.save(userId, {
        collectionId,
        integrationId: "outline",
        root: { nodeId: "document:d1", title: "Onboarding", mode: "all", rules: [] },
      }),
    );
    await sources((s) => s.tick);
    expect(await mirrored(collectionId)).toEqual(["document:d1", "document:d2"]);
  });

  it("lets one collection hold several sources, the same Outline collection too", async () => {
    const userId = await newUser();
    await connectKey(userId);
    const collectionId = await collectionFor(userId);
    const pick = (nodeId: string, title: string) =>
      sources((s) =>
        s.save(userId, {
          collectionId,
          integrationId: "outline",
          root: handbook("selected", [{ nodeId, title, mode: "include" }]),
        }),
      );
    await pick("document:d1", "Onboarding");
    await pick("document:d3", "Holidays");
    // One sync per collection at a time, so each pass takes the next source.
    await sources((s) => s.tick);
    await sources((s) => s.tick);
    expect(await mirrored(collectionId)).toEqual(["document:d1", "document:d2", "document:d3"]);
    expect(await sources((s) => s.list(userId, collectionId))).toHaveLength(2);
  });

  it("never indexes a page twice when sources overlap, and hands it over", async () => {
    const userId = await newUser();
    await connectKey(userId);
    const collectionId = await collectionFor(userId);
    const whole = await sources((s) =>
      s.save(userId, { collectionId, integrationId: "outline", root: handbook("all") }),
    );
    await sources((s) => s.tick);
    const page = await sources((s) =>
      s.save(userId, {
        collectionId,
        integrationId: "outline",
        root: { nodeId: "document:d1", title: "Onboarding", mode: "all", rules: [] },
      }),
    );
    await sources((s) => s.tick);
    expect(await mirrored(collectionId)).toEqual(["document:d1", "document:d2", "document:d3"]);
    const views = await sources((s) => s.list(userId, collectionId));
    expect(views.find((view) => view.id === page.id)?.stats?.elsewhere).toBe(2);

    // The first source lets go of the page; the other one takes it next.
    await sources((s) =>
      s.save(userId, {
        collectionId,
        integrationId: "outline",
        sourceId: whole.id,
        root: handbook("all", [{ nodeId: "document:d1", title: "Onboarding", mode: "exclude" }]),
      }),
    );
    await sources((s) => s.tick);
    await sources((s) => s.syncNow(userId, page.id));
    await sources((s) => s.tick);
    expect(await mirrored(collectionId)).toEqual(["document:d1", "document:d2", "document:d3"]);
    const owners = await insert((db) =>
      db
        .select({
          externalId: knowledgeDocuments.externalId,
          sourceId: knowledgeDocuments.sourceId,
        })
        .from(knowledgeDocuments)
        .where(eq(knowledgeDocuments.collectionId, collectionId)),
    );
    expect(
      owners
        .filter((row) => row.sourceId === page.id)
        .map((row) => row.externalId)
        .toSorted(),
    ).toEqual(["document:d1", "document:d2"]);
  });

  it("pauses while the owner is disconnected and resumes when they reconnect", async () => {
    const userId = await newUser();
    await connectKey(userId);
    const collectionId = await collectionFor(userId);
    await sources((s) =>
      s.save(userId, {
        collectionId,
        integrationId: "outline",
        root: handbook("selected", [{ nodeId: "document:d3", title: "Holidays", mode: "include" }]),
      }),
    );
    await sources((s) => s.tick);

    await run(Effect.flatMap(IntegrationService, (s) => s.disconnect(userId, "outline")));
    const [paused] = await sources((s) => s.list(userId, collectionId));
    expect(paused).toMatchObject({ connected: false });
    // Nothing synced is dropped while paused.
    expect(await mirrored(collectionId)).toEqual(["document:d3"]);

    // A new connection row: the source follows it without being edited.
    await connectKey(userId);
    await sources((s) => s.tick);
    const [resumed] = await sources((s) => s.list(userId, collectionId));
    expect(resumed).toMatchObject({ connected: true, status: "idle", lastError: null });
    expect(await mirrored(collectionId)).toEqual(["document:d3"]);
  });

  it("records the error and keeps what it had when the owner's connection is gone", async () => {
    const userId = await newUser();
    await connectKey(userId);
    const collectionId = await collectionFor(userId);
    const source = await sources((s) =>
      s.save(userId, {
        collectionId,
        integrationId: "outline",
        root: handbook("selected", [{ nodeId: "document:d2", title: "Laptop", mode: "include" }]),
      }),
    );
    await sources((s) => s.tick);
    expect(await mirrored(collectionId)).toEqual(["document:d2"]);

    await insert((db) =>
      db
        .update(integrationConnections)
        .set({ status: "needs_reauth" })
        .where(eq(integrationConnections.userId, userId)),
    );
    await sources((s) => s.syncNow(userId, source.id));
    await sources((s) => s.tick);
    const [after] = await sources((s) => s.list(userId, collectionId));
    expect(after).toMatchObject({ status: "error", connected: false });
    expect(await mirrored(collectionId)).toEqual(["document:d2"]);
  });
});

describe("several integrations of one type", () => {
  // A second Outline, with its own accounts, to tell where each call lands.
  let second: Server;
  let secondUrl: string;
  const secondCalls: string[] = [];
  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        second = createServer(async (request, response) => {
          await readBody(request);
          const json = (value: unknown) =>
            response
              .writeHead(200, { "content-type": "application/json" })
              .end(JSON.stringify(value));
          if (request.headers.authorization !== "Bearer ol_api_second")
            return response.writeHead(401).end("{}");
          secondCalls.push(request.url ?? "");
          if (request.url === "/api/auth.info")
            return json({ data: { user: { email: "ada@example.com" }, team: { name: "Second" } } });
          return json({ data: [], pagination: {} });
        }).listen(0, "127.0.0.1", () => {
          const address = second.address();
          secondUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
          resolve();
        });
      }),
  );
  afterAll(() => {
    second?.close();
  });

  const service = <A, E>(f: (s: IntegrationService["Service"]) => Effect.Effect<A, E>) =>
    run(Effect.flatMap(IntegrationService, f));
  const refusal = <A>(
    f: (s: IntegrationService["Service"]) => Effect.Effect<A, IntegrationRejected>,
  ) => service((s) => Effect.flip(f(s))).then((error) => error.reason);

  it("keeps two Outlines apart, from their names to where each call goes", async () => {
    await configure();
    // The second of a type gets the type's id, numbered.
    const docsB = await service((s) => s.createIntegration({ kind: "outline", name: "Docs B" }));
    expect(docsB.id).toBe("outline-2");
    await service((s) =>
      s.saveConfig({
        id: "outline-2",
        name: "Docs B",
        enabled: true,
        config: { baseUrl: secondUrl },
        oauthClientId: "",
        allowApiKeys: true,
      }),
    );
    // A name names one integration only.
    expect(await refusal((s) => s.createIntegration({ kind: "outline", name: "docs b" }))).toBe(
      "“docs b” is already in use.",
    );
    expect(await refusal((s) => s.createIntegration({ kind: "notion", name: "Notion" }))).toBe(
      "Unknown integration type.",
    );

    const userId = await newUser();
    await connectKey(userId);
    await service((s) => s.connectApiKey(userId, "outline-2", { key: "ol_api_second" }));
    const mine = await service((s) => s.listForUser(userId));
    expect(
      mine
        .filter((entry) => entry.kind === "outline")
        .map((entry) => [entry.id, entry.name, entry.connection?.accountLabel]),
    ).toEqual([
      ["outline-2", "Docs B", "ada@example.com · Second"],
      ["outline", "Outline", "ada@example.com · Acme"],
    ]);

    const conversationId = uuidv7();
    await insert((db) => db.insert(conversations).values({ id: conversationId, userId }));
    const before = apiCalls.length;
    const { names, description, result } = await run(
      Effect.gen(function* () {
        const integrations = yield* IntegrationService;
        const approvals = yield* IntegrationApprovals;
        const offered = yield* integrations.resolveOffer({ userId, conversationId, grants: null });
        const prepared = prepareIntegrationTools({
          offered,
          indexer: createSourceIndexer([]),
          approvals,
          owner: { userId, conversationId, messageId: "answer" },
          permissionsFor: (integrationId) =>
            integrations.permissionsFor(userId, conversationId, integrationId),
          sessionFor: (integrationId) =>
            integrations.session(userId, integrationId).pipe(Effect.orElseSucceed(() => null)),
          rowIdFor: () => Effect.succeed("call"),
          reportAuthFailure: () => Effect.void,
          allowanceUses: unlimited,
        })!;
        const search = prepared.group.handlers["int_outline-2__search"] as (
          args: Record<string, unknown>,
          context: { toolCallId: string },
        ) => Effect.Effect<IntegrationModelResult>;
        return {
          names: [...prepared.names.keys()].filter((name) => name.endsWith("__search")),
          description: prepared.group.toolkit.tools["int_outline-2__search"]?.description,
          result: yield* search({ query: "plan" }, { toolCallId: "call" }),
        };
      }),
    );
    expect(names.toSorted()).toEqual(["int_outline-2__search", "int_outline__search"]);
    // The model can tell the two apart by name.
    expect(description).toMatch(/^Docs B: /);
    expect(result).toMatchObject({ ok: true });
    expect(secondCalls).toContain("/api/documents.search");
    expect(apiCalls.length).toBe(before);

    // Deleting one waits for its knowledge sources, then takes its settings with it.
    await service((s) =>
      s.setConversationIntegration(userId, conversationId, "outline-2", { enabled: false }),
    );
    const collectionId = uuidv7();
    await insert((db) =>
      db.insert(knowledgeCollections).values({ id: collectionId, userId, name: "B" }),
    );
    const sourceId = uuidv7();
    await insert((db) =>
      db.insert(knowledgeSources).values({
        id: sourceId,
        collectionId,
        integrationId: "outline-2",
        root: { nodeId: "collection:c1", title: "Handbook", mode: "all", rules: [] },
      }),
    );
    expect(await refusal((s) => s.deleteIntegration("outline-2"))).toBe(
      "1 knowledge source mirrors it. Remove it first.",
    );
    await insert((db) => db.delete(knowledgeSources).where(eq(knowledgeSources.id, sourceId)));
    const scheduleId = uuidv7();
    await insert((db) =>
      db.insert(schedules).values({
        id: scheduleId,
        userId,
        name: "Weekly",
        prompt: "Summarize",
        scheduleText: "Every Monday",
        cron: "0 9 * * 1",
        timezone: "UTC",
        integrationGrants: [
          { integrationId: "outline", access: "read" },
          { integrationId: "outline-2", access: "write" },
        ],
      }),
    );
    await service((s) => s.deleteIntegration("outline-2"));
    // A schedule keeps its other grants and loses only the deleted one.
    const [schedule] = await insert((db) =>
      db
        .select({ grants: schedules.integrationGrants })
        .from(schedules)
        .where(eq(schedules.id, scheduleId)),
    );
    expect(schedule?.grants).toEqual([{ integrationId: "outline", access: "read" }]);
    const left = await service((s) => s.listForUser(userId));
    expect(left.map((entry) => entry.id)).not.toContain("outline-2");
    expect(
      await insert((db) =>
        db
          .select()
          .from(conversationIntegrations)
          .where(eq(conversationIntegrations.conversationId, conversationId)),
      ),
    ).toEqual([]);
    expect((await service((s) => s.directory())).map((entry) => entry.id)).not.toContain(
      "outline-2",
    );
  });
});
