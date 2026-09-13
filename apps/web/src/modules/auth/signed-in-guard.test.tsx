import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSessionUser } from "~/modules/auth/server/functions.ts";
import { getApprovalStatus } from "~/modules/auth/server/signup-functions.ts";
import { leaveIfSignedIn } from "./signed-in-guard.ts";

vi.mock("~/modules/auth/server/functions.ts", () => ({
  getSessionUser: vi.fn(),
  getSessionIdentity: vi.fn(),
}));
vi.mock("~/modules/auth/server/signup-functions.ts", () => ({ getApprovalStatus: vi.fn() }));

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApprovalStatus).mockResolvedValue("approved");
});

describe("sign-in page guard", () => {
  it("lets a visitor without a session see the form", async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);
    await expect(leaveIfSignedIn(newClient(), "/desktop/sign-in")).resolves.toBeUndefined();
  });

  it("sends a signed-in visitor on to the page that asked for them", async () => {
    vi.mocked(getSessionUser).mockResolvedValue({ id: "u1" } as never);
    await expect(
      leaveIfSignedIn(newClient(), "/desktop/sign-in?challenge=abc"),
    ).rejects.toMatchObject({ options: { href: "/desktop/sign-in?challenge=abc" } });
  });

  it("sends a signed-in visitor home when nothing asked for them", async () => {
    vi.mocked(getSessionUser).mockResolvedValue({ id: "u1" } as never);
    await expect(leaveIfSignedIn(newClient(), undefined)).rejects.toMatchObject({
      options: { href: "/" },
    });
  });

  it("keeps an unapproved account on the waiting screen", async () => {
    vi.mocked(getSessionUser).mockResolvedValue({ id: "u1" } as never);
    vi.mocked(getApprovalStatus).mockResolvedValue("pending");
    await expect(leaveIfSignedIn(newClient(), "/desktop/sign-in")).rejects.toMatchObject({
      options: { to: "/pending" },
    });
  });
});
