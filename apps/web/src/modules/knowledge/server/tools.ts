import { randomUUID } from "node:crypto";
import { Effect, Schema, Semaphore } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { estimatePromptTokens } from "~/modules/chat/server/compaction.ts";
import type { SourceIndexer } from "~/modules/tools/server/source-indexer.ts";
import type { DocumentSource } from "~/modules/tools/source-schema.ts";
import { KnowledgeNotAvailable, KnowledgeRejected } from "../errors.ts";
import {
  KNOWLEDGE_TOOL_LIMITS,
  KnowledgeToolResult,
  ListDocumentsParams,
  ReadDocumentParams,
  SearchKnowledgeParams,
} from "../tool-schema.ts";
import type { KnowledgeSearchSession } from "./search.ts";
import { KnowledgeService } from "./service.ts";
import { textEnd, textPrefix } from "./text-range.ts";

export const listDocumentsTool = Tool.make("list_knowledge_documents", {
  description:
    "List the selected knowledge documents and their fixed version IDs. Use it when the request is about the collection itself (its contents, or comparing every document); for a question, search_knowledge already returns the references you need. Follow nextCursor for more. Pending or failed entries cannot be read; listing is not reading their content.",
  parameters: ListDocumentsParams,
  success: KnowledgeToolResult,
  failure: KnowledgeNotAvailable,
  failureMode: "error",
});
export const searchKnowledgeTool = Tool.make("search_knowledge", {
  description:
    "Search selected knowledge versions with up to three queries. Returns bounded excerpts, citation indexes and exact character ranges, not whole documents. Use read_knowledge_document to continue. Keyword-only retrieval is reported explicitly.",
  parameters: SearchKnowledgeParams,
  success: KnowledgeToolResult,
  failure: KnowledgeNotAvailable,
  failureMode: "error",
});
export const readDocumentTool = Tool.make("read_knowledge_document", {
  description:
    "Read bounded character ranges from up to four selected document/version IDs supplied by list_knowledge_documents or search_knowledge. Start at zero for a small document; follow nextOffset for more. A range is not proof that the entire collection was reviewed.",
  parameters: ReadDocumentParams,
  success: KnowledgeToolResult,
  failure: KnowledgeNotAvailable,
  failureMode: "error",
});

export const knowledgeResultTokens = (result: KnowledgeToolResult) =>
  estimatePromptTokens([{ role: "assistant", content: JSON.stringify(result) }]);

