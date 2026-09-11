import { Schema } from "effect";
import { Attachment } from "~/modules/attachments/schema.ts";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "~/modules/attachments/constants.ts";

export const IMAGE_OUTPUT_LIMITS = {
  count: MAX_ATTACHMENTS_PER_MESSAGE,
  bytes: MAX_ATTACHMENT_BYTES,
  totalBytes: MAX_ATTACHMENT_BYTES * 2,
  replayBytes: 256 * 1024,
} as const;
const Offset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const AssistantImage = Schema.Struct({
  v: Schema.Literal(1),
  attachment: Attachment,
  textOffset: Offset,
  turnIndex: Offset,
  eventIndex: Offset,
  callIndex: Offset,
});
export type AssistantImage = typeof AssistantImage.Type;
export interface AssistantOutput {
  v: 1;
  images: ReadonlyArray<AssistantImage>;
}
