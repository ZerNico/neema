import { createHash } from "node:crypto";
import type { CallToolResult, Tool as McpTool } from "@modelcontextprotocol/client";
import { Effect } from "effect";
import { IntegrationRejected, IntegrationRequestFailed } from "../../errors.ts";
import type {
  AdapterFile,
  AdapterSource,
  AdapterToolResult,
  CallContext,
  IntegrationAdapter,
  IntegrationSession,
  OfferedTool,
} from "../../server/adapter.ts";
import {
  applyDecisions,
  argumentDetails,
  briefValue,
  MCP_LIMITS,
  offeredEntries,
  summarizeArguments,
  type McpToolEntry,
} from "../catalog.ts";
import { MCP_AUTH, mcpAuthOf } from "../manifest.ts";
import { mcpOAuth } from "./auth.ts";
import { connect, REQUEST_OPTIONS, toFailure, type Elicit } from "./client.ts";
import { promptOf, resultOf } from "./elicitation.ts";
import { listingEntries } from "./listing.ts";
import { argumentCheck } from "./validate.ts";

/** How often a catalog is looked at without a hint from the server, and at least. */
const RECHECK_MS = { default: 24 * 60 * 60_000, min: 60 * 60_000 } as const;

const isEntry = (value: unknown): value is McpToolEntry => {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<McpToolEntry>;
  return (
    typeof entry.key === "string" &&
    typeof entry.mcpName === "string" &&
    typeof entry.fingerprint === "string" &&
    typeof entry.inputSchema === "object" &&
    (entry.access === "read" || entry.access === "write" || entry.access === "destructive")
  );
};

const extension = (mediaType: string) => {
  const sub = mediaType.split("/")[1]?.split(/[;+]/)[0] ?? "bin";
  return sub === "jpeg" ? "jpg" : sub.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "bin";
};

const fileName = (uri: string | undefined, mediaType: string, index: number) => {
  const last = uri && URL.canParse(uri) ? new URL(uri).pathname.split("/").pop() : undefined;
  const cleaned = last?.replace(/[^\w.-]+/g, "_").slice(0, 100);
  return cleaned && cleaned.includes(".") ? cleaned : `result-${index + 1}.${extension(mediaType)}`;
};

/** Cut to fit without touching layout: code, tables and lists reach the model as written. */
const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** Only a web address can be a citation the reader opens; anything else stays text. */
const HTTP_LINK = /^https?:\/\//i;

/**
 * What a call returned, in the shapes the tool layer knows: text and
 * structured output for the model, links as citable sources, and bytes as
 * files of the answer. Everything is bounded here, before the model sees it.
 */
export const mapResult = (result: CallToolResult, entry: McpToolEntry) => {
  const texts: string[] = [];
  const sources: AdapterSource[] = [];
  const files: AdapterFile[] = [];
  const skipped: string[] = [];
  let bytes = 0;
  const addFile = (base64: string, mediaType: string, uri?: string) => {
    const data = Buffer.from(base64, "base64");
    if (files.length >= MCP_LIMITS.files || bytes + data.byteLength > MCP_LIMITS.fileBytes) {
      skipped.push(mediaType);
      return;
    }
    bytes += data.byteLength;
    files.push({ name: fileName(uri, mediaType, files.length), mediaType, bytes: data });
  };
  for (const block of result.content ?? []) {
    switch (block.type) {
      case "text":
        texts.push(block.text);
        break;
      case "image":
      case "audio":
        addFile(block.data, block.mimeType);
        break;
      case "resource_link":
        if (HTTP_LINK.test(block.uri))
          sources.push({
            externalId: block.uri,
            title: block.title ?? block.name,
            url: block.uri,
            snippet: block.description ?? "",
            read: false,
          });
        else texts.push(`Resource: ${block.title ?? block.name} (${block.uri})`);
        break;
      case "resource": {
        const resource = block.resource;
        if ("text" in resource) {
          texts.push(resource.text);
          if (HTTP_LINK.test(resource.uri))
            sources.push({
              externalId: resource.uri,
              title: resource.uri,
              url: resource.uri,
              snippet: resource.text.slice(0, 500),
              read: true,
            });
        } else
          addFile(resource.blob, resource.mimeType ?? "application/octet-stream", resource.uri);
        break;
      }
    }
  }
  const text = texts.join("\n\n");
  // Structured output is the precise form when the tool declares one; the
  // text is then usually the same content serialized for older clients.
  const structured =
    entry.outputSchema && result.structuredContent !== undefined
      ? result.structuredContent
      : undefined;
  const output: Record<string, unknown> =
    structured === undefined
      ? { content: clip(text, MCP_LIMITS.resultChars) }
      : JSON.stringify(structured).length <= MCP_LIMITS.resultChars
        ? { structured }
        : { content: clip(JSON.stringify(structured), MCP_LIMITS.resultChars) };
  if (files.length)
    output.files = files.map((file) => ({ name: file.name, mediaType: file.mediaType }));
  if (skipped.length)
    output.note = `${skipped.length} more ${skipped.length === 1 ? "file was" : "files were"} too large to attach.`;
  return {
    isError: result.isError === true,
    text,
    result: { output, sources, files } satisfies AdapterToolResult,
  };
};

