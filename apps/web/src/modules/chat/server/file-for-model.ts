import { Effect } from "effect";
import type { Prompt } from "effect/unstable/ai";
import { attachmentKind } from "~/modules/attachments/constants.ts";
import type { DocumentParser } from "~/modules/attachments/server/document-parser.ts";
import { opaqueFileText } from "~/modules/attachments/server/file-text.ts";
import { buildTextFence } from "~/modules/attachments/server/validation.ts";
import { PDF_TEXT_LABEL } from "./prompt.ts";

const decoder = new TextDecoder();

/**
 * How a file produced mid-generation (a desktop read, a custom tool's return)
 * reaches the model on the next round: the same rule an uploaded attachment
 * follows. Bytes when the model can take that kind, extracted text for a PDF
 * otherwise, and a plain sentence for an image it cannot see, so switching to
 * a narrower model never fails a turn on a file it was handed earlier.
 */
export const fileForModel = (
  parser: Pick<DocumentParser["Service"], "parsePdf">,
  input: {
    id?: string;
    fileName: string;
    mediaType: string;
    bytes: Uint8Array;
    vision: boolean;
    files: boolean;
  },
): Effect.Effect<Prompt.UserMessagePartEncoded> =>
  Effect.gen(function* () {
    const kind = attachmentKind(input.mediaType);
    if (kind === "file")
      return {
        type: "text",
        text: yield* opaqueFileText(
          {
            ...(input.id ? { id: input.id } : {}),
            fileName: input.fileName,
            size: input.bytes.length,
          },
          () => Effect.succeed(input.bytes),
        ),
      };
    if ((kind === "image" && input.vision) || (kind === "pdf" && input.files))
      return {
        type: "file",
        mediaType: input.mediaType,
        fileName: input.fileName,
        data: input.bytes,
      };
    if (kind === "pdf") {
      const parsed = yield* parser
        .parsePdf({ bytes: input.bytes, fileName: input.fileName })
        .pipe(Effect.result);
      return {
        type: "text",
        text:
          parsed._tag === "Success"
            ? buildTextFence({
                fileName: input.fileName,
                text: parsed.success.text,
                label: PDF_TEXT_LABEL,
              })
            : `${input.fileName} is a PDF, and its text could not be extracted on this server.`,
      };
    }
    if (kind === "image")
      return {
        type: "text",
        text: `${input.fileName} is an image, and this model cannot look at images. Tell the user rather than guessing at its contents.`,
      };
    return {
      type: "text",
      text: buildTextFence({ fileName: input.fileName, text: decoder.decode(input.bytes) }),
    };
  });
