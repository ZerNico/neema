import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  acceptedContent,
  createMcpHandler,
  fromJsonSchema,
  inputRequired,
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { Cause, Effect, Exit } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CallContext, Credential, IntegrationSession } from "../../server/adapter.ts";
import type { ElicitationAnswer, ElicitationPrompt } from "../../schema.ts";
import type { McpToolEntry } from "../catalog.ts";
import { mcpAdapter } from "./adapter.ts";

/** A one-pixel PNG, as a server would return a chart. */
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const buildServer = () => {
  const server = new McpServer({ name: "test-server", version: "1.2.3" });
  server.registerTool(
    "search",
    {
      title: "Search docs",
      description: "Search the docs.",
      annotations: { readOnlyHint: true },
      inputSchema: fromJsonSchema<{ q: string }>({
        type: "object",
        properties: { q: { type: "string" } },
        required: ["q"],
      }),
    },
    async ({ q }) => ({
      content: [
        { type: "text", text: `Found 1 page for ${q}.` },
        {
          type: "resource_link",
          uri: "https://docs.example.com/guide",
          name: "guide",
          title: "The guide",
          description: "How it works",
        },
      ],
    }),
  );
  server.registerTool(
    "chart",
    { description: "Draw a chart.", annotations: { destructiveHint: false } },
    async () => ({
      content: [
        { type: "text", text: "Here is the chart." },
        { type: "image", data: PIXEL, mimeType: "image/png" },
      ],
    }),
  );
  server.registerTool("broken", { description: "Always fails." }, async () => ({
    content: [{ type: "text", text: "The database is on fire." }],
    isError: true,
  }));
  const confirmation = fromJsonSchema<{ confirm: boolean }>({
    type: "object",
    properties: { confirm: { type: "boolean", title: "Deploy now?" } },
    required: ["confirm"],
  });
  // A tool without an input schema is handed only the context.
  server.registerTool("deploy", { description: "Deploy after asking." }, async (ctx) => {
    const answer = acceptedContent(ctx.mcpReq.inputResponses, "confirm", confirmation);
    if (!answer)
      return inputRequired({
        inputRequests: {
          confirm: inputRequired.elicit({
            message: "Deploy to production?",
            requestedSchema: confirmation,
          }),
        },
      });
    return { content: [{ type: "text", text: answer.confirm ? "Deployed." : "Not deployed." }] };
  });
  return server;
};

const handler = createMcpHandler(buildServer);

/**
 * A 2025-era deployment as they were written: one server and transport per
 * session, found again by `Mcp-Session-Id`, so the server can ask mid-call.
 */
const legacySessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
const legacyServer = async (request: Request) => {
  const id = request.headers.get("mcp-session-id");
  const existing = id ? legacySessions.get(id) : undefined;
  if (existing) return existing.handleRequest(request);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (session) => void legacySessions.set(session, transport),
  });
  await buildServer().connect(transport);
  return transport.handleRequest(request);
};

/** Which requests the test server saw, to tell the eras apart. */
const seen: string[] = [];

/**
 * The test server: the SDK's own handler behind plain `node:http`, with a
 * bearer check, and a 2025-era session server under `/legacy`, which knows
 * nothing of `server/discover`, so the client has to fall back to `initialize`.
 */
