import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionUserQuery } from "~/modules/auth/client.ts";
import { myIntegrationsQuery } from "../client/queries.ts";
import { announceSignIn } from "../client/sign-in-channel.ts";
import type { IntegrationConnectionView, UserIntegration } from "../schema.ts";
import { ConnectFlow } from "./connect-flow.tsx";

vi.mock("../server/functions.ts", () => ({
  connectIntegrationOpen: vi.fn(async () => ({ ok: true })),
  connectIntegrationApiKey: vi.fn(),
  listMyIntegrations: vi.fn(async () => []),
}));

const wiki: UserIntegration = {
  id: "wiki",
  kind: "outline",
  name: "Wiki",
  description: null,
  server: null,
  available: true,
  personal: false,
  methods: { oauth: true, apiKey: true, open: null, everyone: false },
  tools: [],
  apiKeyHelpUrl: null,
  connections: [],
};

const account: IntegrationConnectionView = {
  id: "connection-1",
  authKind: "oauth",
  accountLabel: "ada@example.com",
  name: null,
  status: "active",
  offerByDefault: true,
  toolPermissions: {},
  scope: null,
  requiredScopes: null,
  listing: null,
  tools: [
    { name: "search", title: "Search", label: "Searching", description: "", access: "read" },
    { name: "create", title: "Create", label: "Creating", description: "", access: "write" },
  ],
  dependents: { sources: 0, schedules: 0 },
  createdAt: "2026-10-20T10:00:00Z",
};

const mount = () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(myIntegrationsQuery.queryKey, [wiki]);
  client.setQueryData(sessionUserQuery.queryKey, { id: "me" } as never);
  const done = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <ConnectFlow integration={wiki} onBack={() => {}} onDone={done} onOpenPage={() => {}} />
    </QueryClientProvider>,
  );
  return { client, done };
};

afterEach(() => vi.restoreAllMocks());

describe("connecting in the dialog", () => {
  it("signs in in a window of its own, and is ready once the account shows up", async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, "open").mockReturnValue({} as Window);
    const { client, done } = mount();
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    const [url] = open.mock.calls[0]!;
    // It comes back to the page that tells this dialog, never to Settings.
    expect(String(url)).toMatch(
      /^\/api\/integrations\/wiki\/connect\?returnTo=%2Fintegrations%2Fconnected%3Fattempt%3D.+&as=me$/,
    );
    expect(screen.getByText("Finish signing in to Outline in the new window")).toBeInTheDocument();

    act(() =>
      client.setQueryData(myIntegrationsQuery.queryKey, [{ ...wiki, connections: [account] }]),
    );
    expect(await screen.findByText("Wiki is ready")).toBeInTheDocument();
    expect(screen.getByText("2 tools. Reads run, changes ask first.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(done).toHaveBeenCalled();
  });

  it("shows why a sign-in failed, as the window it ran in reported it", async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, "open").mockReturnValue({} as Window);
    mount();
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    const landing = new URL(
      String(open.mock.calls[0]![0]),
      "https://chat.example",
    ).searchParams.get("returnTo")!;
    const attempt = new URL(landing, "https://chat.example").searchParams.get("attempt")!;
    // Another dialog's sign-in is not this one's.
    announceSignIn({ attempt: "someone-else", error: "Not this one." });
    announceSignIn({ attempt, error: "Atlassian refused this site." });
    expect(await screen.findByText("Atlassian refused this site.")).toBeInTheDocument();
    expect(screen.queryByText("Not this one.")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use an API key instead" })).toBeInTheDocument();
  });

  it("closes an earlier sign-in window, so a cancelled one cannot add a second account", async () => {
    const user = userEvent.setup();
    const first: Pick<Window, "close"> = { close: vi.fn() };
    const second: Pick<Window, "close"> = { close: vi.fn() };
    vi.spyOn(window, "open")
      .mockReturnValueOnce(first as Window)
      .mockReturnValueOnce(second as Window);
    mount();
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(first.close).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(second.close).not.toHaveBeenCalled();
  });

  it("offers the window again when the browser blocked it", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "open").mockReturnValue(null);
    mount();
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Open sign-in window" })).toHaveAttribute(
        "target",
        "_blank",
      ),
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });
});
