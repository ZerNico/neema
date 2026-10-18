import { Schema } from "effect";
import { EntityId } from "~/entity-id.ts";

const sourceFields = {
  index: Schema.Int,
  title: Schema.String,
  snippet: Schema.String,
  /** Extraction/read evidence, not a claim that the entire source was read. */
  read: Schema.Boolean,
};

export const WebSource = Schema.Struct({
  ...sourceFields,
  kind: Schema.Literals(["web"]),
  url: Schema.String,
});
export type WebSource = typeof WebSource.Type;

export const DocumentLocation = Schema.Struct({
  collectionId: EntityId,
  documentId: EntityId,
  versionId: EntityId,
  startOffset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  endOffset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export type DocumentLocation = typeof DocumentLocation.Type;
export const DocumentSource = Schema.Struct({
  ...sourceFields,
  ...DocumentLocation.fields,
  kind: Schema.Literals(["document"]),
  title: Schema.String.check(Schema.isMaxLength(120)),
  snippet: Schema.String.check(Schema.isMaxLength(500)),
  page: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  headingPath: Schema.String.check(Schema.isMaxLength(1000)),
}).check(Schema.makeFilter((source) => source.endOffset > source.startOffset));
export type DocumentSource = typeof DocumentSource.Type;

/**
 * A page in a connected service. It carries a link for the reader but, unlike
 * a web source, grants no authority to fetch it: the page sits behind the
 * user's own credentials, and `read_url` would only reach its sign-in page.
 */
export const IntegrationSource = Schema.Struct({
  ...sourceFields,
  kind: Schema.Literals(["integration"]),
  integrationId: Schema.String.check(Schema.isMaxLength(32)),
  url: Schema.String,
});
export type IntegrationSource = typeof IntegrationSource.Type;

export const Source = Schema.Union([DocumentSource, WebSource, IntegrationSource]);
export type Source = typeof Source.Type;
