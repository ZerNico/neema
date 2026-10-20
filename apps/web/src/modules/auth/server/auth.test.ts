import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthOAuthProvider } from "./config.ts";

const mocks = vi.hoisted(() => ({
  listForAuth: vi.fn<() => Promise<AuthOAuthProvider[]>>(),
  createAppAuth: vi.fn<(options: { oauthProviders: readonly AuthOAuthProvider[] }) => unknown>(),
}));

vi.mock("~/db/client.ts", () => ({ getDb: () => ({}) }));
// The holder reads providers through the application runtime; the query itself
// is exercised against real Postgres in tests/integration/oauth-providers.
vi.mock("~/server/runtime.ts", () => ({ runtime: { runPromise: () => mocks.listForAuth() } }));
vi.mock("./config.ts", () => ({ createAppAuth: mocks.createAppAuth }));

const load = () => import("./auth.ts");

const provider = (id: string): AuthOAuthProvider => ({
  kind: "builtin",
  id,
  trustEmails: false,
  clientId: `${id}-client`,
  clientSecret: `${id}-secret`,
});

/** What each build was handed, in build order. */
const builtWith = () => mocks.createAppAuth.mock.calls.map(([options]) => options.oauthProviders);

beforeEach(() => {
  vi.resetModules();
  mocks.listForAuth.mockReset().mockResolvedValue([]);
  mocks.createAppAuth.mockReset().mockImplementation((options) => ({ ...options }));
});

describe("the cached auth instance", () => {
  it("builds once and serves the same instance until it is invalidated", async () => {
    const { currentAuth } = await load();

    const [first, second] = await Promise.all([currentAuth(), currentAuth()]);

    expect(first).toBe(second);
    expect(mocks.createAppAuth).toHaveBeenCalledTimes(1);
  });

  it("serves the new provider configuration after an admin write", async () => {
    const { currentAuth, invalidateAuth } = await load();
    mocks.listForAuth.mockResolvedValue([provider("google")]);
    const before = await currentAuth();

    mocks.listForAuth.mockResolvedValue([provider("google"), provider("github")]);
    expect(await currentAuth()).toBe(before);

    invalidateAuth();
    // Better Auth resolves its context once per instance, so applying the new
    // configuration means a new instance, not a mutated one.
    expect(await currentAuth()).not.toBe(before);
    expect(builtWith().map((providers) => providers.length)).toEqual([1, 2]);
  });

  it("does not cache a failed build", async () => {
    const { currentAuth } = await load();
    mocks.listForAuth.mockRejectedValueOnce(new Error("database is down"));

    await expect(currentAuth()).rejects.toThrow("database is down");

    mocks.listForAuth.mockResolvedValue([provider("google")]);
    await currentAuth();
    expect(builtWith()).toEqual([[provider("google")]]);
  });
});
