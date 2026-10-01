import { describe, expect, it } from "vitest";
import { GENERIC_MEDIA_TYPE } from "~/modules/attachments/constants.ts";
import { fileResponse } from "./file-response.ts";

const bytes = new Uint8Array([1, 2, 3]);

describe("fileResponse", () => {
  it("never lets a stored type render as a page on this origin", () => {
    const html = fileResponse(
      { bytes, name: "page.html", mediaType: "text/html" },
      { inline: true, cache: "revocable" },
    );
    expect(html.headers.get("Content-Type")).toBe(GENERIC_MEDIA_TYPE);
    expect(html.headers.get("Content-Disposition")).toMatch(/^attachment;/);
    expect(html.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const text = fileResponse(
      { bytes, name: "notes.txt", mediaType: "text/plain" },
      { cache: "revocable" },
    );
    expect(text.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
  });

  it("opens images and PDFs inline only when asked, and names the file safely", () => {
    const image = { bytes, name: 'Größe "1".png', mediaType: "image/png" };
    expect(fileResponse(image, { cache: "immutable" }).headers.get("Content-Disposition")).toBe(
      `attachment; filename="Gr__e _1_.png"; filename*=UTF-8''${encodeURIComponent(image.name)}`,
    );
    const inline = fileResponse(image, { inline: true, cache: "immutable" });
    expect(inline.headers.get("Content-Disposition")).toMatch(/^inline;/);
    expect(inline.headers.get("Content-Type")).toBe("image/png");
    expect(inline.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
    expect(inline.headers.get("Content-Length")).toBe("3");
  });

  it("caches nothing whose access can be taken away", () => {
    const response = fileResponse(
      { bytes, name: "deck.pptx", mediaType: "application/octet-stream" },
      { cache: "revocable" },
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
