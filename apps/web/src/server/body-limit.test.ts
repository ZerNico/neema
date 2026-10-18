import { describe, expect, it } from "vitest";
import { MAX_SERVER_FN_BODY, oversizedBody } from "./body-limit.ts";

const post = (headers: Record<string, string>) =>
  new Request("https://chat.test/_serverFn/x", { method: "POST", body: "{}", headers });

describe("server function body limit", () => {
  it("lets a body within the limit through", () => {
    expect(oversizedBody(post({ "content-length": String(MAX_SERVER_FN_BODY) }))).toBeNull();
  });

  it("refuses a declared length over the limit before reading it", () => {
    expect(oversizedBody(post({ "content-length": String(MAX_SERVER_FN_BODY + 1) }))?.status).toBe(
      413,
    );
    expect(oversizedBody(post({ "content-length": "lots" }))?.status).toBe(413);
  });

  it("asks for a length when a body declares none", () => {
    const streamed = new Request("https://chat.test/_serverFn/x", {
      method: "POST",
      body: new ReadableStream(),
      duplex: "half",
    } as RequestInit);
    expect(oversizedBody(streamed)?.status).toBe(411);
  });

  it("ignores a request without a body", () => {
    expect(oversizedBody(new Request("https://chat.test/_serverFn/x"))).toBeNull();
  });
});
