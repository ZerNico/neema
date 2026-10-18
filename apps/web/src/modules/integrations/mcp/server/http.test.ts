import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scopedFetch } from "./http.ts";

let server: Server;
let base: URL;
beforeAll(async () => {
  // Fifteen megabytes per answer: one fits the budget, two do not.
  const body = Buffer.alloc(15 * 1024 * 1024, 97);
  server = createServer((_request, response) => response.end(body));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

describe("the fetch one piece of work uses", () => {
  it("counts every response against one budget, so many pages cannot add up past it", async () => {
    const fetch = scopedFetch(base, { sameOriginOnly: true });
    expect((await (await fetch(base)).arrayBuffer()).byteLength).toBe(15 * 1024 * 1024);
    await expect((await fetch(base)).arrayBuffer()).rejects.toThrow("The response was too large.");
    // Another piece of work starts its own count.
    const next = scopedFetch(base, { sameOriginOnly: true });
    expect((await (await next(base)).arrayBuffer()).byteLength).toBe(15 * 1024 * 1024);
  });
});
