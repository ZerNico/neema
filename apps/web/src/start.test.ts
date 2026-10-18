import { describe, expect, it } from "vitest";
import { startInstance } from "./start.ts";

/** The first request middleware, run on its own with a `next` that answers 200. */
const csrf = async (headers: Record<string, string>, handlerType: "serverFn" | "router") => {
  const [first] = (await startInstance.getOptions()).requestMiddleware ?? [];
  const server = first?.options.server;
  if (!server) throw new Error("The CSRF middleware is gone from the start instance");
  // Only the fields the CSRF check reads; the rest of the context is the framework's.
  const response: unknown = await server({
    request: new Request("https://chat.example/_serverFn/abc", { method: "POST", headers }),
    handlerType,
    next: async () => new Response("ran", { status: 200 }),
  } as never);
  if (!(response instanceof Response)) throw new Error("The CSRF middleware answered no response");
  return response.status;
};

describe("server function CSRF check", () => {
  it("runs a same-origin call and refuses a cross-site or unmarked one", async () => {
    expect(await csrf({ "sec-fetch-site": "same-origin" }, "serverFn")).toBe(200);
    expect(await csrf({ "sec-fetch-site": "cross-site" }, "serverFn")).toBe(403);
    expect(await csrf({ origin: "https://evil.example" }, "serverFn")).toBe(403);
    expect(await csrf({}, "serverFn")).toBe(403);
  });

  it("leaves route requests to their own checks", async () => {
    expect(await csrf({ "sec-fetch-site": "cross-site" }, "router")).toBe(200);
  });
});
