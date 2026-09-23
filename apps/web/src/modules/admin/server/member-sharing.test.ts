import { beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { GroupMemberNotFound } from "~/modules/groups/errors.ts";
import { updateGroupMemberSharing } from "./functions.ts";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  setMemberSharing: vi.fn(),
  publishGlobal: vi.fn(),
}));
vi.mock("~/modules/auth/server/auth.ts", () => ({
  sessionFromHeaders: async () => {
    const session: unknown = await mocks.session();
    return session ? { session, approved: true } : null;
  },
}));
// Execute the registered middleware and handler without starting the application runtime.
// Authorization is the real requireAdmin implementation, not a replacement policy.
vi.mock("@tanstack/react-start", () => ({
  createMiddleware: () => ({ server: (handler: unknown) => handler }),
  createServerFn: () => {
    type Middleware = (input: {
      request: Request;
      next: () => Promise<unknown>;
    }) => Promise<unknown>;
    let middleware: Middleware[] = [];
    let validator: { "~standard": { validate: (data: unknown) => unknown } } | undefined;
    const builder = {
      middleware: (value: Middleware[]) => {
        middleware = value;
        return builder;
      },
      validator: (value: typeof validator) => {
        validator = value;
        return builder;
      },
      handler:
        (handler: (input: { data: unknown }) => unknown) =>
        async ({ data }: { data: unknown }) => {
          const execute = async (index: number): Promise<unknown> => {
            if (middleware[index])
              return middleware[index]({
                request: new Request("http://test"),
                next: () => execute(index + 1),
              });
            const result = (await validator?.["~standard"].validate(data)) as {
              issues?: unknown;
              value: unknown;
            };
            if (result?.issues) throw new Error("Invalid input");
            return handler({ data: result?.value ?? data });
          };
          return execute(0);
        },
    };
    return builder;
  },
}));
vi.mock("~/server/runtime.ts", async () => {
  const { Effect: Fx } = await import("effect");
  const { GroupRepo } = await import("~/modules/groups/server/repo.ts");
  const { SyncBus } = await import("~/modules/sync/server/bus.ts");
  return {
    runtime: {
      runPromise: (effect: Effect.Effect<unknown, unknown, never>) =>
        Fx.runPromise(
          effect.pipe(
            Fx.provideService(GroupRepo, { setMemberSharing: mocks.setMemberSharing } as never),
            Fx.provideService(SyncBus, { publishGlobal: mocks.publishGlobal } as never),
          ),
        ),
    },
  };
});
const sharing = { agents: true, knowledge: false, skills: true };
const data = { groupId: "g1", userId: "u1", sharing };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.setMemberSharing.mockReturnValue(Effect.void);
  mocks.publishGlobal.mockReturnValue(Effect.void);
});

describe("updateGroupMemberSharing", () => {
  it.each([null, { user: { role: "user" } }])(
    "denies non-admin sessions before mutation: %j",
    async (session) => {
      mocks.session.mockResolvedValue(session);
      await expect(updateGroupMemberSharing({ data })).rejects.toMatchObject({
        status: session ? 403 : 401,
      });
      expect(mocks.setMemberSharing).not.toHaveBeenCalled();
      expect(mocks.publishGlobal).not.toHaveBeenCalled();
    },
  );
  it("allows admins to update exactly one membership and publishes resource invalidation", async () => {
    mocks.session.mockResolvedValue({ user: { role: "admin" } });
    await updateGroupMemberSharing({ data });
    expect(mocks.setMemberSharing).toHaveBeenCalledExactlyOnceWith("g1", "u1", sharing);
    expect(mocks.publishGlobal).toHaveBeenCalledExactlyOnceWith({ type: "resources.changed" });
  });
  it("maps missing membership to 404 without publishing success", async () => {
    mocks.session.mockResolvedValue({ user: { role: "admin" } });
    mocks.setMemberSharing.mockReturnValue(
      Effect.fail(new GroupMemberNotFound({ groupId: "g1", userId: "u1" })),
    );
    await expect(updateGroupMemberSharing({ data })).rejects.toMatchObject({ status: 404 });
    expect(mocks.publishGlobal).not.toHaveBeenCalled();
  });
  it("requires a member id and a boolean for every kind", async () => {
    mocks.session.mockResolvedValue({ user: { role: "admin" } });
    await expect(
      updateGroupMemberSharing({ data: { groupId: "g1", sharing } as never }),
    ).rejects.toThrow("Invalid input");
    await expect(
      updateGroupMemberSharing({
        data: { ...data, sharing: { ...sharing, skills: "true" } } as never,
      }),
    ).rejects.toThrow("Invalid input");
    await expect(
      updateGroupMemberSharing({ data: { ...data, sharing: { agents: true } } as never }),
    ).rejects.toThrow("Invalid input");
    expect(mocks.setMemberSharing).not.toHaveBeenCalled();
  });
});
