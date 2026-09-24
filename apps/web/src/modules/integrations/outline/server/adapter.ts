import { Effect, Schema } from "effect";
import { IntegrationRejected } from "../../errors.ts";
import { INTEGRATION_LIMITS, type BrowseNode } from "../../schema.ts";
import type {
  AdapterFailure,
  AdapterTool,
  IntegrationAdapter,
  IntegrationSession,
  RemoteDocument,
} from "../../server/adapter.ts";
import {
  absoluteUrl,
  outlineBase,
  outlineCall,
  outlineList,
  type OutlineCollection,
  type OutlineDocument,
  type OutlineNavigationNode,
} from "./client.ts";

const optionalText = (description: string) =>
  Schema.optionalKey(Schema.String.annotate({ description }));

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
const reject = (reason: string) => Effect.fail(new IntegrationRejected({ reason }));

// Search snippets arrive with <b> highlighting; the model wants plain text.
const plain = (snippet: string) =>
  snippet
    .replace(/<\/?b>/g, "")
    .replace(/\s+/g, " ")
    .trim();

const COLLECTION = "collection:";
const DOCUMENT = "document:";
const collectionNode = (id: string) => `${COLLECTION}${id}`;
const documentNode = (id: string) => `${DOCUMENT}${id}`;

const toBrowseNodes = (nodes: ReadonlyArray<OutlineNavigationNode>): BrowseNode[] =>
  nodes.map((node) => ({
    id: documentNode(node.id),
    title: node.title || "Untitled",
    kind: "document",
    hasChildren: (node.children?.length ?? 0) > 0,
  }));

const collectionTree = (session: IntegrationSession, collectionId: string) =>
  outlineCall<OutlineNavigationNode[]>(session, "collections.documents", { id: collectionId }).pipe(
    Effect.map((response) => response.data),
  );

