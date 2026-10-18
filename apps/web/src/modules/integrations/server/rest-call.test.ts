import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { restCall } from "./rest-call.ts";

afterEach(() => vi.unstubAllGlobals());

const call = (retry: (status: number) => boolean) =>
  Effect.runPromise(
    Effect.result(
      restCall<{ ok: boolean }>({
        service: "Outline",
        integrationId: "outline",
        credential: { kind: "none" },
        url: "https://docs.example.com/api/documents.info",
        method: "POST",
        authorization: "Bearer t",
        body: {},
        retry,
        reason: (status) => `Outline answered ${status}.`,
      }),
    ),
  );

describe("restCall", () => {
  it("lets a throttled answer go and asks once more", async () => {
    const cancelled = vi.fn();
    const throttled = new Response(new ReadableStream({ cancel: cancelled }), {
      status: 429,
      headers: { "retry-after": "0" },
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(throttled)
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    expect(await call((status) => status === 429)).toMatchObject({
      _tag: "Success",
      success: { ok: true },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("does not retry what the service may have processed", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("busy", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    expect(await call((status) => status === 429)).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "IntegrationRequestFailed", status: 503 },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("says the sign-in failed on a 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    expect(await call(() => false)).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "IntegrationAuthFailed", integrationId: "outline" },
    });
  });
});
