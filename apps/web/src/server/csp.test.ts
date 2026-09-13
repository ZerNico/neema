import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { desktopChromeInitScript, themeInitScript } from "~/ui/boot-scripts.ts";
import { documentCsp } from "./csp.ts";

const sha256 = (source: string) => createHash("sha256").update(source).digest("base64");

describe("document CSP", () => {
  it("hashes the boot scripts in production and does not allow inline script", () => {
    const csp = documentCsp(true);
    expect(csp).toContain(`'sha256-${sha256(themeInitScript)}'`);
    expect(csp).toContain(`'sha256-${sha256(desktopChromeInitScript)}'`);
    expect(csp).not.toMatch(/script-src [^;]*'unsafe-inline'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("ws:");
  });

  it("frames our own bytes but never a document", () => {
    for (const csp of [documentCsp(true), documentCsp(false)]) {
      // The attachment PDF preview is an iframe over `/api/files/:id`, which
      // this had refused. Tightening it back would blank that preview with no
      // error anyone sees, so it is pinned here rather than left to taste.
      expect(csp).toContain("frame-src 'self'");
      // Documents carry this and the bytes route does not, so "self" cannot
      // become the app nesting inside itself.
      expect(csp).toContain("frame-ancestors 'none'");
    }
  });

  it("lets Vite inject scripts and open a WebSocket in development", () => {
    const csp = documentCsp(false);
    expect(csp).toMatch(/script-src [^;]*'unsafe-inline'/);
    expect(csp).toContain("connect-src 'self' ws: wss:");
  });
});
