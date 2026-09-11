import { Schema } from "effect";

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

const ResourceId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
export const DocumentLocation = Schema.Struct({
  collectionId: ResourceId,
  documentId: ResourceId,
  versionId: ResourceId,
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

export const Source = Schema.Union([DocumentSource, WebSource]);
export type Source = typeof Source.Type;
