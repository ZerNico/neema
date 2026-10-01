import { Option, Schema } from "effect";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** What an inspection covered: the first block shown and how many there are. Never text. */
export const WordRead = Schema.Struct({ from: Count, blockCount: Count });

const fields = {
  outcome: Schema.String,
  message: Schema.String,
  workingFileId: Schema.String,
  revision: Count,
  blockCount: Count,
  origin: Schema.Literals(["created", "opened"]),
  changes: Schema.String,
  read: WordRead,
};
/**
 * What a Word call leaves in the transcript. The engine persists it, the
 * stream carries it and the reload projection reads it back through the same
 * bounds. Document text never appears.
 */
export const WordActivityFields = {
  outcome: fields.outcome,
  message: fields.message,
  workingFileId: Schema.optionalKey(fields.workingFileId),
  revision: Schema.optionalKey(fields.revision),
  blockCount: Schema.optionalKey(fields.blockCount),
  origin: Schema.optionalKey(fields.origin),
  changes: Schema.optionalKey(fields.changes),
  read: Schema.optionalKey(fields.read),
};
const Summary = Schema.Struct(WordActivityFields);
export type WordActivitySummary = typeof Summary.Type;

const decoded = <T>(schema: Schema.Codec<T>, value: unknown) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value));
const bounded = (value: string | undefined, max: number) =>
  value ? value.slice(0, max) : undefined;

export function wordActivitySummary(raw: unknown, failed: boolean): WordActivitySummary {
  const result: Record<string, unknown> = raw && typeof raw === "object" ? { ...raw } : {};
  const workingFileId = bounded(decoded(fields.workingFileId, result.workingFileId), 100);
  const revision = decoded(fields.revision, result.revision);
  const blockCount = decoded(fields.blockCount, result.blockCount);
  const origin = decoded(fields.origin, result.origin);
  const changes = bounded(decoded(fields.changes, result.changes), 300);
  const read = decoded(fields.read, result.read);
  return {
    outcome: failed ? "error" : (bounded(decoded(fields.outcome, result.outcome), 40) ?? "error"),
    message: bounded(decoded(fields.message, result.message), 500) ?? "Word operation failed.",
    ...(workingFileId ? { workingFileId } : {}),
    ...(revision !== undefined ? { revision } : {}),
    ...(blockCount !== undefined ? { blockCount } : {}),
    ...(origin ? { origin } : {}),
    ...(changes ? { changes } : {}),
    ...(read ? { read } : {}),
  };
}
