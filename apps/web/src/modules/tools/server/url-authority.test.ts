import { describe, expect, it } from "vitest";
import { createUrlAuthority } from "./url-authority.ts";

describe("createUrlAuthority", () => {
  it("seeds canonical URLs and resolves equivalent forms", () => {
    const authority = createUrlAuthority(["https://example.com/path#section"]);

    expect(authority.seeded).toBe(true);
    expect(authority.resolve("https://example.com:443/path#other")).toBe(
      "https://example.com/path",
    );
  });

  it("grows as searches return new URLs", () => {
    const authority = createUrlAuthority([]);
    expect(authority.seeded).toBe(false);
    expect(authority.resolve("https://result.example/")).toBeNull();

    authority.allow("https://result.example/#top");
    expect(authority.resolve("https://result.example")).toBe("https://result.example/");
  });

  it("never resolves invalid or unseen URLs", () => {
    const authority = createUrlAuthority(["https://allowed.example/"]);

    expect(authority.resolve("ftp://allowed.example/")).toBeNull();
    expect(authority.resolve("https://invented.example/")).toBeNull();
  });
});
