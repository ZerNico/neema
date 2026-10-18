import { Effect } from "effect";
import type { IntegrationService } from "~/modules/integrations/server/service.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route as Callback } from "./callback.ts";
import { Route as Connect } from "./connect.ts";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  begin: vi.fn(),
  complete: vi.fn(),
}));
vi.mock("~/modules/auth/server/auth.ts", () => ({ sessionFromHeaders: mocks.session }));
vi.mock("~/modules/integrations/server/functions.ts", () => ({
  appOrigin: (request: Request) => new URL(request.url).origin,
}));
// The service is the one fake: the routes' own session, cookie and redirect handling is real.
vi.mock("~/server/runtime.ts", async () => {
  const { Layer } = await import("effect");
  const { IntegrationService } = await import("~/modules/integrations/server/service.ts");
  const service = Layer.mock(IntegrationService, {
    beginOAuth: (...args) => mocks.begin(...args),
    completeOAuth: (...args) => mocks.complete(...args),
  });
  return {
    runtime: {
      runPromise: <A, E>(effect: Effect.Effect<A, E, IntegrationService>) =>
        Effect.runPromise(Effect.provide(effect, service)),
    },
  };
});

const handlerOf = (route: typeof Connect | typeof Callback): unknown => {
  const handlers = route.options.server?.handlers;
  return handlers && typeof handlers !== "function" ? handlers.GET : undefined;
};

const call = async (route: typeof Connect | typeof Callback, url: string, cookie?: string) => {
  const handler = handlerOf(route);
  if (typeof handler !== "function") throw new Error("Missing GET handler");
  const response: unknown = await handler({
    request: new Request(url, cookie ? { headers: { cookie } } : {}),
    pathname: new URL(url).pathname,
    params: { integrationId: "wiki" },
    context: { cspNonce: "nonce" },
    next: () => {
      throw new Error("The handler must answer itself");
    },
  });
  if (!(response instanceof Response)) throw new Error("Missing response");
  return response;
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ approved: true, session: { user: { id: "person" } } });
  mocks.begin.mockReturnValue(
    Effect.succeed({ url: "https://wiki.example/authorize?x=1", state: "s-123" }),
  );
  mocks.complete.mockReturnValue(Effect.succeed({ returnTo: null }));
});

describe("starting an OAuth connection", () => {
  it("binds the state to a cookie only the callback receives, never readable by script", async () => {
    const response = await call(Connect, "https://chat.example/api/integrations/wiki/connect");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://wiki.example/authorize?x=1");
    expect(response.headers.get("set-cookie")).toBe(
      "integration_oauth_state=s-123; Path=/api/integrations/wiki/callback; HttpOnly; SameSite=Lax; Max-Age=600; Secure",
    );
  });

  it("leaves Secure off only for a plain http origin", async () => {
    const response = await call(Connect, "http://localhost:3000/api/integrations/wiki/connect");
    expect(response.headers.get("set-cookie")).not.toContain("Secure");
  });

  it("sends a browser that is not signed in to sign in, starting nothing", async () => {
    mocks.session.mockResolvedValue(null);
    const response = await call(Connect, "https://chat.example/api/integrations/wiki/connect");
    expect(response.headers.get("location")).toBe(
      "https://chat.example/login?redirect=%2Fapi%2Fintegrations%2Fwiki%2Fconnect",
    );
    expect(mocks.begin).not.toHaveBeenCalled();
  });

  it("keeps only a path on this app to return to", async () => {
    await call(
      Connect,
      "https://chat.example/api/integrations/wiki/connect?returnTo=https%3A%2F%2Fevil.example%2F",
    );
    expect(mocks.begin).toHaveBeenCalledWith("person", "wiki", "https://chat.example", undefined);
    await call(Connect, "https://chat.example/api/integrations/wiki/connect?returnTo=%2Fchat%2Fc1");
    expect(mocks.begin).toHaveBeenLastCalledWith(
      "person",
      "wiki",
      "https://chat.example",
      "/chat/c1",
    );
  });
});

describe("finishing an OAuth connection", () => {
  const callback = "https://chat.example/api/integrations/wiki/callback?code=c-1&state=s-123";

  it("hands the service the state from its own cookie among others, and clears it", async () => {
    const response = await call(
      Callback,
      callback,
      "theme=dark; integration_oauth_state=s-123==; other=1",
    );
    expect(mocks.complete).toHaveBeenCalledWith("person", "wiki", {
      code: "c-1",
      state: "s-123",
      cookieState: "s-123==",
      iss: null,
    });
    expect(response.headers.get("location")).toBe("/settings/integrations/wiki?connected=1");
    expect(response.headers.get("set-cookie")).toBe(
      "integration_oauth_state=; Path=/api/integrations/wiki/callback; HttpOnly; SameSite=Lax; Max-Age=0",
    );
  });

  it("passes no cookie state when the browser sent none", async () => {
    await call(Callback, callback, "theme=dark");
    expect(mocks.complete).toHaveBeenCalledWith(
      "person",
      "wiki",
      expect.objectContaining({ cookieState: null }),
    );
  });

  it("refuses a browser signed in as nobody without spending the code", async () => {
    mocks.session.mockResolvedValue(null);
    const response = await call(Callback, callback, "integration_oauth_state=s-123");
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toContain("error=");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("reports the service's refusal back on the settings page", async () => {
    mocks.complete.mockReturnValue(Effect.fail({ reason: "The sign-in has expired." }));
    const response = await call(Callback, callback, "integration_oauth_state=s-123");
    expect(response.headers.get("location")).toBe(
      "/settings/integrations/wiki?error=The+sign-in+has+expired.",
    );
  });
});
