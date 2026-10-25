import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import {
  deleteOAuthProvider,
  saveBuiltinOAuthProvider,
  saveOidcOAuthProvider,
  setOAuthProviderEnabled,
} from "../server/oauth-functions.ts";
import { saveAuthSettings } from "../server/signup-functions.ts";
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

vi.mock("../server/oauth-functions.ts", () => ({
  listOAuthProviders: vi.fn(),
  saveBuiltinOAuthProvider: vi.fn(),
  saveOidcOAuthProvider: vi.fn(),
  setOAuthProviderEnabled: vi.fn(),
  deleteOAuthProvider: vi.fn(),
}));

vi.mock("../server/signup-functions.ts", () => ({
  getAuthSettings: vi.fn(),
  saveAuthSettings: vi.fn(),
}));

const saveBuiltin = vi.mocked(saveBuiltinOAuthProvider);
const saveOidc = vi.mocked(saveOidcOAuthProvider);
const setEnabled = vi.mocked(setOAuthProviderEnabled);
const remove = vi.mocked(deleteOAuthProvider);
const saveSettings = vi.mocked(saveAuthSettings);

const settings = {
  passwordSignup: "approval",
  passwordLogin: true,
  requireEmailVerification: false,
  admitDomains: [] as string[],
  smtpConfigured: false,
  passwordLoginForced: false,
  verificationRequired: false,
};

type Provider = {
  id: string;
  kind: "builtin" | "oidc";
  label: string;
  enabled: boolean;
  signup: "open" | "approval" | "closed";
  trustEmails: boolean;
  exclusive: boolean;
  clientId: string;
  secretConfigured: boolean;
  config: Record<string, unknown>;
};

