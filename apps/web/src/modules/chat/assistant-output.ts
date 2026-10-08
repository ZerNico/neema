import { Schema } from "effect";
import { Attachment } from "~/modules/attachments/schema.ts";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "~/modules/attachments/constants.ts";

/** Bounds for everything an answer produces itself: model images and tool files alike. */
export const ASSISTANT_FILE_LIMITS = {
  count: MAX_ATTACHMENTS_PER_MESSAGE,
  bytes: MAX_ATTACHMENT_BYTES,
  totalBytes: MAX_ATTACHMENT_BYTES * 2,
  replayBytes: 1024 * 1024,
} as const;
const Offset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/**
 * One file an assistant answer produced, anchored to the text it appeared in.
 * `origin` names the custom tool call that returned it; absent for a model's
 * own image output.
 */
export const AssistantFile = Schema.Struct({
  v: Schema.Literal(1),
  attachment: Attachment,
  textOffset: Offset,
  turnIndex: Offset,
  eventIndex: Offset,
  callIndex: Offset,
  origin: Schema.optional(Schema.Struct({ toolCallId: Schema.String })),
});
export type AssistantFile = typeof AssistantFile.Type;
/** One image found for a ```ui block's query, stored as a `search_image` attachment. */
export const UiImage = Schema.Struct({
  attachmentId: Schema.String,
  pageUrl: Schema.String,
  title: Schema.String,
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
});
export type UiImage = typeof UiImage.Type;
/**
 * What one query came to. `search_off` means the attempt had no web search to
 * ask, so the reader is told why rather than shown a broken tile.
 */
export const UiImageResult = Schema.Struct({
  status: Schema.Literals(["resolved", "unavailable", "search_off"]),
  items: Schema.Array(UiImage),
});
export type UiImageResult = typeof UiImageResult.Type;
/** Image results by normalised query (`normalizeQuery`). */
export type UiImages = Readonly<Record<string, UiImageResult>>;
export interface AssistantOutput {
  v: 1;
  files: ReadonlyArray<AssistantFile>;
  images?: UiImages;
}
