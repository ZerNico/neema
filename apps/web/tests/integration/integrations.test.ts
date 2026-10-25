import { createServer, type IncomingMessage, type Server } from "node:http";
import { PgClient } from "@effect/sql-pg";
import { Client } from "pg";
import { count, eq, sql } from "drizzle-orm";
import { Cause, Effect, Exit, Fiber, Layer, ManagedRuntime, Redacted } from "effect";
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
  scheduleIntegrationGrants,
  schedules,
  messages,
  user,
} from "~/db/schema/index.ts";
import { outlineAdapter } from "~/modules/integrations/outline/server/adapter.ts";
import { IntegrationAuthFailed, type IntegrationRejected } from "~/modules/integrations/errors.ts";
import { outlineCall } from "~/modules/integrations/outline/server/client.ts";
import { IntegrationApprovals } from "~/modules/integrations/server/approvals.ts";
import { IntegrationRepo } from "~/modules/integrations/server/repo.ts";
import { IntegrationService } from "~/modules/integrations/server/service.ts";
import { ScheduleRepo } from "~/modules/schedules/server/repo.ts";
import { prepareIntegrationTools } from "~/modules/integrations/server/tools.ts";
import type { IntegrationGrant } from "~/modules/integrations/grant.ts";
import type { IntegrationModelResult } from "~/modules/integrations/tool-schema.ts";
import { createSourceIndexer } from "~/modules/tools/server/source-indexer.ts";
import { KnowledgeSourceService } from "~/modules/integrations/server/sync.ts";
import { KnowledgeRepo } from "~/modules/knowledge/server/repo.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import { seedEligibleSession } from "../fixtures/eligible-session.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 5).toString("base64");

type Services =
  | Db
  | KeyCipher
  | IntegrationRepo
  | IntegrationService
  | IntegrationApprovals
  | KnowledgeSourceService
  | KnowledgeRepo;

let database: TestDatabase;
let runtime: ManagedRuntime.ManagedRuntime<Services, unknown>;
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
/** The typed failure a refused call ended with, or the exit itself when it did not fail. */
const failureOf = (result: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(result) ? Cause.squash(result.cause) : result;

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
let beforeApiResponse: ((request: IncomingMessage) => Promise<void>) | null = null;
/** Runs while a code is being exchanged, before the token endpoint answers. */
let duringCodeExchange: (() => Promise<void>) | null = null;
/** Runs while a refresh token is being spent, before the token endpoint answers. */
let duringRefresh: (() => Promise<void>) | null = null;

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
          if (duringCodeExchange) await duringCodeExchange();
          validTokens.add("a-code");
          return json(200, { access_token: "a-code", refresh_token: "r-code", expires_in: 3600 });
        }
        if (duringRefresh) await duringRefresh();
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
      if (beforeApiResponse) await beforeApiResponse(request);
      const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
      if (!validTokens.has(token))
        return json(401, { ok: false, error: "authentication_required" });
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      apiCalls.push(request.url ?? "");
      switch (request.url) {
        case "/api/auth.info":
          return json(200, {
            // Outline's own id for the account, so signing in again reconnects it.
            // A `bo-` token is another person's account on the same workspace.
            data: token.startsWith("bo-")
              ? { user: { id: "user-bo", email: "bo@example.com" }, team: { name: "Acme" } }
              : { user: { id: "user-ada", email: "ada@example.com" }, team: { name: "Acme" } },
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
      yield* seedEligibleSession(id);
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

/** Saves a connection under the integration's current revision, as a sign-in that just began would. */
const saveAtCurrent = (
  repo: IntegrationRepo["Service"],
  input: Omit<Parameters<IntegrationRepo["Service"]["saveConnection"]>[0], "revision">,
) =>
  repo.getConfig(input.integrationId).pipe(
    Effect.flatMap((row) => repo.saveConnection({ ...input, revision: row!.revision })),
    Effect.flatMap((saved) => (saved ? Effect.succeed(saved) : Effect.die("setup moved"))),
  );

const insert = <A>(f: (db: Db["Service"]) => Effect.Effect<A, unknown>) =>
  run(Effect.flatMap(Db, f));

/** A schedule of the person's, with these grants. */
const scheduleWith = async (
  userId: string,
  grants: ReadonlyArray<{ connectionId: string; integrationId: string; access: "read" | "write" }>,
) => {
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
    }),
  );
  if (grants.length)
    await insert((db) =>
      db
        .insert(scheduleIntegrationGrants)
        .values(grants.map((grant) => ({ scheduleId, ...grant }))),
    );
  return scheduleId;
};