const tools: ReadonlyArray<AdapterTool> = [
  {
    name: "search",
    description:
      "Full-text search across the Outline documents the user can access. Returns titles, links, ids and a short matching snippet; read a document for its full text.",
    parameters: Schema.Struct({
      query: optionalText("Keywords to search for."),
      collectionId: optionalText("Only search this Outline collection."),
    }),
    run: (session, args) =>
      Effect.gen(function* () {
        const query = text(args.query);
        if (!query) return yield* reject("Pass `query` with the keywords to search for.");
        const collectionId = text(args.collectionId);
        const response = yield* outlineCall<Array<{ context: string; document: OutlineDocument }>>(
          session,
          "documents.search",
          {
            query,
            limit: INTEGRATION_LIMITS.searchResults,
            ...(collectionId ? { collectionId } : {}),
          },
        );
        const results = response.data.map((hit) => ({
          id: hit.document.id,
          title: hit.document.title || "Untitled",
          url: absoluteUrl(session.config, hit.document.url),
          snippet: plain(hit.context),
          updatedAt: hit.document.updatedAt,
        }));
        return {
          output: results.length ? { results } : { results, note: "No documents matched." },
          sources: results.map((result) => ({
            externalId: result.id,
            title: result.title,
            url: result.url,
            snippet: result.snippet,
          })),
        };
      }),
  },
  {
    name: "read_document",
    description:
      "Read one Outline document as Markdown by id. Long documents come back in parts; pass `offset` from the previous answer to continue.",
    parameters: Schema.Struct({
      id: optionalText("The document id from search or list."),
      offset: Schema.optionalKey(
        Schema.Number.annotate({ description: "Character offset to continue from." }),
      ),
    }),
    run: (session, args) =>
      Effect.gen(function* () {
        const id = text(args.id);
        if (!id) return yield* reject("Pass `id` of the document to read.");
        const offset =
          typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 0;
        const { data } = yield* outlineCall<OutlineDocument>(session, "documents.info", { id });
        const body = data.text ?? "";
        const end = Math.min(body.length, offset + INTEGRATION_LIMITS.readChars);
        const url = absoluteUrl(session.config, data.url);
        return {
          output: {
            id: data.id,
            title: data.title,
            url,
            updatedAt: data.updatedAt,
            totalChars: body.length,
            offset,
            nextOffset: end < body.length ? end : null,
            text: body.slice(offset, end),
          },
          sources: [
            {
              externalId: data.id,
              title: data.title || "Untitled",
              url,
              snippet: body.slice(offset, offset + 300),
            },
          ],
        };
      }),
  },
  {
    name: "list",
    description:
      "Browse Outline. With no arguments, lists collections. With `collectionId`, lists that collection's top-level documents; with `documentId`, that document's children.",
    parameters: Schema.Struct({
      collectionId: optionalText("Collection to list the documents of."),
      documentId: optionalText("Document to list the children of."),
    }),
    run: (session, args) =>
      Effect.gen(function* () {
        const collectionId = text(args.collectionId);
        const documentId = text(args.documentId);
        if (documentId) {
          const { data } = yield* outlineCall<OutlineNavigationNode | OutlineNavigationNode[]>(
            session,
            "documents.documents",
            { id: documentId },
          );
          const children = Array.isArray(data) ? data : (data.children ?? []);
          return { output: { documents: navigationSummary(session, children) } };
        }
        if (collectionId) {
          const nodes = yield* collectionTree(session, collectionId);
          return { output: { documents: navigationSummary(session, nodes) } };
        }
        const collections = yield* outlineList<OutlineCollection>(
          session,
          "collections.list",
          {},
          INTEGRATION_LIMITS.listResults,
        );
        return {
          output: {
            collections: collections.map((collection) => ({
              id: collection.id,
              name: collection.name,
              url: absoluteUrl(session.config, collection.url),
            })),
          },
        };
      }),
  },
  {
    name: "create_document",
    description:
      "Create a published Outline document from Markdown, in a collection or under a parent document.",
    parameters: Schema.Struct({
      title: optionalText("Document title, at most 100 characters."),
      text: optionalText("Document body in Markdown."),
      collectionId: optionalText("Collection to create it in."),
      parentDocumentId: optionalText("Parent document to nest it under."),
    }),
    run: (session, args) =>
      Effect.gen(function* () {
        const title = text(args.title);
        const collectionId = text(args.collectionId);
        const parentDocumentId = text(args.parentDocumentId);
        if (!title) return yield* reject("Pass `title`.");
        if (!collectionId && !parentDocumentId)
          return yield* reject("Pass `collectionId` or `parentDocumentId`; use list to find one.");
        const { data } = yield* outlineCall<OutlineDocument>(session, "documents.create", {
          title: title.slice(0, 100),
          text: typeof args.text === "string" ? args.text : "",
          publish: true,
          ...(collectionId ? { collectionId } : {}),
          ...(parentDocumentId ? { parentDocumentId } : {}),
        });
        return {
          output: { id: data.id, title: data.title, url: absoluteUrl(session.config, data.url) },
        };
      }),
  },
  {
    name: "update_document",
    description:
      "Change an Outline document. `mode` is append, prepend, replace (the whole body) or patch (replace `findText` with `text`). Pass `title` to rename.",
    parameters: Schema.Struct({
      id: optionalText("The document id."),
      text: optionalText("Markdown to add, or the replacement."),
      mode: Schema.optionalKey(
        Schema.String.annotate({ description: "append, prepend, replace or patch." }),
      ),
      findText: optionalText("For patch: the exact existing text to replace."),
      title: optionalText("A new title."),
    }),
    run: (session, args) =>
      Effect.gen(function* () {
        const id = text(args.id);
        if (!id) return yield* reject("Pass `id` of the document to change.");
        const mode = text(args.mode) ?? "append";
        if (!["append", "prepend", "replace", "patch"].includes(mode))
          return yield* reject("`mode` must be append, prepend, replace or patch.");
        const title = text(args.title);
        const body = typeof args.text === "string" ? args.text : null;
        if (body === null && !title) return yield* reject("Pass `text`, `title`, or both.");
        const findText = typeof args.findText === "string" ? args.findText : null;
        if (mode === "patch" && !findText)
          return yield* reject("Patch needs `findText`, the exact text to replace.");
        const { data } = yield* outlineCall<OutlineDocument>(session, "documents.update", {
          id,
          ...(title ? { title: title.slice(0, 100) } : {}),
          ...(body !== null ? { text: body, editMode: mode } : {}),
          ...(mode === "patch" && findText ? { findText } : {}),
        });
        return {
          output: { id: data.id, title: data.title, url: absoluteUrl(session.config, data.url) },
        };
      }),
  },
  {
    name: "delete_document",
    description:
      "Move an Outline document to the trash, with every document nested under it. The user can restore it from Outline's trash. Only when the user asked for it.",
    parameters: Schema.Struct({
      id: optionalText("The document id."),
    }),
    describe: (session, args) =>
      Effect.gen(function* () {
        const id = text(args.id);
        if (!id) return null;
        const { data } = yield* outlineCall<OutlineDocument>(session, "documents.info", { id });
        const nested = yield* nestedCount(session, id);
        const title = `“${data.title || "Untitled"}”`;
        return nested === 0
          ? title
          : `${title} and ${nested} nested page${nested === 1 ? "" : "s"}`;
      }),
    run: (session, args) =>
      Effect.gen(function* () {
        const id = text(args.id);
        if (!id) return yield* reject("Pass `id` of the document to delete.");
        const { data } = yield* outlineCall<OutlineDocument>(session, "documents.info", { id });
        const nested = yield* nestedCount(session, id);
        // Not `permanent`: the trash is how a person undoes a mistaken approval.
        yield* outlineCall(session, "documents.delete", { id });
        return {
          output: {
            id: data.id,
            title: data.title,
            movedToTrash: true,
            nestedDocuments: nested,
          },
        };
      }),
  },
];

