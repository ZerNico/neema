import { describe, expect, it } from "vitest";
import { FAVICON_MAX_BYTES, faviconDataUrl, inlineFavicon } from "./favicon.ts";

describe("favicons", () => {
  it("turns small images into data URLs", () => {
    expect(faviconDataUrl("image/png; charset=binary", new Uint8Array([1, 2, 3]))).toBe(
      "data:image/png;base64,AQID",
    );
    expect(faviconDataUrl("image/svg+xml", new Uint8Array([60]))).toBe(
      "data:image/svg+xml;base64,PA==",
    );
  });

  it("refuses what is not a small image", () => {
    expect(faviconDataUrl("text/html", new Uint8Array([1]))).toBeNull();
    expect(faviconDataUrl(null, new Uint8Array([1]))).toBeNull();
    expect(faviconDataUrl("image/png", new Uint8Array())).toBeNull();
    expect(faviconDataUrl("image/png", new Uint8Array(FAVICON_MAX_BYTES + 1))).toBeNull();
  });

  it("keeps inline image icons and nothing else inline", () => {
    expect(inlineFavicon("data:image/png;base64,AQID")).toBe("data:image/png;base64,AQID");
    expect(inlineFavicon("data:text/html,<script>")).toBeNull();
    expect(inlineFavicon("https://a.test/favicon.ico")).toBeNull();
  });
});
