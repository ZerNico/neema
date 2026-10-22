import { describe, expect, it } from "vitest";
import { GENERIC_MEDIA_TYPE } from "~/modules/attachments/constants.ts";
import { fileResponse, holdsCurrent } from "./file-response.ts";

const bytes = new Uint8Array([1, 2, 3]);

describe("fileResponse", () => {
  it("never lets a stored type render as a page on this origin", () => {
    const html = fileResponse(
      { bytes, name: "page.html", mediaType: "text/html" },
      { inline: true, cache: "never" },
    );
    expect(html.headers.get("Content-Type")).toBe(GENERIC_MEDIA_TYPE);
    expect(html.headers.get("Content-Disposition")).toMatch(/^attachment;/);
    expect(html.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const text = fileResponse(
      { bytes, name: "notes.txt", mediaType: "text/plain" },
      { cache: "never" },
    );
    expect(text.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
  });

  it("opens images and PDFs inline only when asked, and names the file safely", () => {
    const image = { bytes, name: 'Größe "1".png', mediaType: "image/png" };
    expect(fileResponse(image, { cache: "never" }).headers.get("Content-Disposition")).toBe(
      `attachment; filename="Gr__e _1_.png"; filename*=UTF-8''${encodeURIComponent(image.name)}`,
    );
    const inline = fileResponse(image, { inline: true, cache: "never" });
    expect(inline.headers.get("Content-Disposition")).toMatch(/^inline;/);
    expect(inline.headers.get("Content-Type")).toBe("image/png");
    expect(inline.headers.get("Content-Length")).toBe("3");
  });

  it("stores nothing unless the bytes are tagged, and then only to revalidate", () => {
    const file = { bytes, name: "deck.pptx", mediaType: "application/octet-stream" };
    const never = fileResponse(file, { cache: "never" });
    expect(never.headers.get("Cache-Control")).toBe("private, no-store");
    expect(never.headers.get("ETag")).toBeNull();
    const tagged = fileResponse(file, { cache: { etag: '"v1"' } });
    expect(tagged.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(tagged.headers.get("ETag")).toBe('"v1"');
  });

  it.each([
    ['"v1"', true],
    ['W/"v1"', true],
    ['"v0", "v1"', true],
    ["*", true],
    ['"v2"', false],
    [null, false],
  ])("matches If-None-Match %s against the tag", (header, held) => {
    const request = new Request(
      "http://test",
      header ? { headers: { "If-None-Match": header } } : {},
    );
    expect(holdsCurrent(request, '"v1"')).toBe(held);
  });
});