/** A schedule's grants as stored, an account that is gone as null. */
const grantsOf = (scheduleId: string) =>
  insert((db) =>
    db
      .select({
        connectionId: scheduleIntegrationGrants.connectionId,
        integrationId: scheduleIntegrationGrants.integrationId,
        access: scheduleIntegrationGrants.access,
      })
      .from(scheduleIntegrationGrants)
      .where(eq(scheduleIntegrationGrants.scheduleId, scheduleId))
      .orderBy(scheduleIntegrationGrants.access),
  );

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
        Effect.flip(
          on(userId, "outline", (account) =>
            s.updatePreferences(userId, account, { scope: ["x"] }),
          ),
        ),
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
        saveAtCurrent(repo, {
          accountKey: null,
          userId,
          integrationId: "jira",
          authKind: "api_key",
          credentials: { kind: "api_key", values: { email: "a@acme.test", token: "t" } },
          accountLabel: "a@acme.test",
          fingerprint: "acme.atlassian.net",
        }),
      ),
    );
    const session = await run(
      Effect.flatMap(IntegrationService, (s) =>
        on(userId, "jira", (account) => s.session(userId, account)),
      ),
    );
    expect(await run(session.scope)).toBeNull();
    const limit = (scope: string[] | null) =>
      run(
        Effect.flatMap(IntegrationService, (s) =>
          on(userId, "jira", (account) => s.updatePreferences(userId, account, { scope })),
        ),
      );
    await limit([" PROJ ", "OPS", "PROJ"]);
    // The same session sees the new limit: it is read per call.
    expect(await run(session.scope)).toEqual(["PROJ", "OPS"]);
    const jira = (await run(Effect.flatMap(IntegrationService, (s) => s.listForUser(userId)))).find(
      (entry) => entry.id === "jira",
    );
    expect(jira?.connections[0]?.scope).toEqual(["PROJ", "OPS"]);
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
    expect(failureOf(refused)).toMatchObject({
      _tag: "IntegrationRejected",
      reason: "The service did not accept that credential.",
    });
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
    expect(mine?.connections[0]).toMatchObject({
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
    expect(mine?.connections[0]?.status).toBe("needs_reauth");
    const session = await runtime.runPromiseExit(
      Effect.flatMap(IntegrationService, (s) =>
        on(userId, "outline", (account) => s.session(userId, account)),
      ),
    );
    expect(failureOf(session)).toMatchObject({
      _tag: "IntegrationNotAvailable",
      integrationId: "outline",
    });
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

    expect(failureOf(await complete("another-browser"))).toMatchObject({
      _tag: "IntegrationRejected",
      reason:
        "This sign-in link expired or was opened in another browser. Start again from Settings.",
    });
    expect(Exit.isSuccess(await complete(started.state))).toBe(true);
    const mine = await outlineFor(userId);
    expect(mine?.connections[0]).toMatchObject({ authKind: "oauth", status: "active" });
    // The state is spent once used.
    expect(failureOf(await complete(started.state))).toMatchObject({
      _tag: "IntegrationRejected",
      reason:
        "This sign-in link expired or was opened in another browser. Start again from Settings.",
    });
  });

  it("spends no sign-in code once the admin pointed the integration elsewhere", async () => {
    const userId = await newUser();
    const started = await run(
      Effect.flatMap(IntegrationService, (s) =>
        s.beginOAuth(userId, "outline", "https://chat.example.com"),
      ),
    );
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
    const before = tokenCalls.length;
    try {
      const refused = await run(
        Effect.flatMap(IntegrationService, (s) =>
          Effect.flip(
            s.completeOAuth(userId, "outline", {
              code: "good-code",
              state: started.state,
              cookieState: started.state,
              iss: null,
            }),
          ),
        ),
      );
      expect(refused).toMatchObject({ reason: expect.stringMatching(/setup changed/) });
      expect(tokenCalls.length).toBe(before);
      expect((await outlineFor(userId))?.connections[0]).toBeUndefined();
    } finally {
      await configure();
    }
  });

  it("saves no sign-in whose client the admin replaced while the code was exchanged", async () => {
    const userId = await newUser();
    const started = await run(
      Effect.flatMap(IntegrationService, (s) =>
        s.beginOAuth(userId, "outline", "https://chat.example.com"),
      ),
    );
    // Same server, another client: the revision moves, the fingerprint does not.
    duringCodeExchange = async () => {
      duringCodeExchange = null;
      await run(
        Effect.flatMap(IntegrationService, (s) =>
          s.saveConfig({
            id: "outline",
            name: "Outline",
            enabled: true,
            config: { baseUrl },
            oauthClientId: "another-client",
            oauthClientSecret: "another-secret",
            allowApiKeys: true,
          }),
        ),
      );
    };
    try {
      const refused = await run(
        Effect.flatMap(IntegrationService, (s) =>
          Effect.flip(
            s.completeOAuth(userId, "outline", {
              code: "good-code",
              state: started.state,
              cookieState: started.state,
              iss: null,
            }),
          ),
        ),
      );
      expect(duringCodeExchange).toBeNull();
      expect(refused).toMatchObject({ reason: expect.stringMatching(/setup changed/) });
      expect((await outlineFor(userId))?.connections[0]).toBeUndefined();
    } finally {
      duringCodeExchange = null;
      await configure();
    }
  });

  it("gives a session made before a move away and back no credential", async () => {
    const userId = await newUser();
    await connectKey(userId);
    const before = await run(
      Effect.flatMap(IntegrationService, (s) =>
        on(userId, "outline", (account) => s.session(userId, account)),
      ),
    );
    const moveTo = (baseUrlNow: string) =>
      run(
        Effect.flatMap(IntegrationService, (s) =>
          s.saveConfig({
            id: "outline",
            name: "Outline",
            enabled: true,
            config: { baseUrl: baseUrlNow },
            oauthClientId: "client",
            allowApiKeys: true,
          }),
        ),
      );
    try {
      await moveTo("https://elsewhere.example.com");
      await moveTo(baseUrl);
      await connectKey(userId);
      // Same address as before, but another setup: the old session gets nothing.
      expect(failureOf(await runtime.runPromiseExit(before.credential))).toMatchObject({
        _tag: "IntegrationRequestFailed",
        message: "This integration is no longer connected.",
      });
      const after = await run(
        Effect.flatMap(IntegrationService, (s) =>
          on(userId, "outline", (account) => s.session(userId, account)),
        ),
      );
      expect(await run(after.credential)).toMatchObject({ kind: "api_key" });
    } finally {
      await configure();
    }
  });

  it("rotates an expired token once however many callers need it", async () => {
    const userId = await newUser();
    await run(
      Effect.flatMap(IntegrationRepo, (repo) =>
        saveAtCurrent(repo, {
          accountKey: "user-ada",
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
    const [beforeConnection] = await insert((db) =>
      db.select().from(integrationConnections).where(eq(integrationConnections.userId, userId)),
    );
    const before = tokenCalls.length;
    const session = await run(
      Effect.flatMap(IntegrationService, (s) =>
        on(userId, "outline", (account) => s.session(userId, account)),
      ),
    );
    const tokens = await run(
      Effect.all(
        Array.from({ length: 5 }, () => session.credential),
        { concurrency: "unbounded" },
      ),
    );
    const [afterConnection] = await insert((db) =>
      db.select().from(integrationConnections).where(eq(integrationConnections.userId, userId)),
    );
    expect(afterConnection!.accountEpoch).toBe(beforeConnection!.accountEpoch);
    expect(afterConnection!.credentialRevision).not.toBe(beforeConnection!.credentialRevision);
    expect(tokens).toEqual(
      Array.from({ length: 5 }, () => ({
        kind: "oauth",
        accessToken: "a2",
        identity: {
          connectionId: afterConnection!.id,
          accountEpoch: afterConnection!.accountEpoch,
          credentialRevision: afterConnection!.credentialRevision,
        },
      })),
    );
    expect(tokenCalls.slice(before)).toEqual(["refresh_token"]);
  });

  it("holds no lock while the token endpoint answers, and keeps a reconnect made meanwhile", async () => {
    const userId = await newUser();
    const refreshToken = uuidv7();
    refreshTokens.set(refreshToken, { access: `late-${userId}`, refresh: uuidv7() });
    await run(
      Effect.flatMap(IntegrationRepo, (repo) =>
        saveAtCurrent(repo, {
          accountKey: "user-ada",
          userId,
          integrationId: "outline",
          authKind: "oauth",
          credentials: { kind: "oauth", accessToken: "expired", refreshToken, expiresAt: 0 },
          accountLabel: "ada",
          fingerprint: baseUrl,
        }),
      ),
    );
    const session = await run(
      Effect.flatMap(IntegrationService, (s) =>
        on(userId, "outline", (account) => s.session(userId, account)),
      ),
    );
    const reached = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<void>();
    duringRefresh = async () => {
      reached.resolve();
      await answer.promise;
    };
    try {
      const credential = runtime.runPromiseExit(session.credential);
      await reached.promise;
      // Would wait on the connection's row lock if the refresh still held it.
      await connectKey(userId);
      answer.resolve();
      expect(failureOf(await credential)).toMatchObject({
        _tag: "IntegrationRequestFailed",
        message: "The sign-in changed while it was refreshed.",
      });
      const after = await run(
        Effect.flatMap(IntegrationService, (s) =>
          on(userId, "outline", (account) => s.session(userId, account)),
        ),
      );
      expect(await run(after.credential)).toMatchObject({ kind: "api_key" });
    } finally {
      duringRefresh = null;
      answer.resolve();
    }
  });

  it("keeps a rotated token when the settings are saved while it is refreshed", async () => {
    const userId = await newUser();
    const refreshToken = uuidv7();
    const rotated = uuidv7();
    refreshTokens.set(refreshToken, { access: `kept-${userId}`, refresh: rotated });
    await run(
      Effect.flatMap(IntegrationRepo, (repo) =>
        saveAtCurrent(repo, {
          accountKey: "user-ada",
          userId,
          integrationId: "outline",
          authKind: "oauth",
          credentials: { kind: "oauth", accessToken: "expired", refreshToken, expiresAt: 0 },
          accountLabel: "ada",
          fingerprint: baseUrl,
        }),
      ),
    );
    const session = await run(
      Effect.flatMap(IntegrationService, (s) =>
        on(userId, "outline", (account) => s.session(userId, account)),
      ),
    );
    const reached = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<void>();
    duringRefresh = async () => {
      reached.resolve();
      await answer.promise;
    };
    try {
      const credential = runtime.runPromiseExit(session.credential);
      await reached.promise;
      // An admin saving the settings moves the revision this session was made for.
      await configure();
      answer.resolve();
      expect(failureOf(await credential)).toMatchObject({
        _tag: "IntegrationRequestFailed",
        message: "This integration is no longer available.",
      });
    } finally {
      duringRefresh = null;
      answer.resolve();
    }
    // The spent refresh token was replaced, not lost: no reconnect is needed.
    const after = await run(
      Effect.flatMap(IntegrationService, (s) =>
        on(userId, "outline", (account) => s.session(userId, account)),
      ),
    );
    expect(await run(after.credential)).toMatchObject({
      kind: "oauth",
      accessToken: `kept-${userId}`,
    });
    expect((await outlineFor(userId))?.connections[0]?.status).toBe("active");
  });

  it("validates reconnect identity after waiting for the refresh lock before contacting OAuth", async () => {
    const userId = await newUser();
    await run(
      Effect.flatMap(IntegrationRepo, (repo) =>
        saveAtCurrent(repo, {
          accountKey: "user-ada",
          userId,
          integrationId: "outline",
          authKind: "oauth",
          credentials: {
            kind: "oauth",
            accessToken: "expired",
            refreshToken: "never-send",
            expiresAt: Date.now() - 1,
          },
          accountLabel: "ada",
          fingerprint: baseUrl,
        }),
      ),
    );
    const session = await run(
      Effect.flatMap(IntegrationService, (s) =>
        on(userId, "outline", (account) => s.session(userId, account)),
      ),
    );
    const blocker = new Client({ connectionString: database.url });
    await blocker.connect();
    await blocker.query("begin");
    const backend = await blocker.query<{ pid: number }>("select pg_backend_pid() as pid");
    const pid = backend.rows[0]!.pid;
    // Holds the refresh at its share lock; a reconnect only needs key share.
    await blocker.query(
      "select id from integration_configs where id = 'outline' for no key update",
    );
    const before = tokenCalls.length;
    const credential = runtime.runPromiseExit(session.credential);
    try {
      await run(
        Effect.promise(() =>
          blocker.query<{ waiting: boolean }>(
            `select exists (select 1 from pg_stat_activity where datname = current_database()
         and $1 = any(pg_blocking_pids(pid))) as waiting`,
            [pid],
          ),
        ).pipe(Effect.repeat({ until: (result) => result.rows[0]!.waiting })),
      );
      await run(
        Effect.flatMap(IntegrationRepo, (repo) =>
          saveAtCurrent(repo, {
            accountKey: "user-ada",
            userId,
            integrationId: "outline",
            authKind: "oauth",
            credentials: {
              kind: "oauth",
              accessToken: "replacement",
              refreshToken: "replacement-secret",
              expiresAt: Date.now() - 1,
            },
            accountLabel: "replacement",
            fingerprint: baseUrl,
          }),
        ),
      );
      await blocker.query("commit");
      expect(failureOf(await credential)).toMatchObject({
        _tag: "IntegrationRequestFailed",
        message: "This integration is no longer connected.",
      });
      expect(tokenCalls.length).toBe(before);
      expect((await outlineFor(userId))?.connections[0]?.status).toBe("active");
    } finally {
      await blocker.query("rollback");
      await blocker.end();
      await credential;
    }
  });

  it.each([false, true])(
    "rejects a retained session after reconnect (expired: %s)",
    async (expired) => {
      const userId = await newUser();
      await connectKey(userId);
      const session = await run(
        Effect.flatMap(IntegrationService, (s) =>
          on(userId, "outline", (account) => s.session(userId, account)),
        ),
      );
      const before = tokenCalls.length;
      const replacement = await run(
        Effect.flatMap(IntegrationRepo, (repo) =>
          saveAtCurrent(repo, {
            accountKey: "user-ada",
            userId,
            integrationId: "outline",
            authKind: "oauth",
            credentials: {
              kind: "oauth",
              accessToken: "replacement",
              refreshToken: "must-not-be-used",
              expiresAt: expired ? Date.now() - 1 : null,
            },
            accountLabel: "another account",
            fingerprint: baseUrl,
          }),
        ),
      );
      expect(replacement.id).toBe(session.connectionId);
      expect(replacement.accountEpoch).not.toBe(session.accountEpoch);
      expect(failureOf(await runtime.runPromiseExit(session.credential))).toMatchObject({
        _tag: "IntegrationRequestFailed",
        message: "This integration is no longer connected.",
      });
      expect(tokenCalls.length).toBe(before);
      expect((await outlineFor(userId))?.connections[0]?.status).toBe("active");
    },
  );

  it.each(["reconnect", "refresh"] as const)(
    "does not let a delayed 401 disable a %s successor",
    async (change) => {
      const userId = await newUser();
      const oldToken = `refused-${uuidv7()}`;
      const refreshToken = uuidv7();
      await run(
        Effect.flatMap(IntegrationRepo, (repo) =>
          saveAtCurrent(repo, {
            accountKey: "user-ada",
            userId,
            integrationId: "outline",
            authKind: "oauth",
            credentials: { kind: "oauth", accessToken: oldToken, refreshToken, expiresAt: null },
            accountLabel: "ada",
            fingerprint: baseUrl,
          }),
        ),
      );
      const session = await run(
        Effect.flatMap(IntegrationService, (s) =>
          on(userId, "outline", (account) => s.session(userId, account)),
        ),
      );
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      beforeApiResponse = async (request) => {
        if (request.headers.authorization === `Bearer ${oldToken}`) {
          entered.resolve();
          await release.promise;
        }
      };
      const request = run(Effect.flip(outlineCall(session, "auth.info", {})));
      try {
        await entered.promise;
        if (change === "reconnect") await connectKey(userId);
        else {
          refreshTokens.set(refreshToken, { access: `fresh-${userId}`, refresh: uuidv7() });
          await run(
            Effect.gen(function* () {
              const repo = yield* IntegrationRepo;
              const connection = (yield* repo.getConnection(userId, session.connectionId))!;
              const credentials = yield* repo.decrypt(connection);
              if (credentials?.kind !== "oauth") throw new Error("OAuth fixture missing");
              yield* (yield* Db)
                .update(integrationConnections)
                .set({
                  credentialsCiphertext: yield* repo.encrypt({
                    ...credentials,
                    expiresAt: Date.now() - 1,
                  }),
                })
                .where(eq(integrationConnections.id, connection.id));
            }),
          );
          await run(session.credential);
        }
        release.resolve();
        const failure = await request;
        expect(failure).toBeInstanceOf(IntegrationAuthFailed);
        if (failure._tag !== "IntegrationAuthFailed") throw new Error("Expected provider refusal");
        expect(failure.credential?.accountEpoch).toBe(session.accountEpoch);
        await run(
          Effect.flatMap(IntegrationService, (s) => s.reportAuthFailure({ userId, failure })),
        );
        expect((await outlineFor(userId))?.connections[0]?.status).toBe("active");
        const current = await run(
          Effect.flatMap(IntegrationService, (s) =>
            on(userId, "outline", (account) => s.session(userId, account)),
          ),
        );
        expect(await run(outlineCall(current, "auth.info", {}))).toBeDefined();
      } finally {
        release.resolve();
        beforeApiResponse = null;
        await request;
      }
    },
  );

  it("marks the current request revision despite a preference update, but ignores probes", async () => {
    const userId = await newUser();
    await connectKey(userId);
    const session = await run(
      Effect.flatMap(IntegrationService, (s) =>
        on(userId, "outline", (account) => s.session(userId, account)),
      ),
    );
    const credential = await run(session.credential);
    await run(
      Effect.flatMap(IntegrationService, (s) =>
        on(userId, "outline", (account) =>
          s.updatePreferences(userId, account, { offerByDefault: false }),
        ),
      ),
    );
    await run(
      Effect.flatMap(IntegrationService, (s) =>
        s.reportAuthFailure({
          userId,
          failure: new IntegrationAuthFailed({ integrationId: "outline" }),
        }),
      ),
    );
    expect((await outlineFor(userId))?.connections[0]?.status).toBe("active");
    await run(
      Effect.flatMap(IntegrationService, (s) =>
        s.reportAuthFailure({
          userId,
          failure: new IntegrationAuthFailed({
            integrationId: "outline",
            credential: credential.identity!,
          }),
        }),
      ),
    );
    expect((await outlineFor(userId))?.connections[0]?.status).toBe("needs_reauth");
  });

  it("marks a connection whose refresh the service refuses for reconnecting", async () => {
    const userId = await newUser();
    await run(
      Effect.flatMap(IntegrationRepo, (repo) =>
        saveAtCurrent(repo, {
          accountKey: "user-ada",
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
      Effect.flatMap(IntegrationService, (s) =>
        on(userId, "outline", (account) => s.session(userId, account)),
      ),
    );
    expect(failureOf(await runtime.runPromiseExit(session.credential))).toMatchObject({
      _tag: "IntegrationAuthFailed",
      integrationId: "outline",
    });
    const mine = await outlineFor(userId);
    expect(mine?.connections[0]?.status).toBe("needs_reauth");
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
      Effect.flatMap(IntegrationService, (s) =>
        on(userId, "outline", (account) => s.session(userId, account)),
      ),
    );
    expect(failureOf(await runtime.runPromiseExit(session.credential))).toMatchObject({
      _tag: "IntegrationAuthFailed",
      integrationId: "outline",
    });
    const mine = await outlineFor(userId);
    expect(mine?.connections[0]?.status).toBe("needs_reauth");
  });
});

describe("what a chat is offered", () => {
  it("writes first-turn choices on the supplied transaction, all or nothing", async () => {
    const userId = await newUser();
    await connectKey(userId);
    const account = await run(on(userId, "outline", Effect.succeed));
    const conversationId = uuidv7();
    const missing = await run(
      Effect.gen(function* () {
        const db = yield* Db;
        const repo = yield* IntegrationRepo;
        return yield* Effect.result(
          db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.insert(conversations).values({ id: conversationId, userId });
              yield* repo.setConversationChoices(tx, userId, conversationId, [
                { connectionId: account, enabled: true },
                { connectionId: "missing", enabled: false },
              ]);
            }),
          ),
        );
      }),
    );
    expect(missing).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "IntegrationNotAvailable", integrationId: null, connectionId: "missing" },
    });
    expect(
      await insert((db) =>
        db.select().from(conversations).where(eq(conversations.id, conversationId)),
      ),
    ).toEqual([]);
    expect(
      await insert((db) =>
        db
          .select()
          .from(conversationIntegrations)
          .where(eq(conversationIntegrations.conversationId, conversationId)),
      ),
    ).toEqual([]);
    await run(
      Effect.gen(function* () {
        const db = yield* Db;
        const repo = yield* IntegrationRepo;
        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.insert(conversations).values({ id: conversationId, userId });
            yield* repo.setConversationChoices(tx, userId, conversationId, [
              { connectionId: account, enabled: false },
            ]);
          }),
        );
      }),
    );
    const choices = await insert((db) =>
      db
        .select()
        .from(conversationIntegrations)
        .where(eq(conversationIntegrations.conversationId, conversationId)),
    );
    expect(choices).toMatchObject([{ connectionId: account, enabled: false }]);
  });

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
      ).then((offers) => offers.map((offer) => [offer.session.integration.id, offer.unattended]));

    expect(await offered(null)).toEqual([["outline", null]]);
    await run(
      Effect.flatMap(IntegrationService, (s) =>
        on(userId, "outline", (account) =>
          s.setConversationIntegration(userId, conversationId, account, { enabled: false }),
        ),
      ),
    );
    expect(await offered(null)).toEqual([]);
    // A fire ignores the chat's toggles: its grants are the whole offer.
    const account = await run(on(userId, "outline", Effect.succeed));
    expect(
      await offered([{ connectionId: account, integrationId: "outline", access: "read" }]),
    ).toEqual([["outline", { access: "read", allowances: {} }]]);
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
    // Another person naming this chat learns nothing of it, not even its own
    // switch: they get their own defaults.
    await run(
      Effect.flatMap(IntegrationService, (s) =>
        on(userId, "outline", (account) =>
          s.setConversationIntegration(userId, conversationId, account, { enabled: false }),
        ),
      ),
    );
    expect((await chat())[0]).toMatchObject({ enabled: false });
    const stranger = await newUser();
    await connectKey(stranger);
    const asked = (conversation: string | null) =>
      run(Effect.flatMap(IntegrationService, (s) => s.chatIntegrations(stranger, conversation)));
    expect(await asked(conversationId)).toEqual(await asked(null));
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
          on(userId, "outline", (account) => s.permissionsFor(userId, conversationId, account)),
        ),
      );
    expect(await permissions(first)).toEqual({ permissions: {}, allowedInChat: [] });

    // Two separate changes, one tool each: the second must not erase the first.
    const set = (toolPermissions: Record<string, "allow" | "ask" | "block">) =>
      run(
        Effect.flatMap(IntegrationService, (s) =>
          on(userId, "outline", (account) =>
            s.updatePreferences(userId, account, { toolPermissions }),
          ),
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
          on(userId, "outline", (account) =>
            s.setConversationIntegration(userId, first, account, { allowTool: tool }),
          ),
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
    connectionId: "account",
    account: null,
    tool: "create_document",
    label: "Create a document",
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
    expect(answer).toEqual({ answer: "deny", via: null });
    expect(await run(Effect.flatMap(IntegrationApprovals, (a) => a.pending("owner")))).toEqual([]);
  });

  it("takes a decision naming the question it answers, and records the app it came from", async () => {
    const answer = await run(
      Effect.gen(function* () {
        const approvals = yield* IntegrationApprovals;
        const waiting = yield* Effect.forkChild(approvals.request("owner", call("k3")));
        const [pending] = yield* waitForPending("owner");
        // Every approval is parked under its own nonce.
        expect(pending?.promptId).toEqual(expect.any(String));
        expect(
          yield* approvals.decide("owner", "k3", "allow", { promptId: "stale", via: "Claude" }),
        ).toBe(false);
        expect(
          yield* approvals.decide("owner", "k3", "allow", {
            promptId: pending!.promptId!,
            via: "Claude",
          }),
        ).toBe(true);
        return yield* Fiber.join(waiting);
      }),
    );
    expect(answer).toEqual({ answer: "allow", via: "Claude" });
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

  it.each(["block", "disable", "reconnect", "client", "allow", "unprompted"] as const)(
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
            permissionsFor: (connectionId) =>
              service.permissionsFor(userId, conversationId, connectionId),
            sessionFor: (connectionId) =>
              service.session(userId, connectionId).pipe(Effect.orElseSucceed(() => null)),
            rowIdFor: () => Effect.succeed("pending-call"),
            reportAuthFailure: (_session, failure) =>
              service.reportAuthFailure({ userId, failure }),
            reportMissingScopes: () => Effect.void,
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
            yield* on(userId, "outline", (account) =>
              service.updatePreferences(userId, account, {
                toolPermissions: { create_document: "allow" },
              }),
            );
          const waiting = yield* Effect.forkChild(
            handler({ title: "Plan", collectionId: "c1", text: "Content" }, { toolCallId: "call" }),
          );
          if (change !== "unprompted") yield* waitForPending(userId);
          if (change === "block")
            yield* on(userId, "outline", (account) =>
              service.updatePreferences(userId, account, {
                toolPermissions: { create_document: "block" },
              }),
            );
          if (change === "reconnect")
            yield* service.connectApiKey(userId, "outline", { key: "ol_api_good" });
          if (change === "client")
            yield* service.saveConfig({
              id: "outline",
              name: "Outline",
              enabled: true,
              config: { baseUrl },
              oauthClientId: "changed-client",
              allowApiKeys: true,
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
        permissionsFor: (connectionId) =>
          service.permissionsFor(userId, conversationId, connectionId),
        sessionFor: (connectionId) =>
          service.session(userId, connectionId).pipe(Effect.orElseSucceed(() => null)),
        rowIdFor: () => Effect.succeed("pending-call"),
        reportAuthFailure: (_session, failure) => service.reportAuthFailure({ userId, failure }),
        reportMissingScopes: () => Effect.void,
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

  it.each(["block", "reconnect", "unchanged"] as const)(
    "rechecks queued mutations after %s and leaves reads concurrent",
    async (change) => {
      const { userId, conversationId } = await setup();
      await run(
        Effect.flatMap(IntegrationService, (s) =>
          on(userId, "outline", (account) =>
            s.updatePreferences(userId, account, {
              toolPermissions: { create_document: "allow" },
            }),
          ),
        ),
      );
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const queued = Promise.withResolvers<void>();
      let writes = 0;
      beforeApiResponse = async (request) => {
        if (request.url === "/api/documents.create" && ++writes === 1) {
          entered.resolve();
          await release.promise;
        }
      };
      try {
        await run(
          Effect.gen(function* () {
            const service = yield* IntegrationService;
            const offered = yield* service.resolveOffer({ userId, conversationId, grants: null });
            let checks = 0;
            const prepared = prepareIntegrationTools({
              offered,
              indexer: createSourceIndexer([]),
              approvals: yield* IntegrationApprovals,
              owner: { userId, conversationId, messageId: "answer" },
              permissionsFor: (connectionId) =>
                service.permissionsFor(userId, conversationId, connectionId).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      if (++checks === 5) queued.resolve();
                    }),
                  ),
                ),
              sessionFor: (connectionId) =>
                service.session(userId, connectionId).pipe(Effect.orElseSucceed(() => null)),
              rowIdFor: () => Effect.succeed("pending-call"),
              reportAuthFailure: (_session, failure) =>
                service.reportAuthFailure({ userId, failure }),
              reportMissingScopes: () => Effect.void,
              allowanceUses: unlimited,
            })!;
            type Handler = (
              args: Record<string, unknown>,
              context: { toolCallId: string },
            ) => Effect.Effect<IntegrationModelResult>;
            const create = prepared.group.handlers.int_outline__create_document as Handler;
            const one = yield* Effect.forkChild(
              create({ title: "One", collectionId: "c1" }, { toolCallId: "one" }),
            );
            yield* Effect.promise(() => entered.promise);
            const two = yield* Effect.forkChild(
              create({ title: "Two", collectionId: "c1" }, { toolCallId: "two" }),
            );
            // Three consent reads admit the first call. Two more finish the second's preparation.
            yield* Effect.promise(() => queued.promise);
            const read = prepared.group.handlers.int_outline__read_document as Handler;
            expect((yield* read({ id: "d1" }, { toolCallId: "read" })).ok).toBe(true);
            if (change === "block")
              yield* on(userId, "outline", (account) =>
                service.updatePreferences(userId, account, {
                  toolPermissions: { create_document: "block" },
                }),
              );
            if (change === "reconnect")
              yield* service.connectApiKey(userId, "outline", { key: "ol_api_good" });
            release.resolve();
            expect((yield* Fiber.join(one)).ok).toBe(true);
            expect((yield* Fiber.join(two)).ok).toBe(change === "unchanged");
          }),
        );
        expect(writes).toBe(change === "unchanged" ? 2 : 1);
      } finally {
        release.resolve();
        beforeApiResponse = null;
      }
    },
  );

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
          const handler = yield* on(userId, "outline", (connectionId) =>
            offeredHandler(
              userId,
              conversationId,
              [{ connectionId, integrationId: "outline", access }],
              tool,
            ),
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
  /** An answer, and the account of its owner its uses are counted against. */
  const answer = async () => {
    const userId = await newUser();
    await connectKey(userId);
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
    return { messageId, connectionId: await run(on(userId, "outline", Effect.succeed)) };
  };

  it("hands out at most the cap, however many calls race for it", async () => {
    const use = { ...(await answer()), allowanceId: "send" };
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
          repo.reserveAllowance({ ...use, ...other, cap: 3 }),
        ),
      ),
    ).toBe(true);
  });

  it("lets a use given back be taken again", async () => {
    const use = { ...(await answer()), allowanceId: "send" };
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
  const sources = <A, E>(
    f: (s: KnowledgeSourceService["Service"]) => Effect.Effect<A, E, IntegrationRepo>,
  ) => run(Effect.flatMap(KnowledgeSourceService, f));
  /** Saves a source as the person's account on the integration it names. */
  const saveAs = (
    s: KnowledgeSourceService["Service"],
    userId: string,
    input: Omit<Parameters<KnowledgeSourceService["Service"]["save"]>[1], "connectionId"> & {
      integrationId: string;
    },
  ) => {
    const { integrationId, ...rest } = input;
    return on(userId, integrationId, (connectionId) => s.save(userId, { ...rest, connectionId }));
  };
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

  it.each(["edit", "remove", "expire"] as const)(
    "fences a parked source worker after %s",
    async (change) => {
      await configure();
      const userId = await newUser();
      await connectKey(userId);
      const collectionId = await collectionFor(userId);
      const source = await sources((s) =>
        saveAs(s, userId, { collectionId, integrationId: "outline", root: handbook("all") }),
      );
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      beforeApiResponse = async (request) => {
        if (request.url === "/api/documents.list") {
          entered.resolve();
          await release.promise;
        }
      };
      const worker = sources((s) => s.tick);
      try {
        await entered.promise;
        if (change === "edit")
          await sources((s) =>
            saveAs(s, userId, {
              sourceId: source.id,
              collectionId,
              integrationId: "outline",
              root: handbook("selected"),
            }),
          );
        if (change === "remove") await sources((s) => s.remove(userId, source.id));
        if (change === "expire")
          await insert((db) =>
            db
              .update(knowledgeSources)
              .set({ leaseUntil: sql`clock_timestamp() - interval '1 second'` })
              .where(eq(knowledgeSources.id, source.id)),
          );
        release.resolve();
        await worker;
        expect(await mirrored(collectionId)).toEqual([]);
        expect(await versions(collectionId)).toBe(0);
        const [current] = await insert((db) =>
          db.select().from(knowledgeSources).where(eq(knowledgeSources.id, source.id)),
        );
        if (change === "remove") expect(current).toBeUndefined();
        else expect(current?.cursor).toBeNull();
        if (change === "edit") expect(current).toMatchObject({ leaseToken: null, status: "idle" });
      } finally {
        release.resolve();
        beforeApiResponse = null;
        await worker;
      }
    },
  );

  it("stops syncing for an owner who has been banned, without reaching the service", async () => {
    await configure();
    const userId = await newUser();
    await connectKey(userId);
    const collectionId = await collectionFor(userId);
    const source = await sources((s) =>
      saveAs(s, userId, { collectionId, integrationId: "outline", root: handbook("all") }),
    );
    await insert((db) => db.update(user).set({ banned: true }).where(eq(user.id, userId)));
    const before = apiCalls.length;
    await sources((s) => s.tick);
    expect(apiCalls.length).toBe(before);
    expect(await mirrored(collectionId)).toEqual([]);
    const [current] = await insert((db) =>
      db.select().from(knowledgeSources).where(eq(knowledgeSources.id, source.id)),
    );
    expect(current).toMatchObject({ status: "error", leaseToken: null });
  });

  it("keeps a successor's publication when an expired parked worker resumes", async () => {
    await configure();
    const userId = await newUser();
    await connectKey(userId);
    const collectionId = await collectionFor(userId);
    const source = await sources((s) =>
      saveAs(s, userId, {
        collectionId,
        integrationId: "outline",
        root: handbook("all"),
      }),
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let parked = false;
    beforeApiResponse = async (request) => {
      if (request.url === "/api/documents.list" && !parked) {
        parked = true;
        entered.resolve();
        await release.promise;
      }
    };
    const predecessor = sources((s) => s.tick);
    try {
      await entered.promise;
      const [claimed] = await insert((db) =>
        db.select().from(knowledgeSources).where(eq(knowledgeSources.id, source.id)),
      );
      expect(claimed!.leaseToken).not.toBeNull();
      await insert((db) =>
        db
          .update(knowledgeSources)
          .set({
            leaseUntil: sql`clock_timestamp() - interval '1 second'`,
            nextSyncAt: sql`clock_timestamp()`,
          })
          .where(eq(knowledgeSources.id, source.id)),
      );
      await sources((s) => s.tick);
      const savedVersions = await versions(collectionId);
      expect(savedVersions).toBe(3);
      const [successor] = await insert((db) =>
        db.select().from(knowledgeSources).where(eq(knowledgeSources.id, source.id)),
      );
      expect(successor!.leaseToken).toBeNull();
      expect(successor!.cursor).not.toBeNull();
      release.resolve();
      await predecessor;
      expect(await versions(collectionId)).toBe(savedVersions);
      const [settled] = await insert((db) =>
        db.select().from(knowledgeSources).where(eq(knowledgeSources.id, source.id)),
      );
      expect(settled).toEqual(successor);
      expect(await mirrored(collectionId)).toEqual(["document:d1", "document:d2", "document:d3"]);
    } finally {
      release.resolve();
      beforeApiResponse = null;
      await predecessor;
    }
  });

  it.each(["token", "expiry", "integration"] as const)(
    "fences source add, replace, equality and delete with stale %s",
    async (change) => {
      const userId = await newUser();
      const collectionId = await collectionFor(userId);
      const sourceId = uuidv7();
      const leaseToken = uuidv7();
      await insert((db) =>
        db.insert(knowledgeSources).values({
          id: sourceId,
          collectionId,
          integrationId: "outline",
          root: handbook("all"),
          leaseToken,
          leaseUntil: sql`clock_timestamp() + interval '1 hour'`,
        }),
      );
      const fence = { sourceId, collectionId, integrationId: "outline", leaseToken };
      const initial = {
        fence,
        externalId: "document:one",
        externalUrl: "https://source.invalid/one",
        externalUpdatedAt: new Date("2026-10-01"),
        title: "One",
        content: "Original",
      };
      const published = (await run(
        Effect.flatMap(KnowledgeRepo, (repo) => repo.publishSourceNote(userId, initial)),
      ))!;
      expect(published).not.toBeNull();
      const equal = await run(
        Effect.flatMap(KnowledgeRepo, (repo) =>
          repo.publishSourceNote(userId, {
            ...initial,
            documentId: published.documentId,
            externalUrl: "https://source.invalid/new",
            externalUpdatedAt: new Date("2026-10-02"),
          }),
        ),
      );
      expect(equal).toEqual(published);
      const [before] = await insert((db) =>
        db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, published.documentId)),
      );
      expect(before).toMatchObject({
        sourceId,
        externalId: initial.externalId,
        externalUrl: "https://source.invalid/new",
      });
      expect(await versions(collectionId)).toBe(1);
      if (change === "token")
        await insert((db) =>
          db
            .update(knowledgeSources)
            .set({ leaseToken: uuidv7() })
            .where(eq(knowledgeSources.id, sourceId)),
        );
      if (change === "expiry")
        await insert((db) =>
          db
            .update(knowledgeSources)
            .set({ leaseUntil: sql`clock_timestamp() - interval '1 second'` })
            .where(eq(knowledgeSources.id, sourceId)),
        );
      const stale = change === "integration" ? { ...fence, integrationId: "jira" } : fence;
      for (const content of ["Original", "Replacement"])
        expect(
          await run(
            Effect.flatMap(KnowledgeRepo, (repo) =>
              repo.publishSourceNote(userId, {
                ...initial,
                fence: stale,
                documentId: published.documentId,
                content,
              }),
            ),
          ),
        ).toBeNull();
      expect(
        await run(
          Effect.flatMap(KnowledgeRepo, (repo) =>
            repo.publishSourceNote(userId, {
              ...initial,
              fence: stale,
              externalId: "document:two",
            }),
          ),
        ),
      ).toBeNull();
      expect(
        await run(
          Effect.flatMap(KnowledgeRepo, (repo) =>
            repo.deleteSourceDocument(userId, stale, {
              documentId: published.documentId,
              externalId: initial.externalId,
            }),
          ),
        ),
      ).toBe(false);
      expect(await versions(collectionId)).toBe(1);
      const [after] = await insert((db) =>
        db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, published.documentId)),
      );
      expect(after).toEqual(before);
      expect(
        await run(Effect.flatMap(KnowledgeRepo, (repo) => repo.removeSource(userId, sourceId))),
      ).toBe(true);
      expect(await versions(collectionId)).toBe(0);
      expect(await mirrored(collectionId)).toEqual([]);
    },
  );

  it("takes everything under a root except what is left out, and follows edits", async () => {
    const userId = await newUser();
    await connectKey(userId);
    const collectionId = await collectionFor(userId);

    const source = await sources((s) =>
      saveAs(s, userId, {
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
      saveAs(s, userId, {
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
      saveAs(s, userId, { collectionId, integrationId: "outline", root: handbook("all") }),
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
      saveAs(s, userId, { collectionId, integrationId: "outline", root: handbook("all") }),
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
        saveAs(s, userId, {
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
      saveAs(s, owner, { collectionId, integrationId: "outline", root: handbook("all") }),
    );
    expect(await sources((s) => s.list(owner, collectionId))).toMatchObject([{ canEdit: true }]);
    expect(await sources((s) => s.list(reader, collectionId))).toMatchObject([{ canEdit: false }]);
  });

  it("clears a source whose collection no longer exists and says so", async () => {
    const userId = await newUser();
    await connectKey(userId);
    const collectionId = await collectionFor(userId);
    await sources((s) =>
      saveAs(s, userId, {
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
      saveAs(s, userId, {
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
        saveAs(s, userId, {
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
      saveAs(s, userId, { collectionId, integrationId: "outline", root: handbook("all") }),
    );
    await sources((s) => s.tick);
    const page = await sources((s) =>
      saveAs(s, userId, {
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
      saveAs(s, userId, {
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
      saveAs(s, userId, {
        collectionId,
        integrationId: "outline",
        root: handbook("selected", [{ nodeId: "document:d3", title: "Holidays", mode: "include" }]),
      }),
    );
    await sources((s) => s.tick);

    await run(
      Effect.flatMap(IntegrationService, (s) =>
        on(userId, "outline", (account) => s.disconnect(userId, account)),
      ),
    );
    const [paused] = await sources((s) => s.list(userId, collectionId));
    expect(paused).toMatchObject({ connected: false });
    // Nothing synced is dropped while paused.
    expect(await mirrored(collectionId)).toEqual(["document:d3"]);

    // A new connection row, their only one there: the source follows it without being edited.
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
      saveAs(s, userId, {
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

describe("several accounts of one integration", () => {
  const service = <A, E>(
    f: (s: IntegrationService["Service"]) => Effect.Effect<A, E, IntegrationRepo>,
  ) => run(Effect.flatMap(IntegrationService, f));
  const newConversation = async (userId: string) => {
    const id = uuidv7();
    await insert((db) => db.insert(conversations).values({ id, userId }));
    return id;
  };
  const accountsOf = async (userId: string) =>
    ((await outlineFor(userId))?.connections ?? []).map((account) => ({
      id: account.id,
      name: account.name ?? account.accountLabel,
      status: account.status,
    }));
  /** Two accounts of one person: Ada's own and the `bo-` one, named "Home". */
  const twoAccounts = async () => {
    await configure();
    const userId = await newUser();
    await connectKey(userId);
    validTokens.add("bo-key");
    await service((s) => s.connectApiKey(userId, "outline", { key: "bo-key" }));
    const [ada, bo] = await accountsOf(userId);
    await service((s) => s.updatePreferences(userId, bo!.id, { name: "Home" }));
    return { userId, ada: ada!.id, bo: bo!.id };
  };
  const toolsIn = (userId: string, conversationId: string, grants: IntegrationGrant[] | null) =>
    run(
      Effect.gen(function* () {
        const integrations = yield* IntegrationService;
        const offered = yield* integrations.resolveOffer({ userId, conversationId, grants });
        const prepared = prepareIntegrationTools({
          offered,
          indexer: createSourceIndexer([]),
          approvals: yield* IntegrationApprovals,
          owner: { userId, conversationId, messageId: "answer" },
          permissionsFor: (connectionId) =>
            integrations.permissionsFor(userId, conversationId, connectionId),
          sessionFor: (connectionId) =>
            integrations.session(userId, connectionId).pipe(Effect.orElseSucceed(() => null)),
          rowIdFor: () => Effect.succeed("call-row"),
          reportAuthFailure: () => Effect.void,
          reportMissingScopes: () => Effect.void,
          allowanceUses: unlimited,
        })!;
        const list = prepared.group.handlers.int_outline__list as (
          args: Record<string, unknown>,
          context: { toolCallId: string },
        ) => Effect.Effect<IntegrationModelResult>;
        return { offered, prepared, list };
      }),
    );
  /** The keys requests reached Outline with while `f` ran. */
  const keysDuring = async <A>(f: () => Promise<A>) => {
    const keys: string[] = [];
    beforeApiResponse = async (request) => {
      keys.push(request.headers.authorization ?? "");
    };
    try {
      return { result: await f(), keys };
    } finally {
      beforeApiResponse = null;
    }
  };

  it("connects another account beside one, and the same account again reconnects it", async () => {
    const { userId, ada, bo } = await twoAccounts();
    expect(await accountsOf(userId)).toEqual([
      { id: ada, name: "ada@example.com · Acme", status: "active" },
      { id: bo, name: "Home", status: "active" },
    ]);
    await connectKey(userId);
    expect((await accountsOf(userId)).map((account) => account.id)).toEqual([ada, bo]);

    // Reconnecting one account must not sign in as the other.
    const swapped = await run(
      Effect.flatMap(IntegrationService, (s) =>
        Effect.flip(s.connectApiKey(userId, "outline", { key: "ol_api_good" }, bo)),
      ),
    );
    expect(swapped).toMatchObject({ reason: expect.stringMatching(/another account than “Home”/) });

    await service((s) => s.disconnect(userId, ada));
    expect(await accountsOf(userId)).toEqual([{ id: bo, name: "Home", status: "active" }]);
  });

  it("offers one tool set, and each call runs as the account it names", async () => {
    const { userId, ada, bo } = await twoAccounts();
    const conversationId = await newConversation(userId);
    const { offered, prepared, list } = await toolsIn(userId, conversationId, null);
    expect(offered.map((offer) => offer.session.connectionId)).toEqual([ada, bo]);
    expect([...prepared.names.keys()].filter((name) => name.endsWith("__list"))).toEqual([
      "int_outline__list",
    ]);

    const unnamed = await keysDuring(() => run(list({}, { toolCallId: "unnamed" })));
    expect(unnamed.result).toMatchObject({ ok: false });
    expect(unnamed.keys).toEqual([]);
    const home = await keysDuring(() => run(list({ account: "Home" }, { toolCallId: "home" })));
    expect(home.result).toMatchObject({ ok: true });
    expect(new Set(home.keys)).toEqual(new Set(["Bearer bo-key"]));

    // Blocked for Home only: still offered for Ada, and refused when named for Home.
    await service((s) => s.updatePreferences(userId, bo, { toolPermissions: { list: "block" } }));
    const blocked = await toolsIn(userId, conversationId, null);
    const refused = await keysDuring(() =>
      run(blocked.list({ account: "Home" }, { toolCallId: "blocked" })),
    );
    expect(refused.result).toMatchObject({ ok: false, refused: true });
    expect(refused.keys).toEqual([]);

    // With one account left on in the chat, the tool takes no account at all.
    await service((s) =>
      s.setConversationIntegration(userId, conversationId, bo, { enabled: false }),
    );
    const alone = await toolsIn(userId, conversationId, null);
    expect(alone.offered.map((offer) => offer.session.connectionId)).toEqual([ada]);
    expect(alone.prepared.names.get("int_outline__list")?.chooses).toBe(false);
    const plain = await keysDuring(() => run(alone.list({}, { toolCallId: "plain" })));
    expect(plain.result).toMatchObject({ ok: true });
    expect(new Set(plain.keys)).toEqual(new Set(["Bearer ol_api_good"]));
  });

  it("hands what lost its account to the next one only while it is the only one", async () => {
    await configure();
    const userId = await newUser();
    await connectKey(userId);
    const [ada] = await accountsOf(userId);
    const scheduleId = await scheduleWith(userId, [
      { connectionId: ada!.id, integrationId: "outline", access: "read" },
    ]);
    const grantOf = async () => (await grantsOf(scheduleId))[0]?.connectionId;

    // Disconnected, then connected again as their only account: the grant follows.
    await service((s) => s.disconnect(userId, ada!.id));
    await connectKey(userId);
    const [again] = await accountsOf(userId);
    expect(again!.id).not.toBe(ada!.id);
    expect(await grantOf()).toBe(again!.id);

    // With two accounts there is no guessing: the grant waits to be edited.
    validTokens.add("bo-key");
    await service((s) => s.connectApiKey(userId, "outline", { key: "bo-key" }));
    await service((s) => s.disconnect(userId, again!.id));
    await connectKey(userId);
    expect(await grantOf()).toBe(null);
  });

  it("never gives one account a second grant when it is reconnected", async () => {
    const { userId, ada, bo } = await twoAccounts();
    const scheduleId = await scheduleWith(userId, [
      { connectionId: ada, integrationId: "outline", access: "write" },
      { connectionId: bo, integrationId: "outline", access: "read" },
    ]);
    const home = (await outlineFor(userId))?.connections.find((account) => account.id === bo);
    expect(home?.dependents).toEqual({ sources: 0, schedules: 1 });
    // Ada's goes, leaving Home the only account; signing Home in again must not
    // hand it Ada's write grant beside its own read one.
    await service((s) => s.disconnect(userId, ada));
    await service((s) => s.connectApiKey(userId, "outline", { key: "bo-key" }));
    expect(await grantsOf(scheduleId)).toEqual([
      { connectionId: bo, integrationId: "outline", access: "read" },
      { connectionId: null, integrationId: "outline", access: "write" },
    ]);
    // And the key itself refuses a second grant for one account.
    const second = await run(
      Effect.flatMap(Db, (db) =>
        db
          .insert(scheduleIntegrationGrants)
          .values({ scheduleId, connectionId: bo, integrationId: "outline", access: "write" }),
      ).pipe(Effect.exit),
    );
    expect(Exit.isFailure(second)).toBe(true);
  });

  it("refuses to reconnect an account as one already connected beside it", async () => {
    const { userId, ada, bo } = await twoAccounts();
    // As if Ada's row came from before accounts were known.
    await insert((db) =>
      db
        .update(integrationConnections)
        .set({ accountKey: null })
        .where(eq(integrationConnections.id, ada)),
    );
    const taken = await run(
      Effect.flatMap(IntegrationService, (s) =>
        Effect.flip(s.connectApiKey(userId, "outline", { key: "bo-key" }, ada)),
      ),
    );
    expect(taken).toMatchObject({ reason: "That account is already connected as “Home”." });
    expect((await accountsOf(userId)).map((account) => account.id)).toEqual([ada, bo]);
  });

  it("lets a schedule's grant reach only the account it names", async () => {
    const { userId, bo } = await twoAccounts();
    const conversationId = await newConversation(userId);
    const { offered } = await toolsIn(userId, conversationId, [
      { connectionId: bo, integrationId: "outline", access: "read" },
    ]);
    expect(offered.map((offer) => [offer.session.connectionId, offer.unattended?.access])).toEqual([
      [bo, "read"],
    ]);
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

  const service = <A, E>(
    f: (s: IntegrationService["Service"]) => Effect.Effect<A, E, IntegrationRepo>,
  ) => run(Effect.flatMap(IntegrationService, f));
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
        .map((entry) => [entry.id, entry.name, entry.connections[0]?.accountLabel]),
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
          permissionsFor: (connectionId) =>
            integrations.permissionsFor(userId, conversationId, connectionId),
          sessionFor: (connectionId) =>
            integrations.session(userId, connectionId).pipe(Effect.orElseSucceed(() => null)),
          rowIdFor: () => Effect.succeed("call"),
          reportAuthFailure: () => Effect.void,
          reportMissingScopes: () => Effect.void,
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
      on(userId, "outline-2", (account) =>
        s.setConversationIntegration(userId, conversationId, account, { enabled: false }),
      ),
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
    const accountA = await run(on(userId, "outline", Effect.succeed));
    const accountB = await run(on(userId, "outline-2", Effect.succeed));
    const scheduleId = await scheduleWith(userId, [
      { connectionId: accountA, integrationId: "outline", access: "read" },
      { connectionId: accountB, integrationId: "outline-2", access: "write" },
    ]);
    await service((s) => s.deleteIntegration("outline-2"));
    // The deleted one's grant stays, naming nothing, so the next run ends with a
    // reason and the editor shows it; the other grant is untouched.
    expect(await grantsOf(scheduleId)).toEqual([
      { connectionId: accountA, integrationId: "outline", access: "read" },
      { connectionId: null, integrationId: null, access: "write" },
    ]);
    const saved = await run(
      Effect.flatMap(ScheduleRepo, (repo) => repo.get(userId, scheduleId)).pipe(
        Effect.provide(ScheduleRepo.layer),
      ),
    );
    expect(saved?.integrationGrants).toEqual([
      { connectionId: accountA, integrationId: "outline", access: "read" },
      { connectionId: null, integrationId: null, access: "write" },
    ]);
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
    expect((await service((s) => s.directory(userId))).map((entry) => entry.id)).not.toContain(
      "outline-2",
    );
  });
});
