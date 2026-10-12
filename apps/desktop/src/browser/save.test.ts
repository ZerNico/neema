import { describe, expect, it, vi } from "vitest";
import { fileNameFor, saveFiles } from "./save.ts";

describe("saving files from a page", () => {
  it.each([undefined, "1"])(
    "cancels receiving at the real limit with declared length %s",
    async (declared) => {
      const cancel = vi.fn();
      const land = vi.fn(async () => "/work/x");
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(4));
        },
        cancel,
      });
      const result = await saveFiles(
        ["https://a.test/x"],
        async () =>
          new Response(body, {
            headers: declared ? { "content-length": declared } : {},
          }),
        land,
        { limit: 8 },
      );
      expect(result).toEqual([{ url: "https://a.test/x", error: "It is too large to save." }]);
      expect(cancel).toHaveBeenCalledOnce();
      expect(land).not.toHaveBeenCalled();
    },
  );

  it("accepts the exact byte limit", async () => {
    const land = vi.fn(async (_name: string, _bytes: Uint8Array) => "/work/x");
    expect(
      await saveFiles(["https://a.test/x"], async () => new Response(new Uint8Array(8)), land, {
        limit: 8,
      }),
    ).toEqual([{ url: "https://a.test/x", path: "/work/x" }]);
    expect(land.mock.calls[0]?.[1]).toEqual(new Uint8Array(8));
  });

  it("gates redirects before contact, and follows relative allowed redirects", async () => {
    const fetch = vi.fn(async (url: string) =>
      url.endsWith("/start")
        ? new Response(null, { status: 302, headers: { location: "/next" } })
        : new Response(null, { status: 307, headers: { location: "https://b.test/file" } }),
    );
    const land = vi.fn(async () => "/work/x");
    const result = await saveFiles(["https://a.test/start"], fetch, land, {
      allowed: (url) => new URL(url).hostname === "a.test",
    });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://a.test/start",
      "https://a.test/next",
    ]);
    expect(result).toEqual([
      {
        url: "https://a.test/start",
        blocked: true,
        blockedUrl: "https://b.test/file",
        error: "That site is not allowed in this chat.",
      },
    ]);
    expect(land).not.toHaveBeenCalled();
  });

  it.each([undefined, "file:///tmp/x", "http://["])(
    "refuses malformed redirect %s",
    async (location) => {
      const fetch = vi.fn(
        async () => new Response(null, { status: 302, headers: location ? { location } : {} }),
      );
      const result = await saveFiles(["https://a.test/x"], fetch, async () => "/work/x");
      expect(result[0]).toHaveProperty("error");
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("bounds redirect cycles", async () => {
    const fetch = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "/x" } }),
    );
    expect(await saveFiles(["https://a.test/x"], fetch, async () => "/work/x")).toEqual([
      { url: "https://a.test/x", error: "Too many redirects." },
    ]);
    expect(fetch).toHaveBeenCalledTimes(9);
  });

  it("cancels a stalled fetch, later workers and a late response body", async () => {
    const controller = new AbortController();
    const response = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    const fetch = vi.fn(() => {
      started.resolve();
      return response.promise;
    });
    const land = vi.fn(async () => "/work/x");
    const cancel = vi.fn();
    const pending = saveFiles(
      Array.from({ length: 6 }, (_, i) => `https://a.test/${i}`),
      fetch,
      land,
      { signal: controller.signal },
    );
    await started.promise;
    controller.abort();
    await pending;
    response.resolve(new Response(new ReadableStream({ cancel })));
    await response.promise;
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(land).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
  });

  it("names a file by its address, typed by what the server sent", () => {
    expect(fileNameFor("https://a.test/img/Alan%20Turing.jpg?w=200", "image/jpeg", 0)).toBe(
      "Alan Turing.jpg",
    );
    expect(fileNameFor("https://a.test/i/0dfaf23551c399c6", "image/png; q=1", 0)).toBe(
      "0dfaf23551c399c6.png",
    );
    expect(fileNameFor("https://a.test/", null, 2)).toBe("file-3");
    expect(fileNameFor("https://a.test/..%2F..%2Fetc%2Fpasswd", null, 0)).not.toContain("/");
  });

  it("saves each address, a few at a time, and says why one could not be saved", async () => {
    const landed: string[] = [];
    let open = 0;
    let most = 0;
    const outcomes = await saveFiles(
      ["https://a.test/1.png", "https://a.test/missing.png", "https://a.test/2.png"],
      async (url) => {
        open++;
        most = Math.max(most, open);
        await Promise.resolve();
        open--;
        return url.includes("missing")
          ? new Response(null, { status: 404 })
          : new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
      },
      async (name) => {
        landed.push(name);
        return `/work/${name}`;
      },
    );
    expect(outcomes).toEqual([
      { url: "https://a.test/1.png", path: "/work/1.png" },
      { url: "https://a.test/missing.png", error: "The site answered 404." },
      { url: "https://a.test/2.png", path: "/work/2.png" },
    ]);
    expect(landed).toEqual(["1.png", "2.png"]);
    expect(most).toBeLessThanOrEqual(4);
  });
});
