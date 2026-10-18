import { Effect, Schema } from "effect";
import { ChatRepo } from "~/modules/chat/server/repo.ts";
import { blockView, commentsView } from "~/modules/documents/editor/tree.ts";
import { placement, type TreeEdit } from "~/modules/documents/editor/tree-edit.ts";
import { DocumentTitle } from "~/modules/documents/schema.ts";
import type { DocumentOwner } from "~/modules/documents/server/document-repo.ts";
import { DocumentService } from "~/modules/documents/server/document-service.ts";
import { FOCUS_CHARS } from "~/modules/documents/server/document-tools.ts";
import { defineTool, refused, result } from "./define.ts";

const changes = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
/** What a read hands out as seen: enough for a document read in pieces, never unbounded. */
const MAX_SEEN_CHARS = 200_000;

const missing = () =>
  Effect.fail(refused("There is no document with that id. Call list_documents."));

/**
 * The blocks a read showed, by id and fingerprint, as one opaque string the
 * edit must hand back. A forged one could only claim this person's own
 * document was seen; the edit still lands only where blocks match it.
 */
const encodeSeen = (seen: ReadonlyArray<readonly [id: string, hash: string]>) =>
  Buffer.from(JSON.stringify(seen)).toString("base64url");

const decodeSeen = (raw: string) => {
  if (raw.length > MAX_SEEN_CHARS) return null;
  try {
    const pairs: unknown = JSON.parse(Buffer.from(raw, "base64url").toString());
    if (
      !Array.isArray(pairs) ||
      !pairs.every(
        (pair) =>
          Array.isArray(pair) &&
          pair.length === 2 &&
          typeof pair[0] === "string" &&
          typeof pair[1] === "string",
      )
    )
      return null;
    return new Map(pairs as Array<[string, string]>);
  } catch {
    return null;
  }
};

/** A refused edit in words for an outside app, which has no allowDetach and no trailing data. */
const explainEdit = (refusal: { outcome: string; message: string }) => {
  switch (refusal.outcome) {
    case "conflict":
      return "Those blocks changed since your read, or the read didn't show them. Read the document again and aim the edit at what it shows now.";
    case "anchors_affected":
      return "Nothing changed: this would remove all the text an open comment is on. Keep some of it, or have the person resolve the comment in the app.";
    default:
      return refusal.message;
  }
};

/** Whose documents: one chat of this person's, or one of their projects. */
const ownerOf = Effect.fn("mcp.documentOwner")(function* (
  userId: string,
  args: { chatId?: string; projectId?: string },
) {
  if ((args.chatId === undefined) === (args.projectId === undefined))
    return yield* refused("Name either a chatId or a projectId.");
  if (args.chatId) {
    yield* ChatRepo.use((repo) => repo.getConversation(userId, args.chatId!)).pipe(
      Effect.catchTag("ConversationNotFound", () =>
        Effect.fail(refused("There is no chat with that id. Call list_chats.")),
      ),
    );
    return { conversationId: args.chatId } satisfies DocumentOwner;
  }
  return { projectId: args.projectId! } satisfies DocumentOwner;
});

