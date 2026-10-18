import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authClient } from "~/modules/auth/client.ts";
import { ConsentPage, type ConsentRequest } from "./consent-page.tsx";

vi.mock("~/modules/auth/client.ts", () => ({ authClient: { $fetch: vi.fn() } }));
vi.mock("../server/functions.ts", () => ({}));

const fetchMock = vi.mocked(authClient.$fetch);
const assign = vi.fn();

const wrap = (node: ReactNode) =>
  render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);

const ready = (overrides: { verifiedHost?: string | null } = {}): ConsentRequest => ({
  state: "ready",
  client: {
    name: "Claude",
    verifiedHost: overrides.verifiedHost ?? null,
    scopes: ["chats:read", "chats:write"],
  },
  redirectHost: "127.0.0.1:9999",
  scopes: ["chats:read", "chats:write"],
  offline: true,
});

beforeEach(() => {
  fetchMock.mockResolvedValue({ data: { url: "http://127.0.0.1:9999/cb?code=x" }, error: null });
  vi.stubGlobal("location", { ...window.location, assign });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ConsentPage", () => {
  it("names each scope once and says where the app returns", () => {
    wrap(<ConsentPage query="q=1" account="ada@example.com" request={ready()} />);
    expect(screen.getByRole("checkbox", { name: "Read and search your chats" })).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Send messages and start chats with your agents" }),
    ).toBeChecked();
    expect(screen.getByText(/Returns to 127\.0\.0\.1:9999/)).toBeInTheDocument();
    expect(screen.getByText(/The app named itself/)).toBeInTheDocument();
    expect(screen.getByText("It will act as ada@example.com.")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Can change" })).toContainElement(
      screen.getByRole("checkbox", { name: "Send messages and start chats with your agents" }),
    );
  });

  it("marks a client whose metadata came from its own domain", () => {
    wrap(
      <ConsentPage
        query="q=1"
        account="ada@example.com"
        request={ready({ verifiedHost: "claude.ai" })}
      />,
    );
    expect(screen.getByText("Registered by claude.ai")).toBeInTheDocument();
    expect(screen.queryByText(/The app named itself/)).not.toBeInTheDocument();
  });

  it("sends only the scopes kept, with offline access and the signed query", async () => {
    wrap(<ConsentPage query="client_id=c&sig=s" account="ada@example.com" request={ready()} />);
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Send messages and start chats with your agents" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("http://127.0.0.1:9999/cb?code=x"));
    expect(fetchMock).toHaveBeenCalledWith("/oauth2/consent", {
      method: "POST",
      body: { accept: true, scope: "chats:read offline_access", oauth_query: "client_id=c&sig=s" },
    });
  });

  it("cannot allow nothing", async () => {
    wrap(<ConsentPage query="q=1" account="ada@example.com" request={ready()} />);
    for (const name of [
      "Read and search your chats",
      "Send messages and start chats with your agents",
    ])
      await userEvent.click(screen.getByRole("checkbox", { name }));
    expect(screen.getByRole("button", { name: "Allow" })).toBeDisabled();
  });

  it("denies through the same signed query", async () => {
    wrap(<ConsentPage query="client_id=c&sig=s" account="ada@example.com" request={ready()} />);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/oauth2/consent", {
      method: "POST",
      body: { accept: false, oauth_query: "client_id=c&sig=s" },
    });
  });

  it("explains a request it cannot offer", () => {
    wrap(<ConsentPage query="q=1" account="ada@example.com" request={{ state: "not-allowed" }} />);
    expect(screen.getByText("Can’t connect apps")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow" })).not.toBeInTheDocument();
  });
});
