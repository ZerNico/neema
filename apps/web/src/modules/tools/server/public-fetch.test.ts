import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { fetchPinned } from "./url-safety.ts";
import { fetchPublic } from "./public-fetch.ts";

// Only the connection is replaced; every address check is the real one.
vi.mock("./url-safety.ts", async (original) => ({
  ...(await original<typeof import("./url-safety.ts")>()),
  fetchPinned: vi.fn(),
}));
const connect = vi.mocked(fetchPinned);

const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });
const fetchFrom = (url: string) =>
  Effect.runPromise(Effect.result(fetchPublic(url, { timeoutMs: 1000, redirects: 3 })));

describe("public fetch", () => {
  it.each(["http://127.0.0.1/admin", "http://169.254.169.254/latest/meta-data/", "http://[::1]/"])(
    "refuses a redirect to %s without connecting to it",
    async (location) => {
      connect.mockReset().mockResolvedValueOnce(redirect(location));
      const result = await fetchFrom("http://93.184.215.14/");
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "PublicFetchFailed" } });
      expect(connect).toHaveBeenCalledTimes(1);
    },
  );

  it("fails one fetch, not the caller, on a redirect that is not a URL", async () => {
    connect.mockReset().mockResolvedValueOnce(redirect("http://[not-a-host/"));
    const result = await fetchFrom("http://93.184.215.14/");
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { reason: "redirect to an invalid location (302)" },
    });
  });

  it("follows a public redirect and answers with where it landed", async () => {
    connect
      .mockReset()
      .mockResolvedValueOnce(redirect("/moved"))
      .mockResolvedValueOnce(new Response("ok"));
    const result = await fetchFrom("http://93.184.215.14/start");
    expect(result).toMatchObject({
      _tag: "Success",
      success: { url: "http://93.184.215.14/moved" },
    });
    expect(connect.mock.calls[1]?.[0].url.href).toBe("http://93.184.215.14/moved");
  });

  it("stops after the allowed number of redirects", async () => {
    connect.mockReset().mockImplementation(async () => redirect("/again"));
    const result = await fetchFrom("http://93.184.215.14/");
    expect(result).toMatchObject({ failure: { reason: "too many redirects" } });
    expect(connect).toHaveBeenCalledTimes(4);
  });
});