/** Every document under one, at any depth: deleting it trashes them too. */
const nestedCount = (session: IntegrationSession, id: string) =>
  outlineCall<OutlineNavigationNode | OutlineNavigationNode[]>(session, "documents.documents", {
    id,
  }).pipe(
    Effect.map(({ data }) => {
      const count = (nodes: ReadonlyArray<OutlineNavigationNode>): number =>
        nodes.reduce((total, node) => total + 1 + count(node.children ?? []), 0);
      return count(Array.isArray(data) ? data : (data.children ?? []));
    }),
  );

function navigationSummary(
  session: IntegrationSession,
  nodes: ReadonlyArray<OutlineNavigationNode>,
) {
  return nodes.slice(0, INTEGRATION_LIMITS.listResults).map((node) => ({
    id: node.id,
    title: node.title,
    url: absoluteUrl(session.config, node.url),
    children: node.children?.length ?? 0,
  }));
}

/** Walks one collection tree, recording each document's ancestors. */
function flatten(
  collectionId: string,
  nodes: ReadonlyArray<OutlineNavigationNode>,
): Map<string, { ancestors: string[]; title: string; url: string }> {
  const found = new Map<string, { ancestors: string[]; title: string; url: string }>();
  const walk = (list: ReadonlyArray<OutlineNavigationNode>, ancestors: string[]) => {
    for (const node of list) {
      found.set(node.id, { ancestors, title: node.title, url: node.url });
      if (node.children?.length) walk(node.children, [...ancestors, documentNode(node.id)]);
    }
  };
  walk(nodes, [collectionNode(collectionId)]);
  return found;
}

/** Gone, or hidden from this account now: either way the root has nothing to mirror. */
const unreachable = <A>(effect: Effect.Effect<A, AdapterFailure>) =>
  effect.pipe(
    Effect.map((value): A | null => value),
    Effect.catchTag("IntegrationRequestFailed", (error) =>
      error.status === 404 || error.status === 403 ? Effect.succeed(null) : Effect.fail(error),
    ),
  );

