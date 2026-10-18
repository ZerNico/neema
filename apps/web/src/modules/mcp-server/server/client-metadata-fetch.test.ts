import { describe, expect, it, vi } from "vitest";
import { fetchClientMetadata } from "./client-metadata-fetch.ts";

// The lookup and the pinned connection are the network; the checks around them are real.
const { lookupMock, fetchPinnedMock } = vi.hoisted(() => ({
  lookupMock: vi.fn<() => Promise<Array<{ address: string; family: number }>>>(),
  fetchPinnedMock: vi.fn<(target: unknown, init: RequestInit) => Promise<Response>>(),
}));
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));
vi.mock("~/modules/tools/server/url-safety.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/tools/server/url-safety.ts")>()),
  fetchPinned: fetchPinnedMock,
}));

const METADATA_URL = "https://client.example/metadata.json";
const publicHost = () => lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

/** A body sent in pieces, with no length declared up front. */
const streamed = (bytes: number) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let sent = 0; sent < bytes; sent += 16 * 1024)
          controller.enqueue(new Uint8Array(Math.min(16 * 1024, bytes - sent)));
        controller.close();
      },
    }),
  );

describe("fetchClientMetadata", () => {
  it("refuses anything but HTTPS before looking the host up", async () => {
    await expect(fetchClientMetadata("http://client.example/metadata.json")).rejects.toThrow(
      "Client metadata must be served over HTTPS.",
    );
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("refuses a host that resolves to a private address", async () => {
    lookupMock.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    await expect(fetchClientMetadata(METADATA_URL)).rejects.toMatchObject({ _tag: "UnsafeUrl" });
    expect(fetchPinnedMock).not.toHaveBeenCalled();
  });

  it("refuses a declared length over 64 KiB without reading it", async () => {
    publicHost();
    const cancel = vi.fn();
    fetchPinnedMock.mockResolvedValue(
      new Response(new ReadableStream({ cancel }), {
        headers: { "content-length": String(64 * 1024 + 1) },
      }),
    );
    await expect(fetchClientMetadata(METADATA_URL)).rejects.toThrow(
      "Client metadata is too large.",
    );
    expect(cancel).toHaveBeenCalled();
  });

  it("refuses a body that streams past 64 KiB", async () => {
    publicHost();
    fetchPinnedMock.mockResolvedValue(streamed(64 * 1024 + 1));
    await expect(fetchClientMetadata(METADATA_URL)).rejects.toThrow(
      "Client metadata is too large.",
    );
  });

  it("hands back a document within the bound, its status and headers kept", async () => {
    publicHost();
    fetchPinnedMock.mockResolvedValue(
      new Response('{"client_id":"x"}', {
        status: 200,
        headers: { "content-type": "application/json", etag: '"v1"' },
      }),
    );
    const response = await fetchClientMetadata(METADATA_URL);
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"v1"');
    expect(await response.json()).toEqual({ client_id: "x" });
  });

  it("gives the connection one signal that the caller's abort ends too", async () => {
    publicHost();
    fetchPinnedMock.mockResolvedValue(new Response("{}"));
    const caller = new AbortController();
    await fetchClientMetadata(METADATA_URL, { signal: caller.signal });
    const signal = fetchPinnedMock.mock.calls.at(-1)![1].signal!;
    expect(signal.aborted).toBe(false);
    caller.abort();
    expect(signal.aborted).toBe(true);
  });
});
