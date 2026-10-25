import { beforeEach, describe, expect, it, vi } from "vitest";
import { IMPERSONATING_BODY, UNAUTHENTICATED_BODY } from "../identity.ts";
import { NOT_APPROVED_BODY } from "../signup.ts";
import { sessionFromHeaders } from "./auth.ts";
import { requireAdmin, requireOwnSession, requireSession } from "./middleware.ts";

vi.mock("./auth.ts", () => ({ sessionFromHeaders: vi.fn() }));
// Run the registered middleware directly; the policy under test is the real one.
vi.mock("@tanstack/react-start", () => ({
  createMiddleware: () => ({ server: (handler: unknown) => handler }),
}));

const source = vi.mocked(sessionFromHeaders);

const held = (role: string, approved: boolean, impersonatedBy?: string) => ({
  session: { user: { id: "u1", role }, session: impersonatedBy ? { impersonatedBy } : {} },
  approved,
});

type Guard = (input: {
  request: Request;
  next: (arg: { context: { session: unknown } }) => Promise<unknown>;
}) => Promise<unknown>;

const run = (guard: unknown) => {
  const next = vi.fn(async (arg: { context: { session: unknown } }) => arg);
  return {
    next,
    result: (guard as Guard)({ request: new Request("http://test/fn"), next }),
  };
};

const refusal = async (result: Promise<unknown>) => {
  const thrown: unknown = await result.then(
    () => null,
    (error: unknown) => error,
  );
  if (!(thrown instanceof Response)) throw new Error("expected a Response to be thrown");
  return { status: thrown.status, body: await thrown.text() };
};

beforeEach(() => {
  source.mockReset();
});

describe.each([
  ["requireSession", requireSession],
  ["requireOwnSession", requireOwnSession],
  ["requireAdmin", requireAdmin],
])("%s", (_name, guard) => {
  it("refuses a caller with no session as unauthenticated", async () => {
    source.mockResolvedValue(null);
    expect(await refusal(run(guard).result)).toEqual({
      status: 401,
      body: UNAUTHENTICATED_BODY,
    });
  });

  it("refuses an account still waiting distinctly, so the client can say so", async () => {
    source.mockResolvedValue(held("admin", false) as never);
    expect(await refusal(run(guard).result)).toEqual({
      status: 403,
      body: NOT_APPROVED_BODY,
    });
  });
});

describe("requireSession", () => {
  it("passes an approved session on", async () => {
    source.mockResolvedValue(held("user", true) as never);
    const { next, result } = run(requireSession);

    await result;

    expect(next).toHaveBeenCalledWith({
      context: { session: { user: { id: "u1", role: "user" }, session: {} } },
    });
  });

  it("lets an admin acting as someone use the app as them", async () => {
    source.mockResolvedValue(held("user", true, "admin-1") as never);
    const { next, result } = run(requireSession);

    await result;

    expect(next).toHaveBeenCalled();
  });
});

describe("requireOwnSession", () => {
  it("refuses an admin acting as someone, since what it guards outlasts the session", async () => {
    source.mockResolvedValue(held("user", true, "admin-1") as never);
    const { next, result } = run(requireOwnSession);
    expect(await refusal(result)).toEqual({ status: 403, body: IMPERSONATING_BODY });
    expect(next).not.toHaveBeenCalled();
  });

  it("passes the person themselves on", async () => {
    source.mockResolvedValue(held("user", true) as never);
    const { next, result } = run(requireOwnSession);

    await result;

    expect(next).toHaveBeenCalled();
  });
});

describe("requireAdmin", () => {
  it("refuses an approved non-admin without the waiting wording", async () => {
    source.mockResolvedValue(held("user", true) as never);
    expect(await refusal(run(requireAdmin).result)).toEqual({ status: 403, body: "Forbidden" });
  });

  it("passes an approved admin on", async () => {
    source.mockResolvedValue(held("admin", true) as never);
    const { next, result } = run(requireAdmin);

    await result;

    expect(next).toHaveBeenCalled();
  });
});