const callTool = (
  session: IntegrationSession,
  integrationId: string,
  entry: McpToolEntry,
  args: unknown,
  call: CallContext | undefined,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const credential = yield* session.credential;
      // Aborted with the call, so a question still on screen goes when Stop ends the answer.
      const controller = new AbortController();
      yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));
      const elicit: Elicit = async (params) => {
        const prompt = promptOf(params);
        if (!prompt || !call) return { action: "decline" };
        const answer = await Effect.runPromise(call.elicit(prompt), { signal: controller.signal });
        return resultOf(prompt, answer);
      };
      const connection = yield* connect({
        integrationId,
        url: new URL(session.config.url!),
        credential,
        header: session.config.header,
        holder: integrationId,
        elicit,
      });
      const tool: McpTool = {
        name: entry.mcpName,
        inputSchema: entry.inputSchema as McpTool["inputSchema"],
        ...(entry.outputSchema
          ? { outputSchema: entry.outputSchema as McpTool["outputSchema"] }
          : {}),
      };
      const result = yield* Effect.tryPromise({
        try: (signal) =>
          connection.client.callTool(
            { name: entry.mcpName, arguments: (args ?? {}) as Record<string, unknown> },
            {
              ...REQUEST_OPTIONS,
              signal: AbortSignal.any([signal, controller.signal]),
              toolDefinition: tool,
            },
          ),
        catch: (error) => toFailure(integrationId, error, connection.challenge()),
      });
      const mapped = mapResult(result, entry);
      if (mapped.isError)
        return yield* new IntegrationRequestFailed({
          status: null,
          message: briefValue(mapped.text || "The tool reported an error.", 280),
        });
      return mapped.result;
    }),
  );

const offered = (integrationId: string, entry: McpToolEntry): OfferedTool => ({
  name: entry.key,
  title: entry.title,
  label: entry.title,
  description: entry.description || entry.title,
  access: entry.access,
  parameters: entry.inputSchema,
  summarize: summarizeArguments,
  details: argumentDetails,
  revision: entry.fingerprint,
  prepare: (session, args, call) =>
    Effect.gen(function* () {
      const check = argumentCheck(entry.fingerprint, entry.inputSchema);
      if ("error" in check) return yield* new IntegrationRejected({ reason: check.error });
      const checked = check(args ?? {});
      if (!checked.valid)
        return yield* new IntegrationRejected({
          reason: `The arguments do not fit ${entry.title}: ${briefValue(checked.errorMessage, 300)}`,
        });
      return {
        summary: null,
        reach: null,
        scope: null,
        execute: callTool(session, integrationId, entry, args ?? {}, call),
      };
    }),
});

/** Whose sign-in an account label names, for Settings; never a secret. */
const accountLabel = (
  session: IntegrationSession,
  credential: { kind: string; accessToken?: string },
) => {
  if (credential.kind === "none")
    return mcpAuthOf(session.config) === "shared" ? "Shared key" : "No sign-in needed";
  if (credential.kind === "api_key")
    return mcpAuthOf(session.config) === "shared" ? "Shared key" : "Personal token";
  // An access token is often a JWT naming the person; only read for display.
  const payload = credential.accessToken?.split(".")[1];
  if (payload) {
    try {
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
        string,
        unknown
      >;
      for (const key of ["email", "preferred_username", "name", "sub"])
        if (typeof claims[key] === "string" && claims[key])
          return String(claims[key]).slice(0, 120);
    } catch {
      // Opaque tokens are fine; the label just stays generic.
    }
  }
  return "Signed in";
};

const HEADER = /^[A-Za-z0-9-]{1,64}$/;