const serve = async (request: IncomingMessage, response: ServerResponse) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString("utf8");
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  if (url.pathname.startsWith("/secure") && request.headers.authorization !== "Bearer good") {
    response.writeHead(401, { "www-authenticate": 'Bearer error="invalid_token"' }).end();
    return;
  }
  const message = body ? (JSON.parse(body) as { method?: string }) : {};
  if (message.method) seen.push(`${url.pathname} ${message.method}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers))
    if (typeof value === "string") headers.set(key, value);
  const forwarded = new Request(url, {
    method: request.method ?? "GET",
    headers,
    ...(body ? { body } : {}),
  });
  const reply = await (url.pathname.startsWith("/legacy")
    ? legacyServer(forwarded)
    : handler.fetch(forwarded));
  response.writeHead(reply.status, Object.fromEntries(reply.headers));
  if (reply.body) for await (const chunk of reply.body) response.write(chunk);
  response.end();
};

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((request, response) => void serve(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await handler.close();
  await new Promise((resolve) => server.close(resolve));
});

const sessionAt = (
  path: string,
  credential: Credential = { kind: "none" },
): IntegrationSession => ({
  config: { url: `${base}${path}`, auth: credential.kind === "none" ? "none" : "token" },
  credential: Effect.succeed(credential),
  scope: Effect.succeed(null),
});

const list = (session: IntegrationSession) =>
  Effect.runPromise(mcpAdapter.catalog!.list(session, "mcp", []));

const run = (
  session: IntegrationSession,
  entry: McpToolEntry,
  args: unknown,
  call?: CallContext,
) => {
  const tool = mcpAdapter.catalog!.tool("mcp", { ...entry, enabled: true })!;
  return Effect.runPromiseExit(
    tool.prepare(session, args, call).pipe(Effect.flatMap((prepared) => prepared.execute)),
  );
};

const byName = (entries: ReadonlyArray<McpToolEntry>, name: string) =>
  entries.find((entry) => entry.mcpName === name)!;

/** A person who answers every question the same way, and what they were asked. */
const answering = (answer: ElicitationAnswer) => {
  const asked: ElicitationPrompt[] = [];
  const call: CallContext = {
    elicit: (prompt) => {
      asked.push(prompt);
      return Effect.succeed(answer);
    },
  };
  return { asked, call };
};

describe("an MCP server through the adapter", () => {
  it("lists tools in the server's order, unreviewed, with what it says about itself", async () => {
    const listed = await list(sessionAt("/mcp"));
    expect(listed.entries.map((entry) => entry.mcpName)).toEqual([
      "search",
      "chart",
      "broken",
      "deploy",
    ]);
    expect(listed.entries.every((entry) => !entry.enabled)).toBe(true);
    expect(listed.entries.map((entry) => entry.access)).toEqual([
      "read",
      "write",
      "destructive",
      "destructive",
    ]);
    expect(byName(listed.entries, "search").title).toBe("Search docs");
    expect(listed.server).toMatchObject({ name: "test-server", version: "1.2.3" });
  });

  it("speaks the stateless protocol to a current server, and initialize to an older one", async () => {
    seen.length = 0;
    const modern = await list(sessionAt("/mcp-era"));
    const legacy = await list(sessionAt("/legacy"));
    expect(modern.server.protocol).toBe("2026-07-28");
    expect(seen).not.toContain("/mcp-era initialize");
    expect(seen).toContain("/legacy initialize");
    expect(legacy.server.protocol).not.toBe("2026-07-28");
    expect(legacy.entries.map((entry) => entry.mcpName)).toEqual(
      modern.entries.map((entry) => entry.mcpName),
    );
  });

  it("returns text for the model and links as citable sources", async () => {
    const { entries } = await list(sessionAt("/mcp"));
    const exit = await run(sessionAt("/mcp"), byName(entries, "search"), { q: "billing" });
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(exit.value.output).toEqual({ content: "Found 1 page for billing." });
    expect(exit.value.sources).toEqual([
      {
        externalId: "https://docs.example.com/guide",
        title: "The guide",
        url: "https://docs.example.com/guide",
        snippet: "How it works",
        read: false,
      },
    ]);
  });

  it("turns returned images into files of the answer", async () => {
    const { entries } = await list(sessionAt("/mcp"));
    const exit = await run(sessionAt("/mcp"), byName(entries, "chart"), {});
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(exit.value.files).toHaveLength(1);
    expect(exit.value.files![0]).toMatchObject({ name: "result-1.png", mediaType: "image/png" });
    expect(Buffer.from(exit.value.files![0]!.bytes).subarray(1, 4).toString()).toBe("PNG");
    expect(exit.value.output).toMatchObject({
      files: [{ name: "result-1.png", mediaType: "image/png" }],
    });
  });

  it("refuses arguments that do not fit before anything is sent", async () => {
    const { entries } = await list(sessionAt("/mcp"));
    seen.length = 0;
    const exit = await run(sessionAt("/mcp"), byName(entries, "search"), { q: 5 });
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toMatch(/IntegrationRejected/);
    expect(seen.filter((line) => line.endsWith("tools/call"))).toEqual([]);
  });

  it("refuses, rather than crashes on, an approved schema that cannot be checked", async () => {
    const { entries } = await list(sessionAt("/mcp"));
    const broken: McpToolEntry = {
      ...byName(entries, "search"),
      fingerprint: "pattern-that-does-not-compile",
      inputSchema: { type: "object", properties: { q: { type: "string", pattern: "(" } } },
    };
    const exit = await run(sessionAt("/mcp"), broken, { q: "x" });
    expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true);
    expect(JSON.stringify(exit)).toMatch(/not valid JSON Schema/);
  });

  it("reports a tool's own error as a failure in its words", async () => {
    const { entries } = await list(sessionAt("/mcp"));
    const exit = await run(sessionAt("/mcp"), byName(entries, "broken"), {});
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("The database is on fire.");
  });

  describe("asking the person mid-call", () => {
    for (const path of ["/mcp", "/legacy"]) {
      it(`puts the server's form to the person and sends the answer back (${path})`, async () => {
        const { entries } = await list(sessionAt(path));
        const { asked, call } = answering({ action: "accept", values: { confirm: true } });
        const exit = await run(sessionAt(path), byName(entries, "deploy"), {}, call);
        expect(asked).toEqual([
          {
            mode: "form",
            message: "Deploy to production?",
            fields: [expect.objectContaining({ key: "confirm", kind: "boolean", required: true })],
          },
        ]);
        expect(Exit.isSuccess(exit) && exit.value.output).toEqual({ content: "Deployed." });
      });
    }

    it("never deploys when nobody can be asked", async () => {
      const { entries } = await list(sessionAt("/mcp"));
      const exit = await run(sessionAt("/mcp"), byName(entries, "deploy"), {});
      expect(JSON.stringify(exit)).not.toContain("Deployed.");
    });
  });

  describe("tokens", () => {
    it("sends a person's token as a bearer token, and a refused one reads as signed out", async () => {
      const good = await list(sessionAt("/secure", { kind: "api_key", values: { token: "good" } }));
      expect(good.entries).toHaveLength(4);
      const refused = await Effect.runPromiseExit(
        mcpAdapter.catalog!.list(
          sessionAt("/secure", { kind: "api_key", values: { token: "bad" } }),
          "mcp",
          [],
        ),
      );
      expect(JSON.stringify(refused)).toContain("IntegrationAuthFailed");
    });

    it("verifies a connection by listing with it", async () => {
      const verified = await Effect.runPromiseExit(
        mcpAdapter.verify(sessionAt("/secure", { kind: "api_key", values: { token: "good" } })),
      );
      expect(Exit.isSuccess(verified) && verified.value.accountLabel).toBe("Personal token");
    });
  });
});

describe("admin config", () => {
  it("normalizes the address and makes the way in part of the fingerprint", () => {
    expect(
      mcpAdapter.normalizeConfig({
        url: "https://mcp.example.com/mcp#x",
        auth: "token",
        header: "X-Api-Key",
        scopes: "a",
      }),
    ).toEqual({
      config: { url: "https://mcp.example.com/mcp", auth: "token", header: "X-Api-Key" },
      fingerprint: "https://mcp.example.com/mcp token X-Api-Key",
    });
    expect(
      mcpAdapter.normalizeConfig({ url: "https://mcp.example.com/mcp", auth: "oauth" }),
    ).toMatchObject({ fingerprint: "https://mcp.example.com/mcp oauth " });
    for (const bad of [
      { url: "https://user:pw@mcp.example.com", auth: "none" },
      { url: "ftp://mcp.example.com", auth: "none" },
      { url: "https://mcp.example.com", auth: "token", header: "Bad Header" },
      { url: "https://mcp.example.com", auth: "magic" },
    ])
      expect(mcpAdapter.normalizeConfig(bad)).toHaveProperty("error");
  });
});
