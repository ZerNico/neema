import { McpServer, ResourceNotFoundError, ResourceTemplate } from "@modelcontextprotocol/server";
import { Effect } from "effect";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import type { McpPrincipal } from "./auth.ts";
import type { McpRun } from "./tools/define.ts";

const utf8 = (bytes: Uint8Array) => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

/** Where an answer's files are read from, by the client that was handed their links. */
export const fileUri = (attachmentId: string) => `chat://attachments/${attachmentId}`;

/**
 * An answer's files, read by id with the same access check serving them in
 * the app makes, so a link names nothing its holder could not open there.
 */
export const installFileResource = (
  server: McpServer,
  env: { principal: McpPrincipal; run: McpRun<AttachmentService> },
) =>
  server.registerResource(
    "file",
    new ResourceTemplate("chat://attachments/{id}", { list: undefined }),
    { title: "A file from a chat", description: "A file an answer produced or a message carried." },
    async (uri, variables, context) => {
      const id = [variables["id"]].flat()[0] ?? "";
      const file = await env.run(
        AttachmentService.use((attachments) =>
          attachments.read({ userId: env.principal.userId, attachmentId: id }),
        ).pipe(
          // Missing and someone else's read the same: nothing to tell apart.
          Effect.catchTag("AttachmentNotAvailable", () => Effect.succeed(null)),
        ),
        context.mcpReq.signal,
      );
      if (!file) throw new ResourceNotFoundError(uri.href, "There is no file at that address.");
      // Text only when it reads as UTF-8; anything else goes as it is stored.
      const text = file.mediaType.startsWith("text/") ? utf8(file.bytes) : null;
      const content =
        text !== null
          ? { text }
          : {
              blob: Buffer.from(
                file.bytes.buffer,
                file.bytes.byteOffset,
                file.bytes.byteLength,
              ).toString("base64"),
            };
      return { contents: [{ uri: uri.href, mimeType: file.mediaType, ...content }] };
    },
  );
