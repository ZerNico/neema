import { describe, expect, it } from "vitest";
import { refusalsReject } from "./refusals.ts";

type Client = (input: { next: () => Promise<{ result: unknown }> }) => Promise<unknown>;
// Called with only what this middleware reads; the real context has more.
const client: Client = (input) => Reflect.apply(refusalsReject.options.client!, undefined, [input]);
const settle = (result: unknown) => client({ next: async () => ({ result }) });

describe("server function refusals", () => {
  it("rejects with the body of a refused call", async () => {
    await expect(settle(new Response("Unauthorized", { status: 401 }))).rejects.toThrow(
      /^Unauthorized$/,
    );
  });

  it("passes results through, an OK Response included", async () => {
    await expect(settle({ id: "g1" })).resolves.toMatchObject({ result: { id: "g1" } });
    const ok = new Response("bytes");
    await expect(settle(ok)).resolves.toMatchObject({ result: ok });
  });
});
