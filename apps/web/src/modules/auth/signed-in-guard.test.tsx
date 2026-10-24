import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMe } from "~/modules/auth/server/functions.ts";
import { leaveIfSignedIn } from "./signed-in-guard.ts";

vi.mock("~/modules/auth/server/functions.ts", () => ({ getMe: vi.fn() }));
vi.mock("~/modules/auth/server/signup-functions.ts", () => ({ getNeedsSetup: vi.fn() }));

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

const signedIn = (approval: "approved" | "pending" = "approved") =>
  ({ user: { id: "u1" }, identity: { userId: "u1", impersonatedBy: null }, approval }) as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sign-in page guard", () => {
  it("lets a visitor without a session see the form", async () => {
    vi.mocked(getMe).mockResolvedValue(null);
    await expect(leaveIfSignedIn(newClient(), "/desktop/sign-in")).resolves.toBeUndefined();
  });

  it("sends a signed-in visitor on to the page that asked for them", async () => {
    vi.mocked(getMe).mockResolvedValue(signedIn());
    await expect(
      leaveIfSignedIn(newClient(), "/desktop/sign-in?challenge=abc"),
    ).rejects.toMatchObject({ options: { href: "/desktop/sign-in?challenge=abc" } });
  });

  it("sends a signed-in visitor home when nothing asked for them", async () => {
    vi.mocked(getMe).mockResolvedValue(signedIn());
    await expect(leaveIfSignedIn(newClient(), undefined)).rejects.toMatchObject({
      options: { href: "/" },
    });
  });

  it("keeps an unapproved account on the waiting screen", async () => {
    vi.mocked(getMe).mockResolvedValue(signedIn("pending"));
    await expect(leaveIfSignedIn(newClient(), "/desktop/sign-in")).rejects.toMatchObject({
      options: { to: "/pending" },
    });
  });
});
