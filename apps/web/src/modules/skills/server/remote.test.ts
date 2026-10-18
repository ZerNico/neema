import { sha256Hex } from "~/modules/attachments/server/sha256.ts";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchSkillBytes,
  parseDiscoveryResponse,
  parseSkillUrl,
  reviewGitHubSkill,
  SkillRemoteError,
} from "./remote.ts";
vi.mock("~/modules/tools/server/url-safety.ts", () => ({
  resolvePublicHttpUrl: (url: string) =>
    Effect.succeed({
      url: new URL(url),
      addresses: [{ address: "1.1.1.1", family: 4 }],
    }),
  fetchPinned: (target: { url: URL }, init?: RequestInit) => fetch(target.url.href, init),
}));
afterEach(() => vi.unstubAllGlobals());
const root = "---\nname: review\ndescription: Review carefully\n---\nGuidance";
const response = (value: unknown) => new Response(JSON.stringify(value));
describe("bounded portable skill remote adapter", () => {
  it("validates the observed skills.sh search contract", () => {
    expect(
      parseDiscoveryResponse({
        query: "review",
        skills: [
          {
            id: "owner/repo/review",
            source: "owner/repo",
            skillId: "review",
            name: "Review",
            installs: 10,
          },
        ],
      }),
    ).toEqual({
      skills: [{ source: "owner/repo", skillId: "review", name: "Review", installs: 10 }],
      received: 1,
    });
    // An unaddressable row is dropped, keeping the rest of the page usable;
    // a scoped id (`react:components`) is addressable and stays.
    expect(
      parseDiscoveryResponse({
        skills: [
          { source: "https://evil.invalid", skillId: "review", name: "Review", installs: 10 },
          { source: "owner/repo", skillId: "react:components", name: "Parts", installs: 1 },
        ],
      }),
    ).toEqual({
      // The unaddressable row is dropped, but it still counted as received, so
      // a dropped row cannot hide the fact that a full page came back.
      skills: [{ source: "owner/repo", skillId: "react:components", name: "Parts", installs: 1 }],
      received: 2,
    });
    // Ampersands are real: `pdf-merge-&-split` is a published skill id.
    expect(
      parseDiscoveryResponse({
        skills: [
          { source: "o/r", skillId: "pdf-merge-&-split", name: "Split", installs: 3 },
          { source: "o/r", skillId: "..", name: "Dots", installs: 0 },
        ],
      }).skills.map((skill) => skill.skillId),
    ).toEqual(["pdf-merge-&-split"]);
    expect(() => parseDiscoveryResponse({ skills: "not-a-list" })).toThrow(
      new SkillRemoteError("Discovery returned an unsupported response."),
    );
    // A full page survives: the old cap of 50 refused one outright.
    expect(
      parseDiscoveryResponse({
        skills: Array.from({ length: 100 }, (_, index) => ({
          source: "owner/repo",
          skillId: `skill-${index}`,
          name: `Skill ${index}`,
          installs: index,
        })),
      }).skills,
    ).toHaveLength(100);
  });
  const notCanonical = "Use a canonical HTTPS URL without credentials, query or fragment.";
  const dotSegments = "Use a canonical URL without dot segments or encoded path separators.";
  it.each([
    ["http://github.com/a/b", notCanonical],
    ["https://user:pass@github.com/a/b", notCanonical],
    ["https://github.com/a/b?token=private", notCanonical],
    [
      "https://evil.invalid/a/b",
      "Only GitHub repositories and GitHub-backed skills.sh listings are supported.",
    ],
    ["https://github.com/a/b/tree/main/../SKILL.md", dotSegments],
    ["https://github.com/a/b/tree/main/%2e%2e/SKILL.md", dotSegments],
    ["https://github.com/a/b/tree/main/a%2fb", dotSegments],
    ["https://github.com/a/b/tree/main/a%5cb", dotSegments],
  ])("rejects unsupported URL %s", (url, message) => {
    expect(() => parseSkillUrl(url)).toThrow(new SkillRemoteError(message));
  });
  it("refuses redirected hosts before making another request and never sends credentials", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location: "https://evil.invalid/secret" } }),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(fetchSkillBytes("https://skills.sh/api/search", 1024)).rejects.toThrow(
      "Unsupported upstream host",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ signal: expect.any(AbortSignal) });
  });
  it("honors cancellation before starting an upstream request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      fetchSkillBytes("https://skills.sh/api/search", 1024, AbortSignal.abort()),
    ).rejects.toThrow(expect.objectContaining({ name: "AbortError" }));
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps binary supporting files, hashed over the fetched bytes", async () => {
    const sha = "c".repeat(40);
    const font = new Uint8Array([0, 1, 0, 0, 255]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (input.includes("/commits/")) return response({ sha });
        if (input.includes("/git/trees/"))
          return response({
            tree: ["SKILL.md", "fonts/brand.ttf"].map((path) => ({
              path,
              type: "blob",
              mode: "100644",
            })),
          });
        return new Response(input.endsWith("SKILL.md") ? root : font);
      }),
    );
    const review = await reviewGitHubSkill("test-binaries", "https://github.com/o/r");
    expect(review.selected?.package.files.find((file) => file.path === "fonts/brand.ttf")).toEqual({
      path: "fonts/brand.ttf",
      binary: { size: font.length, mediaType: "font/ttf", sha256: sha256Hex(font) },
      bytes: font,
    });
  });
  it("enforces actual streamed bytes without trusting content-length", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array(20))));
    await expect(fetchSkillBytes("https://skills.sh/api/search", 10)).rejects.toThrow("size limit");
  });
  it("pins all file reads to one commit and resolves the longest slash-bearing branch", async () => {
    const sha = "a".repeat(40);
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        urls.push(input);
        if (input.includes("matching-refs/heads/feature"))
          return response([{ ref: "refs/heads/feature" }, { ref: "refs/heads/feature/review" }]);
        if (input.includes("matching-refs/tags/")) return response([]);
        if (input.includes("/commits/")) return response({ sha });
        if (input.includes("/git/trees/"))
          return response({
            truncated: false,
            tree: [{ path: "SKILL.md", type: "blob", mode: "100644", size: root.length }],
          });
        if (input.startsWith(`https://raw.githubusercontent.com/o/r/${sha}/`))
          return new Response(root);
        throw new Error(`Unexpected request ${input}`);
      }),
    );
    const review = await reviewGitHubSkill(
      "test-branch",
      "https://github.com/o/r/tree/feature/review/skills",
    );
    expect(urls.some((url) => url.endsWith("/commits/feature%2Freview"))).toBe(true);
    // Only the package directory is read, not the whole repository tree.
    expect(urls.some((url) => url.includes(`/git/trees/${sha}%3Askills?`))).toBe(true);
    expect(review.selected?.source).toMatchObject({ commit: sha, path: "skills" });
    expect(review.selected?.package.files).toEqual([{ path: "SKILL.md", content: root }]);
    expect(
      urls.filter((url) => url.startsWith("https://raw.")).every((url) => url.includes(sha)),
    ).toBe(true);
  });
  it("finds a listed skill inside a large collection repository", async () => {
    const sha = "d".repeat(40);
    const read: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (input.includes("/commits/")) return response({ sha });
        if (input.includes("/git/trees/"))
          return response({
            // Well past the 40-root scan cap, as anthropics/skills already is.
            tree: [
              ...Array.from({ length: 60 }, (_, index) => `skills/other-${index}`),
              "skills/review",
            ].map((path) => ({ path: `${path}/SKILL.md`, type: "blob", mode: "100644" })),
          });
        read.push(input);
        return new Response(root);
      }),
    );
    const review = await reviewGitHubSkill("test-large", "https://skills.sh/o/r/review");
    expect(review.selected?.source).toMatchObject({ commit: sha, path: "skills/review" });
    // Only the named directory is read, not all sixty-one roots.
    expect(read.every((url) => url.includes("/skills/review/"))).toBe(true);
  });
  it("re-resolves a skills.sh import at the current commit when checking for updates", async () => {
    const updated = "---\nname: review\ndescription: Review carefully\n---\nNewer guidance";
    const sha = "e".repeat(40);
    const asked: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        asked.push(input);
        if (input.includes("/commits/")) return response({ sha });
        if (input.includes("/git/trees/"))
          return response({ tree: [{ path: "SKILL.md", type: "blob", mode: "100644" }] });
        return new Response(updated);
      }),
    );
    // The stored source of a skills.sh import: its listing URL and package path.
    const review = await reviewGitHubSkill(
      "test-update",
      "https://skills.sh/o/r/review",
      "skills/review",
    );
    expect(asked.some((url) => url.endsWith("/commits/HEAD"))).toBe(true);
    expect(review.selected?.source).toMatchObject({ commit: sha, path: "skills/review" });
    expect(review.selected?.package.files[0]).toMatchObject({ content: updated });
  });
  it("reads only the package subtree, so a huge repository is not downloaded", async () => {
    const sha = "f".repeat(40);
    const asked: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        asked.push(input);
        if (input.includes("matching-refs/heads/")) return response([{ ref: "refs/heads/main" }]);
        if (input.includes("matching-refs/tags/")) return response([]);
        if (input.includes("/commits/")) return response({ sha });
        if (input.includes("/git/trees/")) {
          // The whole-repository tree of a collection repo is megabytes of
          // JSON; refusing to serve it here proves it is never requested.
          if (!input.includes("%3A")) throw new Error("Whole-repository tree requested");
          return response({
            tree: [
              { path: "SKILL.md", type: "blob", mode: "100644" },
              { path: "scripts/convert.py", type: "blob", mode: "100644" },
            ],
          });
        }
        return new Response(input.endsWith(".py") ? "print('x')" : root);
      }),
    );
    const review = await reviewGitHubSkill(
      "test-subtree",
      "https://github.com/o/r/tree/main/skills/office",
    );
    expect(review.selected?.package.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "scripts/convert.py",
    ]);
    expect(asked.some((url) => url.includes(`${sha}%3Askills%2Foffice`))).toBe(true);
  });
  it("requires an explicit choice for duplicate package names", async () => {
    const sha = "b".repeat(40);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) =>
        input.includes("/commits/")
          ? response({ sha })
          : input.includes("/git/trees/")
            ? response({
                tree: ["one", "two"].map((path) => ({
                  path: `${path}/SKILL.md`,
                  type: "blob",
                  mode: "100644",
                })),
              })
            : new Response(root),
      ),
    );
    const review = await reviewGitHubSkill("test-duplicates", "https://skills.sh/o/r/review");
    expect(review.selected).toBeNull();
    expect(review.choices.map((choice) => choice.path)).toEqual(["one", "two"]);
  });
});
