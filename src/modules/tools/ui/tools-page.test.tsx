import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolsPage } from "./tools-page.tsx";
import {
  testSearchConnection,
  updateDocumentParserTool,
  updateMemoryTool,
  updateUrlReaderTool,
  updateWebSearchTool,
} from "../server/functions.ts";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import { toast } from "sonner";

vi.mock("../server/functions.ts", () => ({
  getMemoryTool: vi.fn(),
  getWebSearchTool: vi.fn(),
  getUrlReaderTool: vi.fn(),
  getDocumentParserTool: vi.fn(),
  testSearchConnection: vi.fn(),
  updateMemoryTool: vi.fn(),
  updateWebSearchTool: vi.fn(),
  updateUrlReaderTool: vi.fn(),
  updateDocumentParserTool: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...rest }: Record<string, unknown> & { children?: unknown }) => (
    <a href={String(to)} {...(rest as object)}>
      {children as never}
    </a>
  ),
}));

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const tool = (
  name: string,
  config: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  id: name,
  name,
  kind: name === "document_parser" ? "local" : name,
  enabled: true,
  config,
  secretConfigured: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...extra,
});

const renderPage = ({
  webSearch = tool("web_search", { backend: "searxng", baseUrl: "http://searx", maxResults: 8 }),
}: { webSearch?: ReturnType<typeof tool> | null } = {}) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["admin", "tools", "memory"], tool("memory", {}));
  client.setQueryData(["admin", "tools", "web-search"], webSearch);
  client.setQueryData(
    ["admin", "tools", "url-reader"],
    tool("read_url", { perPageCharCap: 12000 }),
  );
  client.setQueryData(
    ["admin", "tools", "document-parser"],
    tool("document_parser", { maxChars: 120000, maxPages: 200 }),
  );
  render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <Suspense fallback={null}>
          <ToolsPage />
        </Suspense>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
};

const saveButtons = () => screen.getAllByRole("button", { name: "Save" });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ToolsPage", () => {
  it("updates the single instance-wide memory switch", async () => {
    const user = userEvent.setup();
    vi.mocked(updateMemoryTool).mockResolvedValue(undefined as never);
    renderPage();

    await user.click(screen.getByRole("switch", { name: "Memory enabled" }));

    await waitFor(() =>
      expect(updateMemoryTool).toHaveBeenCalledWith({ data: { enabled: false } }),
    );
  });

  it("submits the web search form on Enter and keeps the label while pending", async () => {
    const user = userEvent.setup();
    const pending = deferred<unknown>();
    vi.mocked(updateWebSearchTool).mockReturnValue(pending.promise as never);
    renderPage();

    await user.type(screen.getByLabelText("Max results per query"), "{Backspace}5{Enter}");

    await waitFor(() =>
      expect(updateWebSearchTool).toHaveBeenCalledWith({
        data: { baseUrl: "http://searx", maxResults: 5 },
      }),
    );
    const [save] = saveButtons();
    expect(save).toHaveAttribute("aria-busy", "true");
    expect(save!.querySelector('[data-slot="spinner"]')).toBeInTheDocument();
    expect(save).toHaveTextContent("Save");

    pending.resolve(undefined);
    await waitFor(() => expect(save).not.toHaveAttribute("aria-busy"));
  });

  it("shows a range error for an out-of-range result count", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText("Max results per query"), "0{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent("Between 1 and 20.");
    expect(updateWebSearchTool).not.toHaveBeenCalled();
  });

  it("submits the URL reader form on Enter and rejects a cap below the floor", async () => {
    const user = userEvent.setup();
    vi.mocked(updateUrlReaderTool).mockResolvedValue(undefined as never);
    renderPage();

    const cap = screen.getByLabelText("Per-page character cap");
    await user.clear(cap);
    await user.type(cap, "500{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Between 1000 and 20000.");

    await user.clear(cap);
    await user.type(cap, "15000{Enter}");
    await waitFor(() =>
      expect(updateUrlReaderTool).toHaveBeenCalledWith({ data: { perPageCharCap: 15000 } }),
    );
    expect(saveButtons()[1]).toHaveTextContent("Save");
  });

  it("submits the document parser form on Enter and flags a non-integer page count", async () => {
    const user = userEvent.setup();
    const pending = deferred<unknown>();
    vi.mocked(updateDocumentParserTool).mockReturnValue(pending.promise as never);
    renderPage();

    const pages = screen.getByLabelText("Max pages");
    await user.clear(pages);
    await user.type(pages, "2.5{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a whole number.");
    expect(updateDocumentParserTool).not.toHaveBeenCalled();

    await user.clear(pages);
    await user.type(pages, "300{Enter}");
    await waitFor(() =>
      expect(updateDocumentParserTool).toHaveBeenCalledWith({
        data: { maxChars: 120000, maxPages: 300 },
      }),
    );
    const save = saveButtons()[2]!;
    expect(save).toHaveAttribute("aria-busy", "true");
    expect(save.querySelector('[data-slot="spinner"]')).toBeInTheDocument();
    expect(save).toHaveTextContent("Save");
    pending.resolve(undefined);
    await waitFor(() => expect(save).not.toHaveAttribute("aria-busy"));
  });

  it("keeps the Test connection label while testing and colours the result", async () => {
    const user = userEvent.setup();
    const pending = deferred<{ ok: true; resultCount: number; latencyMs: number }>();
    vi.mocked(testSearchConnection).mockReturnValue(pending.promise as never);
    renderPage();

    const test = screen.getByRole("button", { name: "Test connection" });
    await user.click(test);
    expect(test).toHaveAttribute("aria-busy", "true");
    expect(test.querySelector('[data-slot="spinner"]')).toBeInTheDocument();
    expect(test).toHaveTextContent("Test connection");

    pending.resolve({ ok: true, resultCount: 3, latencyMs: 42 });
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Connection ok — 3 results in 42ms.");
    expect(status).toHaveClass("text-success");
  });

  it("asks before clearing a stored secret", async () => {
    const user = userEvent.setup();
    vi.mocked(updateWebSearchTool).mockResolvedValue(undefined as never);
    renderPage({
      webSearch: tool(
        "web_search",
        { backend: "searxng", baseUrl: "http://searx", maxResults: 8 },
        { secretConfigured: true },
      ),
    });

    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(updateWebSearchTool).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Clear the stored secret?");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(updateWebSearchTool).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Clear" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Clear" }),
    );
    await waitFor(() =>
      expect(updateWebSearchTool).toHaveBeenCalledWith({ data: { clearSecret: true } }),
    );
  });

  it("toasts when a toggle fails", async () => {
    const user = userEvent.setup();
    vi.mocked(updateWebSearchTool).mockRejectedValue(new Error("boom"));
    renderPage();

    await user.click(screen.getByRole("switch", { name: "Web search enabled" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not update web search."));
  });

  it("shows an empty state when the tool row is missing", () => {
    renderPage({ webSearch: null });
    expect(screen.getByText("This tool isn't set up yet.")).toBeInTheDocument();
    expect(screen.queryByText(/migrations/)).not.toBeInTheDocument();
  });
});
