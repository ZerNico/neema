import { verbatim } from "~/i18n/localized.ts";
import { Effect } from "effect";
import type { IntegrationService } from "~/modules/integrations/server/service.ts";
import type { SyncBus } from "~/modules/sync/server/bus.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { oauthCookies } from "~/modules/integrations/server/oauth.ts";
import { Route as Callback } from "./callback.ts";
import { Route as Connect } from "./connect.ts";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  begin: vi.fn(),
  complete: vi.fn(),
  publish: vi.fn(),
}));
vi.mock("~/modules/auth/server/auth.ts", () => ({ sessionFromHeaders: mocks.session }));
vi.mock("~/modules/integrations/server/functions.ts", () => ({
  appOrigin: (request: Request) => new URL(request.url).origin,
}));
// The service is the one fake: the routes' own session, cookie and redirect handling is real.
vi.mock("~/server/runtime.ts", async () => {
  const { Layer } = await import("effect");
  const { IntegrationService } = await import("~/modules/integrations/server/service.ts");
  const { SyncBus: Bus } = await import("~/modules/sync/server/bus.ts");
  const service = Layer.mergeAll(
    Layer.mock(IntegrationService, {
      beginOAuth: (...args) => mocks.begin(...args),
      completeOAuth: (...args) => mocks.complete(...args),
    }),
    Layer.mock(Bus, {
      publish: (...args) => Effect.sync(() => mocks.publish(...args)),
    }),
  );
  return {
    runtime: {
      runPromise: <A, E>(effect: Effect.Effect<A, E, IntegrationService | SyncBus>) =>
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
  mocks.session.mockResolvedValue({
    approved: true,
    session: { user: { id: "person" }, session: {} },
  });
  mocks.begin.mockReturnValue(
    Effect.succeed({ url: "https://wiki.example/authorize?x=1", state: "s-123" }),
  );
  mocks.complete.mockReturnValue(Effect.succeed({ returnTo: null }));
});

const cookies = oauthCookies("s-123");

describe("starting an OAuth connection", () => {
  it("binds the state to a cookie only the callback receives, never readable by script", async () => {
    const response = await call(
      Connect,
      "https://chat.example/api/integrations/wiki/connect?as=person",
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://wiki.example/authorize?x=1");
    expect(response.headers.getSetCookie()).toEqual([
      `${cookies.state}=s-123; Path=/api/integrations/wiki/callback; HttpOnly; SameSite=Lax; Max-Age=600; Secure`,
    ]);
  });

  it("names each sign-in's cookies by its state, so two at once keep their own", () => {
    expect(oauthCookies("s-123").state).not.toBe(oauthCookies("s-456").state);
    expect(cookies.state).toMatch(/^integration_oauth_[A-Za-z0-9_-]{16}$/);
  });

  it("remembers where to show the outcome, beside the state", async () => {
    const response = await call(
      Connect,
      "https://chat.example/api/integrations/wiki/connect?returnTo=%2Fintegrations%2Fconnected%3Fattempt%3Da-1&as=person",
    );
    expect(response.headers.getSetCookie()[1]).toBe(
      `${cookies.back}=%2Fintegrations%2Fconnected%3Fattempt%3Da-1; Path=/api/integrations/wiki/callback; HttpOnly; SameSite=Lax; Max-Age=600; Secure`,
    );
  });

  it("leaves Secure off only for a plain http origin", async () => {
    const response = await call(
      Connect,
      "http://localhost:3000/api/integrations/wiki/connect?as=person",
    );
    expect(response.headers.get("set-cookie")).not.toContain("Secure");
  });

  it("sends a browser that is not signed in to sign in, starting nothing", async () => {
    mocks.session.mockResolvedValue(null);
    const response = await call(
      Connect,
      "https://chat.example/api/integrations/wiki/connect?as=person",
    );
    expect(response.headers.get("location")).toBe(
      "https://chat.example/login?redirect=%2Fapi%2Fintegrations%2Fwiki%2Fconnect%3Fas%3Dperson",
    );
    expect(mocks.begin).not.toHaveBeenCalled();
  });

  it("keeps only a path on this app to return to", async () => {
    await call(
      Connect,
      "https://chat.example/api/integrations/wiki/connect?returnTo=https%3A%2F%2Fevil.example%2F&as=person",
    );
    expect(mocks.begin).toHaveBeenCalledWith(
      "person",
      "wiki",
      "https://chat.example",
      undefined,
      undefined,
    );
    await call(
      Connect,
      "https://chat.example/api/integrations/wiki/connect?returnTo=%2Fchat%2Fc1&as=person",
    );
    expect(mocks.begin).toHaveBeenLastCalledWith(
      "person",
      "wiki",
      "https://chat.example",
      "/chat/c1",
      undefined,
    );
  });

  it("starts nothing in a browser signed in here as someone other than who asked", async () => {
    const response = await call(
      Connect,
      "https://chat.example/api/integrations/wiki/connect?as=someone-else&returnTo=%2Fintegrations%2Fconnected%3Fattempt%3Da-1",
    );
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toMatch(
      /^\/integrations\/connected\?attempt=a-1&error=This\+browser\+is\+signed\+in/,
    );
    await call(Connect, "https://chat.example/api/integrations/wiki/connect?as=person");
    expect(mocks.begin).toHaveBeenCalled();
  });

  it("starts nothing for an admin acting as the person", async () => {
    mocks.session.mockResolvedValue({
      approved: true,
      session: { user: { id: "person" }, session: { impersonatedBy: "admin" } },
    });
    const response = await call(
      Connect,
      "https://chat.example/api/integrations/wiki/connect?as=person&returnTo=%2Fintegrations%2Fconnected%3Fattempt%3Da-1",
    );
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toMatch(
      /^\/integrations\/connected\?attempt=a-1&error=Stop\+impersonating/,
    );
  });

  it("starts nothing from a link that names nobody, and tells the app why", async () => {
    const response = await call(
      Connect,
      "https://chat.example/api/integrations/wiki/connect?returnTo=%2Fintegrations%2Fconnected%3Fattempt%3Da-1",
    );
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe(
      "/integrations/connected?attempt=a-1&error=Start+connecting+again+from+the+app.",
    );
    // The system browser cannot reach the dialog; the app hears it this way.
    expect(mocks.publish).toHaveBeenCalledWith("person", {
      type: "integration.signIn.failed",
      attempt: "a-1",
      error: "Start connecting again from the app.",
    });
  });

  it("passes on which account a reconnect is for, for the service to check", async () => {
    await call(
      Connect,
      "https://chat.example/api/integrations/wiki/connect?account=acc-1&as=person",
    );
    expect(mocks.begin).toHaveBeenLastCalledWith(
      "person",
      "wiki",
      "https://chat.example",
      undefined,
      "acc-1",
    );
  });
});

describe("finishing an OAuth connection", () => {
  const callback = "https://chat.example/api/integrations/wiki/callback?code=c-1&state=s-123";

  it("hands the service the state from its own cookie among others, and clears it", async () => {
    const response = await call(
      Callback,
      callback,
      `theme=dark; ${cookies.state}=s-123==; ${oauthCookies("s-456").state}=other; other=1`,
    );
    expect(mocks.complete).toHaveBeenCalledWith("person", "wiki", {
      code: "c-1",
      state: "s-123",
      cookieState: "s-123==",
      iss: null,
    });
    expect(response.headers.get("location")).toBe("/settings/integrations/wiki?connected=1");
    expect(response.headers.getSetCookie()).toEqual([
      `${cookies.state}=; Path=/api/integrations/wiki/callback; HttpOnly; SameSite=Lax; Max-Age=0; Secure`,
      `${cookies.back}=; Path=/api/integrations/wiki/callback; HttpOnly; SameSite=Lax; Max-Age=0; Secure`,
    ]);
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
    const response = await call(Callback, callback, `${cookies.state}=s-123`);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toContain("error=");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("reports the service's refusal back on the settings page", async () => {
    mocks.complete.mockReturnValue(Effect.fail({ reason: verbatim("The sign-in has expired.") }));
    const response = await call(Callback, callback, `${cookies.state}=s-123`);
    expect(response.headers.get("location")).toBe(
      "/settings/integrations/wiki?error=The+sign-in+has+expired.",
    );
  });

  it("finds the one sign-in under way when the service refuses without its state", async () => {
    const back = `${cookies.back}=${encodeURIComponent("/integrations/connected?attempt=a-1")}`;
    const response = await call(
      Callback,
      "https://chat.example/api/integrations/wiki/callback?error=access_denied",
      `${cookies.state}=s-123; ${back}`,
    );
    expect(response.headers.get("location")).toBe(
      "/integrations/connected?attempt=a-1&error=The+connection+was+cancelled.",
    );
    expect(response.headers.getSetCookie()).toHaveLength(2);
    expect(mocks.publish).toHaveBeenCalledWith("person", {
      type: "integration.signIn.failed",
      attempt: "a-1",
      error: "The connection was cancelled.",
    });
  });

  it("answers a garbled landing cookie with Settings, not a crash", async () => {
    mocks.complete.mockReturnValue(Effect.fail({ reason: verbatim("The sign-in has expired.") }));
    const response = await call(
      Callback,
      callback,
      `${cookies.state}=s-123; ${cookies.back}=%E0%A4%A`,
    );
    expect(response.headers.get("location")).toBe(
      "/settings/integrations/wiki?error=The+sign-in+has+expired.",
    );
  });

  it("shows the outcome, good or bad, on the page the sign-in asked for", async () => {
    const back = `${cookies.back}=${encodeURIComponent("/integrations/connected?attempt=a-1")}`;
    mocks.complete.mockReturnValue(
      Effect.fail({ reason: verbatim("Atlassian refused this site.") }),
    );
    const refused = await call(Callback, callback, `${cookies.state}=s-123; ${back}`);
    expect(refused.headers.get("location")).toBe(
      "/integrations/connected?attempt=a-1&error=Atlassian+refused+this+site.",
    );
    // A page off this app is never a landing, whatever the cookie says.
    const elsewhere = await call(
      Callback,
      callback,
      `${cookies.state}=s-123; ${cookies.back}=${encodeURIComponent("https://evil.example/")}`,
    );
    expect(elsewhere.headers.get("location")).toBe(
      "/settings/integrations/wiki?error=Atlassian+refused+this+site.",
    );
  });
});