const provider = (overrides: Partial<Provider> & Pick<Provider, "id" | "kind" | "label">) => ({
  enabled: true,
  signup: "approval" as const,
  trustEmails: false,
  exclusive: false,
  clientId: `${overrides.id}-client`,
  secretConfigured: true,
  config: {},
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const renderPage = (
  providers: ReturnType<typeof provider>[],
  baseURL = "https://chat.example",
  stored: Partial<typeof settings> = {},
) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["admin", "oauth"], { baseURL, providers });
  client.setQueryData(["admin", "auth-settings"], { ...settings, ...stored });
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

// Header and empty state both offer it, and the dialog's submit repeats the
// wording, so every lookup here is deliberate about which one it means.
const openAdd = async () => {
  const user = userEvent.setup();
  await user.click((await screen.findAllByRole("button", { name: "Add provider" }))[0]!);
  return { user, dialog: await screen.findByRole("dialog") };
};

const submit = (dialog: HTMLElement, name: string) => within(dialog).getByRole("button", { name });

const pick = async (user: ReturnType<typeof userEvent.setup>, field: string, option: string) => {
  await user.click(screen.getByRole("combobox", { name: field }));
  await user.click(await screen.findByRole("option", { name: option }));
};

beforeEach(() => {
  vi.clearAllMocks();
  saveBuiltin.mockResolvedValue({} as never);
  saveOidc.mockResolvedValue({} as never);
  setEnabled.mockResolvedValue(undefined as never);
  remove.mockResolvedValue(undefined as never);
  saveSettings.mockResolvedValue(undefined as never);
});

describe("OAuthPage", () => {
  it("lists only what is configured, rather than every provider that could be", async () => {
    renderPage([provider({ id: "google", kind: "builtin", label: "Google" })]);

    expect(await screen.findByText("Google")).toBeInTheDocument();
    expect(screen.queryByText("GitHub")).not.toBeInTheDocument();
    expect(screen.queryByText("Apple")).not.toBeInTheDocument();
  });

  it("offers a way in from the empty state", async () => {
    renderPage([]);
    expect(await screen.findByText("No sign-in providers yet")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Add provider" })).toHaveLength(2);
  });

  it("keeps a configured built-in out of the type picker, having no second slot", async () => {
    renderPage([provider({ id: "google", kind: "builtin", label: "Google" })]);
    const { user } = await openAdd();

    await user.click(screen.getByRole("combobox", { name: "Type" }));

    expect(await screen.findByRole("option", { name: "GitHub" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "OpenID Connect" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Google" })).not.toBeInTheDocument();
  });

  it("adds a built-in with the field only its own provider reads", async () => {
    renderPage([]);
    const { user, dialog } = await openAdd();

    await pick(user, "Type", "Microsoft");
    await user.type(screen.getByLabelText("Client ID"), "entra-client");
    await user.type(screen.getByLabelText("Client secret"), "entra-secret");
    await user.type(screen.getByLabelText("Tenant ID (optional)"), "contoso");
    await user.click(submit(dialog, "Add provider"));

    await waitFor(() => expect(saveBuiltin).toHaveBeenCalled());
    expect(saveBuiltin.mock.calls[0]?.[0].data).toEqual({
      id: "microsoft",
      enabled: true,
      signup: "approval",
      trustEmails: false,
      exclusive: false,
      clientId: "entra-client",
      secret: "entra-secret",
      tenantId: "contoso",
    });
  });

  it("shows the callback URL for the id being typed, before anything is saved", async () => {
    renderPage([]);
    const { user } = await openAdd();

    await pick(user, "Type", "OpenID Connect");
    await user.type(screen.getByLabelText("Provider ID"), "authentik");

    expect(screen.getByLabelText("Callback URL")).toHaveValue(
      "https://chat.example/api/auth/callback/authentik",
    );
  });

  it("adds an OpenID Connect provider under the id and scopes given", async () => {
    renderPage([]);
    const { user, dialog } = await openAdd();

    await pick(user, "Type", "OpenID Connect");
    await user.type(screen.getByLabelText("Provider ID"), "authentik");
    await user.type(screen.getByLabelText("Button label"), "Company SSO");
    await user.type(screen.getByLabelText("Discovery URL"), "https://id.test/.well-known/x");
    await user.type(screen.getByLabelText("Client ID"), "sso-client");
    await user.type(screen.getByLabelText("Client secret"), "sso-secret");
    await pick(user, "New accounts", "Anyone can join");
    await user.click(screen.getByRole("switch", { name: "Trust its emails" }));
    await user.click(screen.getByRole("switch", { name: "Only sign-in for its accounts" }));
    await user.click(submit(dialog, "Add provider"));

    await waitFor(() => expect(saveOidc).toHaveBeenCalled());
    expect(saveOidc.mock.calls[0]?.[0].data).toEqual({
      id: "authentik",
      label: "Company SSO",
      enabled: true,
      signup: "open",
      trustEmails: true,
      exclusive: true,
      clientId: "sso-client",
      secret: "sso-secret",
      discoveryUrl: "https://id.test/.well-known/x",
      scopes: ["openid", "profile", "email"],
    });
  });

  it("never renders a stored secret and saves without one when it is left alone", async () => {
    renderPage([provider({ id: "google", kind: "builtin", label: "Google" })]);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Edit Google" }));
    const secret = screen.getByLabelText("Client secret");
    expect(secret).toHaveValue("");
    expect(secret).toHaveAttribute("placeholder", "Unchanged");

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(saveBuiltin).toHaveBeenCalled());
    expect(saveBuiltin.mock.calls[0]?.[0].data).not.toHaveProperty("secret");
  });

  it("fixes the type and id of a provider accounts already came in through", async () => {
    renderPage([provider({ id: "authentik", kind: "oidc", label: "Company SSO" })]);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Edit Company SSO" }));

    expect(screen.queryByRole("combobox", { name: "Type" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Provider ID")).toBeDisabled();
  });

  it("enables a row without resending the credentials on screen", async () => {
    renderPage([provider({ id: "google", kind: "builtin", label: "Google", enabled: false })]);

    fireEvent.click(await screen.findByRole("switch", { name: "Google enabled" }));

    await waitFor(() => expect(setEnabled).toHaveBeenCalled());
    expect(setEnabled.mock.calls[0]?.[0].data).toEqual({ id: "google", enabled: true });
    expect(saveBuiltin).not.toHaveBeenCalled();
  });

  it("asks before removing, naming what stops working", async () => {
    renderPage([provider({ id: "google", kind: "builtin", label: "Google" })]);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Remove Google" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("cannot get in until it is set up again");
    expect(remove).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Remove provider" }));

    await waitFor(() => expect(remove).toHaveBeenCalled());
    expect(remove.mock.calls[0]?.[0].data).toEqual({ id: "google" });
  });

  it("turns each typed domain into a chip and saves the list as it grows", async () => {
    renderPage([]);
    const user = userEvent.setup();
    const input = await screen.findByLabelText("Domains that join directly");

    await user.type(input, "Corp.example,");
    await user.type(input, "ada@lab.example{Enter}");

    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(2));
    expect(saveSettings.mock.calls[1]?.[0].data.admitDomains).toEqual([
      "corp.example",
      "lab.example",
    ]);
    expect(screen.getByLabelText("corp.example")).toBeVisible();
  });

  it("adds a pasted list at once and keeps what isn’t a domain to fix", async () => {
    renderPage([]);
    const user = userEvent.setup();
    const input = await screen.findByLabelText("Domains that join directly");

    await user.click(input);
    await user.paste("one.example two.example nonsense ");

    await waitFor(() => expect(saveSettings).toHaveBeenCalled());
    expect(saveSettings.mock.calls[0]?.[0].data.admitDomains).toEqual([
      "one.example",
      "two.example",
    ]);
    expect(input).toHaveValue("nonsense");
    expect(screen.getByText("“nonsense” isn’t a domain.")).toBeVisible();
  });

  it("removes a domain from its chip", async () => {
    renderPage([], undefined, { admitDomains: ["corp.example", "lab.example"] });
    const user = userEvent.setup();

    const chip = await screen.findByLabelText("corp.example");
    await user.click(within(chip).getByRole("button"));

    await waitFor(() => expect(saveSettings).toHaveBeenCalled());
    expect(saveSettings.mock.calls[0]?.[0].data.admitDomains).toEqual(["lab.example"]);
  });

  it("holds verification off until email is set up", async () => {
    renderPage([]);
    expect(
      await screen.findByRole("switch", { name: "Require email verification" }),
    ).toHaveAttribute("aria-disabled", "true");
  });
});
