import { Option, Schema } from "effect";
import { INSPECT_LIMITS, PRESENTATION_LIMITS } from "./limits.ts";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** What an inspection covered, by slide position. Numbers only, never file text. */
export const PresentationRead = Schema.Struct({
  from: Count,
  to: Count,
  slides: Schema.optionalKey(Schema.Array(Count)),
  template: Schema.optionalKey(Schema.Literals(["layout", "master"])),
});

const fields = {
  outcome: Schema.String,
  message: Schema.String,
  workingFileId: Schema.String,
  revision: Count,
  slideCount: Count,
  previewWarning: Schema.String,
  origin: Schema.Literals(["created", "opened"]),
  changes: Schema.String,
  renderedSlideIds: Schema.Array(Count),
  read: PresentationRead,
};
/**
 * What a presentation call leaves in the transcript. The engine persists it, the
 * stream carries it and the reload projection reads it back through the same
 * bounds, so the three display paths agree. Operation payloads never appear.
 */
export const PresentationActivityFields = {
  outcome: fields.outcome,
  message: fields.message,
  workingFileId: Schema.optionalKey(fields.workingFileId),
  revision: Schema.optionalKey(fields.revision),
  slideCount: Schema.optionalKey(fields.slideCount),
  previewWarning: Schema.optionalKey(fields.previewWarning),
  origin: Schema.optionalKey(fields.origin),
  changes: Schema.optionalKey(fields.changes),
  renderedSlideIds: Schema.optionalKey(fields.renderedSlideIds),
  read: Schema.optionalKey(fields.read),
};
const Summary = Schema.Struct(PresentationActivityFields);
export type PresentationActivitySummary = typeof Summary.Type;

// Each field is kept only when it decodes; a malformed one drops rather than failing the summary.
const decoded = <T>(schema: Schema.Codec<T>, value: unknown) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value));
const bounded = (value: string | undefined, max: number) =>
  value ? value.slice(0, max) : undefined;

export function presentationActivitySummary(
  raw: unknown,
  failed: boolean,
): PresentationActivitySummary {
  const result: Record<string, unknown> = raw && typeof raw === "object" ? { ...raw } : {};
  const workingFileId = bounded(decoded(fields.workingFileId, result.workingFileId), 100);
  const revision = decoded(fields.revision, result.revision);
  const slideCount = decoded(fields.slideCount, result.slideCount);
  const previewWarning = bounded(decoded(fields.previewWarning, result.previewWarning), 500);
  const origin = decoded(fields.origin, result.origin);
  const changes = bounded(decoded(fields.changes, result.changes), 300);
  const rendered = decoded(fields.renderedSlideIds, result.renderedSlideIds) ?? [];
  const read = decoded(fields.read, result.read);
  return {
    outcome: failed ? "error" : (bounded(decoded(fields.outcome, result.outcome), 40) ?? "error"),
    message:
      bounded(decoded(fields.message, result.message), 500) ?? "Presentation operation failed.",
    ...(workingFileId ? { workingFileId } : {}),
    ...(revision !== undefined ? { revision } : {}),
    ...(slideCount !== undefined ? { slideCount } : {}),
    ...(previewWarning ? { previewWarning } : {}),
    ...(origin ? { origin } : {}),
    ...(changes ? { changes } : {}),
    ...(rendered.length
      ? { renderedSlideIds: rendered.slice(0, PRESENTATION_LIMITS.rendersPerCall) }
      : {}),
    ...(read
      ? {
          read: {
            from: read.from,
            to: read.to,
            ...(read.slides?.length
              ? { slides: read.slides.slice(0, INSPECT_LIMITS.selectedSlides) }
              : {}),
            ...(read.template ? { template: read.template } : {}),
          },
        }
      : {}),
  };
}
