import { Effect, Schema } from "effect";
import { KnowledgeSearch } from "~/modules/knowledge/server/search.ts";
import { KnowledgeService } from "~/modules/knowledge/server/service.ts";
import { KNOWLEDGE_LIMITS } from "~/modules/knowledge/schema.ts";
import { sourceTarget } from "~/modules/tools/sources.ts";
import { defineTool, refused, result } from "./define.ts";

const readOnly = { readOnlyHint: true, openWorldHint: false } as const;
const MAX_READ = 16_000;

/** Where a passage opens in the app, for its reader only. */
const passageUrl = (
  origin: string,
  passage: {
    collectionId: string;
    documentId: string;
    versionId: string;
    startOffset: number;
    endOffset: number;
  },
) =>
  `${origin}${sourceTarget({
    kind: "document",
    collectionId: passage.collectionId,
    documentId: passage.documentId,
    versionId: passage.versionId,
    startOffset: passage.startOffset,
    endOffset: passage.endOffset,
  })}`;

const unavailable = () =>
  Effect.fail(refused("That isn't available to this account. Call list_collections."));

export const listCollections = defineTool({
  name: "list_collections",
  title: "List knowledge collections",
  description:
    "The knowledge collections this person may search: their own and those shared with them, with their documents when collectionId is given.",
  scope: "knowledge:read",
  input: Schema.Struct({ collectionId: Schema.optionalKey(Schema.String) }),
  annotations: readOnly,
  run: (args, { principal }) =>
    Effect.gen(function* () {
      const knowledge = yield* KnowledgeService;
      if (args.collectionId) {
        const { collection, documents } = yield* knowledge
          .detail(principal.userId, args.collectionId)
          .pipe(Effect.catchTag("KnowledgeNotAvailable", unavailable));
        const rows = documents.map((document) => ({
          documentId: document.id,
          versionId: document.versionId,
          title: document.title,
          status: document.status,
          charCount: document.charCount,
        }));
        const lines = rows.map(
          (d) =>
            `- ${d.title} (documentId ${d.documentId}, versionId ${d.versionId ?? "none"}, ${d.status})`,
        );
        return result(
          [`# ${collection.name}`, collection.description, ...lines].filter(Boolean).join("\n"),
          { collection: { id: collection.id, name: collection.name }, documents: rows },
        );
      }
      const collections = (yield* knowledge.list(principal.userId)).map((collection) => ({
        id: collection.id,
        name: collection.name,
        description: collection.description,
        documents: collection.readyCount,
        owner: collection.ownerName,
      }));
      return result(
        collections.length
          ? collections
              .map(
                (c) =>
                  `- ${c.name} (${c.id}), ${c.documents} documents${c.description ? `: ${c.description}` : ""}`,
              )
              .join("\n")
          : "No knowledge collections.",
        { collections },
      );
    }),
});

export const searchKnowledge = defineTool({
  name: "search_knowledge",
  title: "Search knowledge",
  description: `Searches up to ${KNOWLEDGE_LIMITS.maxCollectionsPerSelection} knowledge collections (ids from list_collections) and returns the best passages, each with where it opens in the app and the ids read_knowledge_document takes.`,
  scope: "knowledge:read",
  input: Schema.Struct({
    query: Schema.String,
    collectionIds: Schema.Array(Schema.String),
    limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
  }),
  annotations: readOnly,
  run: (args, { principal, origin }) =>
    Effect.gen(function* () {
      if (!args.query.trim()) return yield* refused("Give a query to search for.");
      if (args.collectionIds.length === 0)
        return yield* refused("Name the collections to search. Call list_collections.");
      const userId = principal.userId;
      const manifest = yield* KnowledgeService.use((knowledge) =>
        knowledge.manifest(userId, args.collectionIds),
      ).pipe(
        Effect.catchTags({
          KnowledgeNotAvailable: unavailable,
          KnowledgeRejected: (error) => Effect.fail(refused(`Can't search: ${error.reason}.`)),
        }),
      );
      const versionIds = manifest.flatMap((entry) =>
        entry.status === "ready" && entry.versionId ? [entry.versionId] : [],
      );
      const found = yield* KnowledgeSearch.use((search) =>
        search.search({ userId, versionIds, query: args.query, limit: args.limit ?? 8 }),
      ).pipe(
        Effect.catchTags({
          KnowledgeNotAvailable: unavailable,
          KnowledgeRejected: (error) => Effect.fail(refused(`Can't search: ${error.reason}.`)),
        }),
      );
      const passages = found.passages.map((passage) => ({
        title: passage.title,
        headingPath: passage.headingPath || null,
        page: passage.page,
        collectionId: passage.collectionId,
        documentId: passage.documentId,
        versionId: passage.versionId,
        startOffset: passage.startOffset,
        content: passage.content,
        url: passageUrl(origin, passage),
      }));
      const text = passages.length
        ? passages
            .map(
              (p, i) =>
                `## ${i + 1}. ${p.title}${p.headingPath ? ` › ${p.headingPath}` : ""}${p.page ? ` (page ${p.page})` : ""}\n${p.content}\n${p.url}`,
            )
            .join("\n\n")
        : "Nothing in these collections matches.";
      return result(
        found.degradedReason
          ? `${text}\n\nOnly keyword search ran: ${found.degradedReason}.`
          : text,
        { passages, mode: found.mode },
      );
    }),
});

export const readKnowledgeDocument = defineTool({
  name: "read_knowledge_document",
  title: "Read a knowledge document",
  description: `Reads a knowledge document's text from startOffset, up to ${MAX_READ} characters at a time; nextOffset says where to go on.`,
  scope: "knowledge:read",
  input: Schema.Struct({
    collectionId: Schema.String,
    documentId: Schema.String,
    versionId: Schema.String,
    startOffset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  }),
  annotations: readOnly,
  run: (args, { principal }) =>
    Effect.gen(function* () {
      const excerpt = yield* KnowledgeService.use((knowledge) =>
        knowledge.read(principal.userId, {
          collectionId: args.collectionId,
          documentId: args.documentId,
          versionId: args.versionId,
          startOffset: args.startOffset ?? 0,
          maxChars: MAX_READ,
        }),
      ).pipe(
        Effect.catchTags({
          KnowledgeNotAvailable: unavailable,
          KnowledgeRejected: (error) => Effect.fail(refused(`Can't read that: ${error.reason}.`)),
        }),
      );
      const more =
        excerpt.nextOffset !== null
          ? `\n\n(${excerpt.endOffset} of ${excerpt.totalChars} characters; read on from startOffset ${excerpt.nextOffset})`
          : "";
      return result(`# ${excerpt.title}\n\n${excerpt.content}${more}`, {
        title: excerpt.title,
        content: excerpt.content,
        startOffset: excerpt.startOffset,
        endOffset: excerpt.endOffset,
        totalChars: excerpt.totalChars,
        nextOffset: excerpt.nextOffset,
      });
    }),
});
