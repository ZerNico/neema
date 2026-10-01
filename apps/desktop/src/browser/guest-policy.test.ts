import { describe, expect, it } from "vitest";
import { admitWebview } from "./guest-policy.ts";

const ours = (partition: string) => partition === "persist:browser-ours";

describe("admitWebview", () => {
  it("hardens an admitted guest whatever the markup asked for", () => {
    const preferences: Record<string, unknown> = {
      preload: "file:///evil.js",
      preloadURL: "file:///evil.js",
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
    };
    expect(
      admitWebview(
        { partition: "persist:browser-ours", src: "https://example.com" },
        preferences,
        ours,
      ),
    ).toBe(true);
    expect(preferences).toEqual({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    });
  });

  it("admits a blank start page", () => {
    expect(admitWebview({ partition: "persist:browser-ours" }, {}, ours)).toBe(true);
    expect(admitWebview({ partition: "persist:browser-ours", src: "about:blank" }, {}, ours)).toBe(
      true,
    );
  });

  it("refuses other partitions and non-web addresses", () => {
    for (const params of [
      { partition: "persist:main", src: "https://example.com" },
      { src: "https://example.com" },
      { partition: "persist:browser-ours", src: "file:///etc/passwd" },
      { partition: "persist:browser-ours", src: "javascript:alert(1)" },
      { partition: "persist:browser-ours", src: "chrome://settings" },
    ])
      expect(admitWebview(params, {}, ours)).toBe(false);
  });
});
