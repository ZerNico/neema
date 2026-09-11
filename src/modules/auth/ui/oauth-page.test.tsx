import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import { saveBuiltinOAuthProvider, saveOidcOAuthProvider } from "../server/oauth-functions.ts";
import { setSignupPolicy } from "../server/signup-functions.ts";
import { OAuthPage } from "./oauth-page.tsx";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...rest }: Record<string, unknown> & { children?: unknown }) => (
    <a href={String(to)} {...(rest as object)}>
      {children as never}
    </a>
  ),
  useMatches: () => [{ pathname: "/admin/auth" }],
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));

vi.mock("../server/signup-functions.ts", () => ({
  getSignupPolicy: vi.fn(),
  setSignupPolicy: vi.fn(),
}));

vi.mock("../server/oauth-functions.ts", () => ({
  listOAuthProviders: vi.fn(),
  saveBuiltinOAuthProvider: vi.fn(),
  saveOidcOAuthProvider: vi.fn(),
  deleteOAuthProvider: vi.fn(),
}));

const saveBuiltin = vi.mocked(saveBuiltinOAuthProvider);
const saveOidc = vi.mocked(saveOidcOAuthProvider);
const savePolicy = vi.mocked(setSignupPolicy);

type Provider = {
  id: string;
  kind: "builtin" | "oidc";
  label: string;
  enabled: boolean;
  clientId: string;
  trusted: boolean;
  secretConfigured: boolean;
  config: Record<string, unknown>;
};

const provider = (overrides: Partial<Provider> & Pick<Provider, "id" | "kind" | "label">) => ({
  enabled: true,
  trusted: false,
  clientId: `${overrides.id}-client`,
  secretConfigured: true,
  config: {},
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const renderPage = (providers: ReturnType<typeof provider>[], baseURL = "https://chat.example") => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["admin", "oauth"], { baseURL, providers });
  client.setQueryData(["admin", "signup-policy"], "approval");
  return render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <Suspense fallback={null}>
          <OAuthPage />
        </Suspense>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
};

const openEditor = async (label: string) => {
  fireEvent.click(await screen.findByRole("button", { name: label }));
};

beforeEach(() => {
  vi.clearAllMocks();
  saveBuiltin.mockResolvedValue({ ok: true } as never);
  savePolicy.mockResolvedValue(undefined as never);
  saveOidc.mockResolvedValue({ ok: true } as never);
});

describe("OAuthPage", () => {
  it("shows every built-in, with a toggle only once one is set up", async () => {
    renderPage([provider({ id: "google", kind: "builtin", label: "Google" })]);

    expect(await screen.findByText("Google")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Google enabled" })).not.toHaveAttribute(
      "aria-disabled",
    );
    expect(screen.getByRole("switch", { name: "GitHub enabled" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getAllByText("Not set up").length).toBe(5);
  });

  it("shows the callback URL to register with the provider", async () => {
    renderPage([provider({ id: "google", kind: "builtin", label: "Google" })]);
    await openEditor("Edit");

    expect(screen.getByLabelText("Callback URL")).toHaveValue(
      "https://chat.example/api/auth/callback/google",
    );
  });

  it("never renders a stored secret and saves without one when it is left alone", async () => {
    renderPage([provider({ id: "google", kind: "builtin", label: "Google" })]);
    await openEditor("Edit");

    const secret = screen.getByLabelText("Client secret");
    expect(secret).toHaveValue("");
    expect(secret).toHaveAttribute("placeholder", "Unchanged");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(saveBuiltin).toHaveBeenCalled());
    expect(saveBuiltin.mock.calls[0]?.[0].data).not.toHaveProperty("secret");
  });

  it("sends only the extra field its provider reads", async () => {
    renderPage([]);
    fireEvent.click((await screen.findAllByRole("button", { name: "Set up" }))[2]!);

    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "entra-client" } });
    fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: "entra-secret" } });
    fireEvent.change(screen.getByLabelText("Tenant ID"), { target: { value: "contoso" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(saveBuiltin).toHaveBeenCalled());
    expect(saveBuiltin.mock.calls[0]?.[0].data).toEqual({
      id: "microsoft",
      enabled: false,
      trusted: false,
      clientId: "entra-client",
      secret: "entra-secret",
      tenantId: "contoso",
    });
  });

  it("enables a provider from the row without committing an unsaved edit", async () => {
    renderPage([provider({ id: "google", kind: "builtin", label: "Google", enabled: false })]);
    await openEditor("Edit");
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "half-typed" } });

    fireEvent.click(screen.getByRole("switch", { name: "Google enabled" }));

    await waitFor(() => expect(saveBuiltin).toHaveBeenCalled());
    expect(saveBuiltin.mock.calls[0]?.[0].data).toEqual({
      id: "google",
      enabled: true,
      trusted: false,
      clientId: "google-client",
    });
  });

  it("marks a provider trusted so its accounts skip the queue", async () => {
    renderPage([provider({ id: "google", kind: "builtin", label: "Google" })]);
    await openEditor("Edit");

    fireEvent.click(screen.getByRole("switch", { name: "Skip approval for Google" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(saveBuiltin).toHaveBeenCalled());
    expect(saveBuiltin.mock.calls[0]?.[0].data).toMatchObject({ trusted: true });
  });

  it("changes who can join without a save step", async () => {
    renderPage([]);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("combobox", { name: "Who can join" }));
    await user.click(await screen.findByRole("option", { name: "Nobody new" }));

    await waitFor(() => expect(savePolicy).toHaveBeenCalled());
    expect(savePolicy.mock.calls[0]?.[0].data).toEqual({ policy: "closed" });
  });

  it("lists OpenID Connect providers under their own id and enables them in place", async () => {
    renderPage([
      provider({
        id: "acme",
        kind: "oidc",
        label: "Acme",
        enabled: false,
        config: {
          discoveryUrl: "https://id.acme.test/.well-known/openid-configuration",
          scopes: ["openid"],
        },
      }),
    ]);

    expect(await screen.findByText("Acme")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Acme enabled" }));

    await waitFor(() => expect(saveOidc).toHaveBeenCalled());
    expect(saveOidc.mock.calls[0]?.[0].data).toMatchObject({
      id: "acme",
      enabled: true,
      discoveryUrl: "https://id.acme.test/.well-known/openid-configuration",
    });
  });
});
