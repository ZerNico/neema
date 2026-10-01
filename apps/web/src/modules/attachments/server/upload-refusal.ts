import { Effect } from "effect";
import type { AttachmentRejected } from "../errors.ts";

/** An upload the attachment rules refused, answered alike by every upload function. */
export const refuseUpload = (error: AttachmentRejected) =>
  Effect.die(new Response(error.reason, { status: error.cause === "size" ? 413 : 415 }));