const enumerate = (session: IntegrationSession, roots: ReadonlyArray<string>, since: Date | null) =>
  Effect.gen(function* () {
    // Roots name collections and documents; the tree is walked per collection,
    // so a document root first has to name the collection it lives in.
    const missing: string[] = [];
    const collectionIds = new Set<string>();
    for (const root of roots) {
      if (root.startsWith(COLLECTION)) collectionIds.add(root.slice(COLLECTION.length));
      else if (root.startsWith(DOCUMENT)) {
        const found = yield* unreachable(
          outlineCall<OutlineDocument>(session, "documents.info", {
            id: root.slice(DOCUMENT.length),
          }),
        );
        if (found?.data.collectionId) collectionIds.add(found.data.collectionId);
        else missing.push(root);
      }
    }
    const documents: RemoteDocument[] = [];
    const seen = new Set<string>();
    for (const collectionId of collectionIds) {
      const nodes = yield* unreachable(collectionTree(session, collectionId));
      if (!nodes) {
        missing.push(collectionNode(collectionId));
        continue;
      }
      const tree = flatten(collectionId, nodes);
      // The text-free navigation tree runs every time and decides which pages
      // exist (drafts, archived and deleted pages are not in it). The
      // newest-first listing adds bodies and change times, stopping at `since`.
      const listed = yield* outlineList<OutlineDocument>(
        session,
        "documents.list",
        { collectionId, sort: "updatedAt", direction: "DESC" },
        10_000,
        since ? (document) => new Date(document.updatedAt) < since : undefined,
      );
      const changed = new Map(listed.map((document) => [document.id, document]));
      for (const [id, place] of tree) {
        const document = changed.get(id);
        seen.add(documentNode(id));
        documents.push({
          externalId: documentNode(id),
          ancestors: place.ancestors,
          title: document?.title || place.title || "Untitled",
          url: absoluteUrl(session.config, document?.url ?? place.url),
          // Not listed: unchanged since `since`, or past the listing cap. Either
          // way the sync keeps what it stored and fetches only what it lacks.
          updatedAt: document ? new Date(document.updatedAt) : null,
          ...(typeof document?.text === "string" ? { markdown: document.text } : {}),
        });
      }
    }
    for (const root of roots)
      if (root.startsWith(DOCUMENT) && !missing.includes(root) && !seen.has(root))
        missing.push(root);
    return { documents, missing };
  });

export const outlineAdapter: IntegrationAdapter = {
  id: "outline",
  normalizeConfig: (config) => {
    const raw = (config.baseUrl ?? "").trim();
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { error: "Enter the Outline address, like https://app.getoutline.com." };
    }
    if (url.protocol !== "https:" && url.protocol !== "http:")
      return { error: "The Outline address must start with https:// or http://." };
    const baseUrl = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    return { config: { baseUrl }, fingerprint: baseUrl };
  },
  oauth: {
    authorizeUrl: (config) => `${outlineBase(config)}/oauth/authorize`,
    tokenUrl: (config) => `${outlineBase(config)}/oauth/token`,
    scopes: ["read", "write"],
  },
  verify: (session) =>
    outlineCall<{ user?: { name?: string; email?: string }; team?: { name?: string } }>(
      session,
      "auth.info",
      {},
    ).pipe(
      Effect.map(({ data }) => {
        const person = data.user?.email || data.user?.name || "Outline account";
        return { accountLabel: data.team?.name ? `${person} · ${data.team.name}` : person };
      }),
    ),
  tools,
  knowledge: {
    browse: (session, parentId) =>
      Effect.gen(function* () {
        if (!parentId) {
          const collections = yield* outlineList<OutlineCollection>(
            session,
            "collections.list",
            {},
            500,
          );
          return collections.map((collection): BrowseNode => ({
            id: collectionNode(collection.id),
            title: collection.name,
            kind: "container",
            hasChildren: true,
          }));
        }
        if (parentId.startsWith(COLLECTION))
          return toBrowseNodes(yield* collectionTree(session, parentId.slice(COLLECTION.length)));
        if (parentId.startsWith(DOCUMENT)) {
          const { data } = yield* outlineCall<OutlineNavigationNode | OutlineNavigationNode[]>(
            session,
            "documents.documents",
            { id: parentId.slice(DOCUMENT.length) },
          );
          return toBrowseNodes(Array.isArray(data) ? data : (data.children ?? []));
        }
        return [];
      }),
    enumerate,
    fetch: (session, externalId) =>
      outlineCall<OutlineDocument>(session, "documents.info", {
        id: externalId.startsWith(DOCUMENT) ? externalId.slice(DOCUMENT.length) : externalId,
      }).pipe(
        Effect.map(({ data }) => ({
          title: data.title || "Untitled",
          markdown: data.text ?? "",
          url: absoluteUrl(session.config, data.url),
          updatedAt: new Date(data.updatedAt),
        })),
      ),
  },
};
