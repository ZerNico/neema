import { Schema } from "effect";
import { defineIntegrationTool } from "../manifest.ts";

const optionalText = (description: string) =>
  Schema.optionalKey(Schema.String.annotate({ description }));

const text = (value: string | undefined) => (value?.trim() ? value.trim() : null);
const quoted = (value: string | undefined) => {
  const found = text(value);
  return found ? `“${found.length > 80 ? `${found.slice(0, 79)}…` : found}”` : null;
};

const searchTool = defineIntegrationTool({
  name: "search",
  title: "Search documents",
  label: "Searched Outline",
  description:
    "Full-text search across the Outline documents the user can access. Returns titles, links, ids and a short matching snippet; read a document for its full text.",
  access: "read",
  parameters: Schema.Struct({
    query: optionalText("Keywords to search for."),
    collectionId: optionalText("Only search this Outline collection."),
  }),
  summarize: (args) => quoted(args.query),
});

const readDocumentTool = defineIntegrationTool({
  name: "read_document",
  title: "Read a document",
  label: "Read an Outline document",
  description:
    "Read one Outline document as Markdown by id. Long documents come back in parts; pass `offset` from the previous answer to continue.",
  access: "read",
  parameters: Schema.Struct({
    id: optionalText("The document id from search or list."),
    offset: Schema.optionalKey(
      Schema.Number.annotate({ description: "Character offset to continue from." }),
    ),
  }),
  summarize: (args) => text(args.id),
});

const listTool = defineIntegrationTool({
  name: "list",
  title: "Browse collections and pages",
  label: "Browsed Outline",
  description:
    "Browse Outline. With no arguments, lists collections. With `collectionId`, lists that collection's top-level documents; with `documentId`, that document's children.",
  access: "read",
  parameters: Schema.Struct({
    collectionId: optionalText("Collection to list the documents of."),
    documentId: optionalText("Document to list the children of."),
  }),
  summarize: () => null,
});

const createDocumentTool = defineIntegrationTool({
  name: "create_document",
  title: "Create documents",
  label: "Create an Outline document",
  description:
    "Create a published Outline document from Markdown, in a collection or under a parent document.",
  access: "write",
  parameters: Schema.Struct({
    title: optionalText("Document title, at most 100 characters."),
    text: optionalText("Document body in Markdown."),
    collectionId: optionalText("Collection to create it in."),
    parentDocumentId: optionalText("Parent document to nest it under."),
  }),
  summarize: (args) => quoted(args.title),
});

const updateDocumentTool = defineIntegrationTool({
  name: "update_document",
  title: "Update documents",
  label: "Update an Outline document",
  description:
    "Change an Outline document. `mode` is append, prepend, replace (the whole body) or patch (replace `findText` with `text`). Pass `title` to rename.",
  access: "write",
  parameters: Schema.Struct({
    id: optionalText("The document id."),
    text: optionalText("Markdown to add, or the replacement."),
    mode: optionalText("append, prepend, replace or patch."),
    findText: optionalText("For patch: the exact existing text to replace."),
    title: optionalText("A new title."),
  }),
  summarize: (args) => quoted(args.title) ?? text(args.id),
});

const deleteDocumentTool = defineIntegrationTool({
  name: "delete_document",
  title: "Delete documents",
  label: "Delete an Outline document",
  description:
    "Move an Outline document to the trash, with every document nested under it. The user can restore it from Outline's trash. Only when the user asked for it.",
  access: "destructive",
  parameters: Schema.Struct({
    id: optionalText("The document id."),
  }),
  summarize: (args) => text(args.id),
});

export const OUTLINE_TOOLS = [
  searchTool,
  readDocumentTool,
  listTool,
  createDocumentTool,
  updateDocumentTool,
  deleteDocumentTool,
] as const;