/** One fixed, authorized selection and budget, shared by every worker in a generation. */
export const prepareKnowledgeTools = Effect.fn("knowledge.prepareTools")(function* (input: {
  userId: string;
  session: KnowledgeSearchSession;
  indexer: SourceIndexer;
}) {
  const service = yield* KnowledgeService;
  const gate = yield* Semaphore.make(KNOWLEDGE_TOOL_LIMITS.concurrency);
  const cursorPrefix = randomUUID();
  let remaining = KNOWLEDGE_TOOL_LIMITS.operations as number;
  const base = (targets: ReadonlyArray<string>): KnowledgeToolResult => ({
    ok: true,
    targets,
    documents: [],
    passages: [],
    failures: [],
    sources: [],
    totalCount: input.session.manifest.length,
    nextCursor: null,
    remainingOps: remaining,
    coverage:
      "Only returned excerpts are evidence. Unread, pending and failed documents have not been reviewed.",
  });
  const fail = (targets: ReadonlyArray<string>, error: string): KnowledgeToolResult => ({
    ...base(targets),
    ok: false,
    error,
  });
  let accessFailure: KnowledgeNotAvailable | null = null;
  const authorize = () =>
    Effect.suspend(() =>
      accessFailure
        ? Effect.fail(accessFailure)
        : input.session.authorize().pipe(
            Effect.tapError((error) =>
              Effect.sync(() => {
                accessFailure = error;
              }),
            ),
          ),
    );
  const execute = <A>(
    schema: Schema.Codec<A, unknown>,
    raw: A,
    targets: ReadonlyArray<string>,
    operations: number,
    work: (
      value: A,
    ) => Effect.Effect<KnowledgeToolResult, KnowledgeNotAvailable | KnowledgeRejected>,
  ) =>
    Effect.gen(function* () {
      const value = yield* Schema.decodeUnknownEffect(schema)(raw).pipe(
        Effect.mapError(
          () => new KnowledgeRejected({ reason: "invalid knowledge tool arguments" }),
        ),
      );
      yield* authorize();
      if (operations > remaining) {
        remaining = 0;
        return fail(
          targets,
          "Knowledge operation limit reached. Answer from available evidence and disclose any incomplete review.",
        );
      }
      remaining -= operations;
      const result = yield* work(value);
      yield* authorize();
      if (knowledgeResultTokens(result) > KNOWLEDGE_TOOL_LIMITS.resultTokens)
        return fail(
          targets,
          "Result exceeds the response limit; request a smaller document batch or a shorter range.",
        );
      return { ...result, remainingOps: remaining };
    }).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (error._tag === "KnowledgeNotAvailable") accessFailure = error;
        }),
      ),
      Effect.catchTag("KnowledgeRejected", (error) => Effect.succeed(fail(targets, error.reason))),
    );

  // Fit the full encoded result, including citation metadata. Trimming an excerpt
  // changes its exact source range and continuation; never claim the original range.
  const append = (
    result: KnowledgeToolResult,
    passage: KnowledgeToolResult["passages"][number],
  ): KnowledgeToolResult => {
    const candidate = (requestedLength: number) => {
      const length = textEnd(passage.content, requestedLength);
      const source = {
        ...passage.source,
        endOffset: passage.source.startOffset + length,
        snippet: textPrefix(passage.content, Math.min(length, 500)),
      };
      const next = {
        ...passage,
        source,
        content: passage.content.slice(0, length),
        nextOffset:
          passage.totalChars !== null && source.endOffset >= passage.totalChars
            ? null
            : source.endOffset,
      };
      return {
        ...result,
        passages: [...result.passages, next],
        sources: [...result.sources, source],
      };
    };
    let high = passage.content.length;
    let low =
      knowledgeResultTokens(candidate(high)) <= KNOWLEDGE_TOOL_LIMITS.resultTokens - 1024
        ? high
        : 0;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (knowledgeResultTokens(candidate(middle)) <= KNOWLEDGE_TOOL_LIMITS.resultTokens - 1024)
        low = middle;
      else high = middle - 1;
    }
    low = textEnd(passage.content, low);
    if (low === 0)
      return {
        ...result,
        failures: [
          ...result.failures,
          {
            target: passage.source.versionId,
            error: "Response limit reached; read this document in another call.",
          },
        ],
      };
    const fitted = candidate(low);
    const last = fitted.passages[fitted.passages.length - 1]!;
    const source = { ...last.source, index: input.indexer.indexForDocument(last.source) };
    return {
      ...fitted,
      passages: [...fitted.passages.slice(0, -1), { ...last, source }],
      sources: [...fitted.sources.slice(0, -1), source],
    };
  };

  const list = (params: typeof ListDocumentsParams.Type) =>
    execute(ListDocumentsParams, params, [], 1, (value) =>
      Effect.gen(function* () {
        let start = 0;
        if (value.cursor !== undefined) {
          const prefix = `${cursorPrefix}:`;
          const suffix = value.cursor.slice(prefix.length);
          if (!value.cursor.startsWith(prefix) || !/^\d+$/.test(suffix))
            return yield* new KnowledgeRejected({ reason: "invalid document cursor" });
          start = Number(suffix);
          if (!Number.isSafeInteger(start) || start >= input.session.manifest.length)
            return yield* new KnowledgeRejected({ reason: "invalid document cursor" });
        }
        const documents = input.session.manifest.slice(
          start,
          start + KNOWLEDGE_TOOL_LIMITS.pageSize,
        );
        const page = () => ({
          ...base([]),
          documents: [...documents],
          nextCursor:
            start + documents.length < input.session.manifest.length
              ? `${cursorPrefix}:${start + documents.length}`
              : null,
        });
        while (
          documents.length > 1 &&
          knowledgeResultTokens(page()) > KNOWLEDGE_TOOL_LIMITS.resultTokens
        )
          documents.pop();
        return page();
      }),
    );
  const search = (params: typeof SearchKnowledgeParams.Type) =>
    execute(SearchKnowledgeParams, params, params.queries, params.queries.length, (value) =>
      Effect.gen(function* () {
        let result = base(value.queries);
        const results = yield* Effect.forEach(
          value.queries,
          (query) =>
            gate.withPermits(1)(
              authorize().pipe(Effect.andThen(input.session.search({ query, limit: 4 }))),
            ),
          { concurrency: KNOWLEDGE_TOOL_LIMITS.concurrency },
        );
        for (const found of results) {
          result = {
            ...result,
            mode: result.mode === "lexical" || found.mode === "lexical" ? "lexical" : "hybrid",
            ...(found.degradedReason ? { degradedReason: found.degradedReason } : {}),
          };
          for (const hit of found.passages) {
            // A search answers "where is this?", not "what does it say in full":
            // a hit is a bounded excerpt of its chunk, so a three-query batch
            // returns every hit instead of spending the response cap on the
            // first few whole chunks. read_knowledge_document follows the exact range.
            const content = textPrefix(hit.content, KNOWLEDGE_TOOL_LIMITS.searchExcerptChars);
            const source: DocumentSource = {
              collectionId: hit.collectionId,
              documentId: hit.documentId,
              versionId: hit.versionId,
              title: hit.title,
              headingPath: textPrefix(hit.headingPath, 1000),
              page: hit.page,
              startOffset: hit.startOffset,
              endOffset: hit.startOffset + content.length,
              kind: "document",
              index: 0,
              snippet: "",
              read: false,
            };
            result = append(result, {
              source,
              content,
              totalChars: null,
              nextOffset: hit.startOffset + content.length,
            });
          }
        }
        return result;
      }),
    );
  const read = (params: typeof ReadDocumentParams.Type) =>
    execute(
      ReadDocumentParams,
      params,
      params.documents.map((document) => document.versionId),
      params.documents.length,
      (value) =>
        Effect.gen(function* () {
          // Validate the whole batch before reading any body, including on later calls.
          const selected = value.documents.map((request) =>
            input.session.manifest.find(
              (entry) =>
                entry.documentId === request.documentId &&
                entry.versionId === request.versionId &&
                entry.status === "ready",
            ),
          );
          if (selected.some((entry) => !entry))
            return yield* new KnowledgeRejected({
              reason: "document is not in the selected manifest",
            });
          let result = base(value.documents.map((document) => document.versionId));
          let characters = KNOWLEDGE_TOOL_LIMITS.readChars as number;
          for (let index = 0; index < value.documents.length; index++) {
            const request = value.documents[index]!;
            const entry = selected[index]!;
            if (characters === 0) {
              result = {
                ...result,
                failures: [
                  ...result.failures,
                  {
                    target: request.versionId,
                    error: "Batch character limit reached; read this document in another call.",
                  },
                ],
              };
              continue;
            }
            yield* authorize();
            const excerpt = yield* gate.withPermits(1)(
              authorize().pipe(
                Effect.andThen(
                  service.read(input.userId, {
                    ...request,
                    collectionId: entry.collectionId,
                    maxChars: Math.min(request.maxChars, characters),
                  }),
                ),
              ),
            );
            characters -= excerpt.content.length;
            const source: DocumentSource = {
              kind: "document",
              index: 0,
              collectionId: entry.collectionId,
              documentId: request.documentId,
              versionId: request.versionId,
              title: excerpt.title,
              startOffset: excerpt.startOffset,
              endOffset: excerpt.endOffset,
              page: null,
              headingPath: "",
              snippet: "",
              read: true,
            };
            result = append(result, {
              source,
              content: excerpt.content,
              totalChars: excerpt.totalChars,
              nextOffset: excerpt.nextOffset,
            });
          }
          return result;
        }),
    );

  return {
    group: {
      toolkit: Toolkit.make(listDocumentsTool, searchKnowledgeTool, readDocumentTool),
      handlers: {
        list_knowledge_documents: list,
        search_knowledge: search,
        read_knowledge_document: read,
      },
    },
    remaining: () => remaining,
    authorize,
  };
});
