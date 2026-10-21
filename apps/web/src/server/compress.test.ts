import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { compressedReply } from "./compress.ts";

const json = JSON.stringify({ messages: Array.from({ length: 200 }, (_, i) => ({ id: i })) });
const request = (encoding?: string) =>
  new Request("https://chat.test/_serverFn/x", {
    headers: encoding === undefined ? {} : { "accept-encoding": encoding },
  });
const reply = (body: string, type = "application/json") =>
  new Response(body, {
    status: 200,
    headers: { "content-type": type, "x-tss-serialized": "true" },
  });

describe("server function reply compression", () => {
  it("sends brotli when accepted, keeping status and headers", async () => {
    const out = await compressedReply(request("gzip, deflate, br, zstd"), reply(json));
    expect(out?.headers.get("content-encoding")).toBe("br");
    expect(out?.headers.get("x-tss-serialized")).toBe("true");
    expect(out?.headers.get("vary")).toBe("accept-encoding");
    const bytes = Buffer.from(await out!.arrayBuffer());
    expect(bytes.byteLength).toBeLessThan(json.length / 4);
    expect(brotliDecompressSync(bytes).toString()).toBe(json);
  });

  it("falls back to gzip", async () => {
    const out = await compressedReply(request("gzip"), reply(json));
    expect(out?.headers.get("content-encoding")).toBe("gzip");
    expect(gunzipSync(Buffer.from(await out!.arrayBuffer())).toString()).toBe(json);
  });

  it("leaves a client that accepts neither alone", async () => {
    expect(await compressedReply(request(), reply(json))).toBeNull();
    expect(await compressedReply(request("identity"), reply(json))).toBeNull();
  });

  it("honours a coding the client refuses with q=0", async () => {
    const out = await compressedReply(request("br;q=0, gzip"), reply(json));
    expect(out?.headers.get("content-encoding")).toBe("gzip");
  });

  it("never touches a framed reply, which streams records as they settle", async () => {
    expect(
      await compressedReply(request("br"), reply(json, "application/x-tss-framed; v=1")),
    ).toBeNull();
  });

  it("sends a small reply as it is, still varying by encoding", async () => {
    const out = await compressedReply(request("br"), reply('{"ok":true}'));
    expect(out?.headers.get("content-encoding")).toBeNull();
    expect(out?.headers.get("vary")).toBe("accept-encoding");
    expect(await out!.text()).toBe('{"ok":true}');
  });
});
