import { describe, expect, it } from "vitest";
import { documentCsp } from "./csp.ts";

describe("document CSP", () => {
  it("admits inline script in production only by the request's nonce", () => {
    const csp = documentCsp(true, "abc123");
    expect(csp).toContain("script-src 'self' 'nonce-abc123'");
    expect(csp).not.toMatch(/script-src [^;]*'unsafe-inline'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("ws:");
  });

  it.each([true, false])("allows local preview fetches (production: %s)", (production) => {
    const connect = documentCsp(production)
      .split("; ")
      .find((directive) => directive.startsWith("connect-src "));
    expect(connect?.split(" ").slice(1)).toEqual(
      production ? ["'self'", "blob:"] : ["'self'", "blob:", "ws:", "wss:"],
    );
  });

  it("runs no inline script in production when no nonce was minted", () => {
    expect(documentCsp(true)).toContain("script-src 'self';");
  });

  it("frames our own bytes but never a document", () => {
    for (const csp of [documentCsp(true, "n"), documentCsp(false)]) {
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
    // A nonce beside 'unsafe-inline' would disable it, so dev never names one.
    const csp = documentCsp(false, "abc123");
    expect(csp).toMatch(/script-src [^;]*'unsafe-inline'/);
    expect(csp).not.toContain("nonce-");
    expect(csp).toContain("connect-src 'self' blob: ws: wss:");
  });
});
