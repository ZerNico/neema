import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authClient } from "~/modules/auth/client.ts";
import { SignInProviders } from "./sign-in-providers.tsx";

vi.mock("../server/oauth-functions.ts", () => ({ getSignInProviders: vi.fn() }));
vi.mock("~/modules/auth/client.ts", () => ({ authClient: { signIn: { social: vi.fn() } } }));

const social = vi.mocked(authClient.signIn.social);

const renderButtons = (providers: { id: string; label: string }[]) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["sign-in-providers"], providers);
  return render(
    <QueryClientProvider client={client}>
      <Suspense fallback={null}>
        <SignInProviders />
      </Suspense>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  social.mockResolvedValue({ error: null } as never);
});

describe("SignInProviders", () => {
  it("renders nothing when no provider is enabled", () => {
    const { container } = renderButtons([]);
    expect(container).toBeEmptyDOMElement();
  });

  it("signs in through the id of the provider whose button was pressed", async () => {
    renderButtons([
      { id: "google", label: "Google" },
      { id: "acme", label: "Acme" },
    ]);

    fireEvent.click(await screen.findByRole("button", { name: "Continue with Acme" }));

    await waitFor(() => expect(social).toHaveBeenCalled());
    expect(social.mock.calls[0]?.[0]).toMatchObject({ provider: "acme", callbackURL: "/" });
  });

  it("reports a failure instead of leaving the button spinning", async () => {
    social.mockResolvedValue({ error: { message: "Provider is unavailable." } } as never);
    renderButtons([{ id: "google", label: "Google" }]);

    fireEvent.click(await screen.findByRole("button", { name: "Continue with Google" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Provider is unavailable.");
  });
});