export const listDocuments = defineTool({
  name: "list_documents",
  title: "List documents",
  description:
    "The text documents of one chat or one project (pass chatId or projectId), with whether this person may edit each.",
  scope: "documents:read",
  input: Schema.Struct({
    chatId: Schema.optionalKey(Schema.String),
    projectId: Schema.optionalKey(Schema.String),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  run: (args, { principal }) =>
    Effect.gen(function* () {
      const owner = yield* ownerOf(principal.userId, args);
      const documents = (yield* DocumentService.use((service) =>
        service.list(principal.userId, owner),
      )).map((document) => ({
        id: document.id,
        title: document.title,
        canEdit: document.canEdit,
        lastEditedBy: document.lastEditedBy,
        updatedAt: document.updatedAt,
      }));
      return result(
        documents.length
          ? documents
              .map((d) => `- ${d.title} (${d.id})${d.canEdit ? "" : ", read-only"}`)
              .join("\n")
          : "No documents.",
        { documents },
      );
    }),
});

export const readDocument = defineTool({
  name: "read_document",
  title: "Read a document",
  description: [
    "Reads a document as XML: each block carries the id edits aim at.",
    "A long one comes in pieces; pass fromBlock (and fromCharacter, inside a long block) from the answer to read on.",
    "Edits must hand back the seen value of the read they rest on, so text this person typed since is never written over; pass the previous seen when reading on, and the answer's seen covers both pieces.",
  ].join(" "),
  scope: "documents:read",
  input: Schema.Struct({
    documentId: Schema.String,
    fromBlock: Schema.optionalKey(Schema.String),
    fromCharacter: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    /** The previous piece's seen, so one value covers every piece read. */
    seen: Schema.optionalKey(Schema.String),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  run: (args, { principal }) =>
    Effect.gen(function* () {
      const read = yield* DocumentService.use((service) =>
        service.read(principal.userId, args.documentId),
      );
      if (!read) return yield* missing();
      const view = blockView(read.doc, {
        budget: FOCUS_CHARS,
        ...(args.fromBlock ? { fromBlock: args.fromBlock } : {}),
        ...(args.fromCharacter !== undefined ? { fromCharacter: args.fromCharacter } : {}),
      });
      const threads = read.comments.length ? commentsView(read.doc, read.comments) : "";
      const earlier = args.seen === undefined ? new Map<string, string>() : decodeSeen(args.seen);
      if (!earlier) return yield* refused("seen isn't a value read_document gave out.");
      // This piece's fingerprints win: they are what the document is now.
      const seen = encodeSeen([
        ...[...earlier].filter(([id]) => !view.seen.some((block) => block.id === id)),
        ...view.seen.map((block) => [block.id, block.hash] as const),
      ]);
      if (seen.length > MAX_SEEN_CHARS)
        return yield* refused(
          "That's more of the document than one edit can rest on. Read again from where you edit.",
        );
      const next = view.next ?? null;
      const more = next
        ? `\n\nMore follows: read on with fromBlock ${next.fromBlock}${next.fromCharacter !== undefined ? ` and fromCharacter ${next.fromCharacter}` : ""}.`
        : "";
      return result(
        [`# ${read.document.title}`, view.xml, threads].filter(Boolean).join("\n\n") +
          `${more}\n\nseen: ${seen}`,
        {
          documentId: read.document.id,
          title: read.document.title,
          revision: read.document.revision,
          canEdit: read.document.canEdit,
          xml: view.xml,
          next,
          seen,
        },
      );
    }),
});

export const editDocument = defineTool({
  name: "edit_document",
  title: "Edit a document",
  description: [
    "Changes a document as this person: replaces, or writes before or after, the block target (through ends a range), with content as Markdown; no content deletes.",
    "Or pass find with content to replace exactly that text in one block: it changes only what it names, so the rest of the block is never written over.",
    "seen is required: the value from the read_document call the edit rests on. A block changed since then is refused; read again.",
  ].join(" "),
  scope: "documents:write",
  input: Schema.Struct({
    documentId: Schema.String,
    seen: Schema.String,
    target: Schema.optionalKey(Schema.String),
    through: Schema.optionalKey(Schema.String),
    position: Schema.optionalKey(Schema.Literals(["replace", "before", "after", "end"])),
    find: Schema.optionalKey(Schema.String),
    content: Schema.optionalKey(Schema.String),
  }),
  annotations: changes,
  run: (args, { principal }) =>
    Effect.gen(function* () {
      const userId = principal.userId;
      const seen = decodeSeen(args.seen);
      if (!seen) return yield* refused("seen isn't a value read_document gave out. Read again.");
      const service = yield* DocumentService;
      const read = yield* service.read(userId, args.documentId);
      if (!read) return yield* missing();
      if (!read.document.canEdit) return yield* refused("This person may only read this document.");
      let edit: TreeEdit;
      if (args.find !== undefined) {
        if (args.content === undefined)
          return yield* refused("find needs content: the text that replaces it.");
        edit = {
          kind: "find",
          find: args.find,
          content: args.content,
          ...(args.target ? { target: args.target } : {}),
        };
      } else if (args.target !== undefined) {
        const placed = placement(read.doc, args.target, args.position ?? "replace");
        edit = {
          kind: "blocks",
          target: placed.target,
          ...(args.through ? { through: args.through } : {}),
          position: placed.position,
          ...(args.content !== undefined ? { content: args.content } : {}),
        };
      } else return yield* refused("Name the block with target, or pass find with content.");
      const applied = yield* service
        .apply(userId, {
          documentId: read.document.id,
          edit,
          seen,
          // Text under open comments is never taken away from outside the app.
          allowDetach: false,
          asPerson: { clientId: `app:${principal.clientId}` },
        })
        .pipe(
          Effect.catchTag("DocumentNotAvailable", missing),
          Effect.catchTag("DocumentRejected", (error) =>
            Effect.fail(refused(`Edit refused: ${error.reason}.`)),
          ),
        );
      if (!("touched" in applied)) return yield* refused(explainEdit(applied));
      return result(applied.outcome === "updated" ? "Changed." : "That changed nothing.", {
        outcome: applied.outcome,
        revision: applied.document.revision,
        blocks: applied.touched,
      });
    }),
});

export const createDocument = defineTool({
  name: "create_document",
  title: "Create a document",
  // Only in a project: a chat's documents belong to the answers that made
  // them, and one made from outside would hang off whichever answer came last.
  description:
    "Creates a text document in one of this person's projects (projectId from list_projects), written from Markdown.",
  scope: "documents:write",
  input: Schema.Struct({
    projectId: Schema.String,
    title: DocumentTitle,
    content: Schema.String,
  }),
  annotations: changes,
  run: (args, { principal }) =>
    Effect.gen(function* () {
      const created = yield* DocumentService.use((service) =>
        service.create(principal.userId, {
          projectId: args.projectId,
          title: args.title,
          content: args.content,
          by: "user",
        }),
      ).pipe(
        Effect.catchTag("DocumentNotAvailable", () =>
          Effect.fail(
            refused("That project isn't one this person may write in. Call list_projects."),
          ),
        ),
        Effect.catchTag("DocumentRejected", (error) =>
          Effect.fail(refused(`Can't create it: ${error.reason}.`)),
        ),
      );
      return result(`Created “${created.document.title}” (${created.document.id}).`, {
        documentId: created.document.id,
        title: created.document.title,
      });
    }),
});