export const mcpAdapter: IntegrationAdapter = {
  kind: "mcp",
  normalizeConfig(config) {
    const raw = (config.url ?? "").trim();
    if (!URL.canParse(raw)) return { error: "Enter the MCP server’s address." };
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:")
      return { error: "The server address must start with https://." };
    if (url.username || url.password)
      return { error: "Leave credentials out of the address; choose a sign-in instead." };
    url.hash = "";
    const auth = MCP_AUTH.find((mode) => mode === config.auth);
    if (!auth) return { error: "Choose how people sign in." };
    const header = (config.header ?? "").trim();
    if (header && !HEADER.test(header))
      return { error: "The header name has characters a header cannot have." };
    const scopes = (config.scopes ?? "").trim().replace(/\s+/g, " ");
    if (scopes.length > 500) return { error: "The scopes are too long." };
    const normalized: Record<string, string> = { url: url.toString(), auth };
    if (header && (auth === "token" || auth === "shared")) normalized.header = header;
    if (scopes && auth === "oauth") normalized.scopes = scopes;
    // Another address or way in means every saved credential names something else.
    return {
      config: normalized,
      fingerprint: `${normalized.url} ${auth} ${normalized.header ?? ""}`,
    };
  },
  oauth: null,
  discoveredOAuth: mcpOAuth,
  connectMethods: (config) => {
    const auth = mcpAuthOf(config);
    return {
      oauth: auth === "oauth",
      apiKey: auth === "token",
      open: auth === "none" ? "none" : auth === "shared" ? "shared" : null,
    };
  },
  verify: (session) =>
    Effect.scoped(
      Effect.gen(function* () {
        const credential = yield* session.credential;
        const connection = yield* connect({
          integrationId: "verify",
          url: new URL(session.config.url!),
          credential,
          header: session.config.header,
          holder: `verify ${Math.random()}`,
        });
        // A server that lets anyone connect may still refuse a bad token on a real request.
        yield* Effect.tryPromise({
          try: (signal) => connection.client.listTools(undefined, { signal, timeout: 30_000 }),
          catch: (error) => toFailure("verify", error, connection.challenge()),
        });
        return { accountLabel: accountLabel(session, credential) };
      }),
    ),
  scopeOptions: null,
  handlers: {},
  knowledge: null,
  catalog: {
    tool: (integrationId, entry) => (isEntry(entry) ? offered(integrationId, entry) : null),
    offer: (approved, latest) =>
      offeredEntries(approved.filter(isEntry), latest ? latest.filter(isEntry) : null),

    version: (latest) =>
      createHash("sha256")
        .update(
          latest
            .filter(isEntry)
            .map((entry) => `${entry.mcpName}:${entry.fingerprint}`)
            .join(","),
        )
        .digest("base64url"),
    apply: (approved, latest, decisions) => {
      const next = applyDecisions(approved.filter(isEntry), latest.filter(isEntry), decisions);
      const enabled = next.filter((entry) => entry.enabled).length;
      if (enabled > MCP_LIMITS.enabledTools)
        return {
          error: `Turn on at most ${MCP_LIMITS.enabledTools} tools; models choose poorly among more.`,
        };
      return { approved: next };
    },
    list: (session, integrationId, previous) =>
      Effect.scoped(
        Effect.gen(function* () {
          const credential = yield* session.credential;
          const connection = yield* connect({
            integrationId,
            url: new URL(session.config.url!),
            credential,
            header: session.config.header,
            holder: integrationId,
          });
          const listed = yield* Effect.tryPromise({
            try: (signal) =>
              connection.client.listTools(undefined, {
                signal,
                timeout: 60_000,
                cacheMode: "refresh",
              }),
            catch: (error) => toFailure(integrationId, error, connection.challenge()),
          });
          const version = connection.client.getServerVersion();
          const server: Record<string, string> = {};
          if (version?.name) server.name = version.name.slice(0, 120);
          if (version?.title) server.title = String(version.title).slice(0, 120);
          if (version?.version) server.version = version.version.slice(0, 60);
          const protocol = connection.client.getNegotiatedProtocolVersion();
          if (protocol) server.protocol = protocol;
          const ttl = (listed as { ttlMs?: unknown }).ttlMs;
          return {
            entries: listingEntries(integrationId, listed.tools, previous.filter(isEntry)),
            server,
            recheckAfterMs:
              typeof ttl === "number" && ttl > 0
                ? Math.min(RECHECK_MS.default, Math.max(RECHECK_MS.min, ttl))
                : null,
          };
        }),
      ),
  },
};

export const MCP_RECHECK_MS = RECHECK_MS.default;
