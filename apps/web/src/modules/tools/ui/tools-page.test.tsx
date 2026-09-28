import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolsPage } from "./tools-page.tsx";
import type { PublicTool } from "../server/repo.ts";
import {
  getDocumentParserTool,
  getMemoryTool,
  getUrlReaderTool,
  getWebSearchTool,
  testSearchConnection,
  updateMemoryTool,
  updateOfficeFilesTool,
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
  getOfficeFilesTool: vi.fn(),
  updateOfficeFilesTool: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("~/modules/presentations/server/font-functions.ts", () => ({
  listPresentationFonts: vi.fn(async () => []),
  uploadPresentationFont: vi.fn(),
  deletePresentationFont: vi.fn(),
}));

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
  config: PublicTool["config"],
  extra: Partial<PublicTool> = {},
): PublicTool => ({
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
  officeFiles = tool("office_files", {}),
}: {
  webSearch?: ReturnType<typeof tool> | null;
  officeFiles?: ReturnType<typeof tool> | null;
} = {}) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const memory = tool("memory", {});
  vi.mocked(getMemoryTool).mockResolvedValue(memory);
  vi.mocked(getWebSearchTool).mockResolvedValue(webSearch);
  vi.mocked(getUrlReaderTool).mockResolvedValue(tool("read_url", { perPageCharCap: 12000 }));
  vi.mocked(getDocumentParserTool).mockResolvedValue(
    tool("document_parser", { maxChars: 120000, maxPages: 200 }),
  );
  client.setQueryData(["admin", "tools", "memory"], memory);
  client.setQueryData(["admin", "presentation-fonts"], []);
  client.setQueryData(["admin", "tools", "office-files"], officeFiles);
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
        data: { baseUrl: "http://searx", maxResults: 5, researchMaxSearchQueries: 80 },
      }),
    );
    const [save] = saveButtons();
    expect(save).toHaveAttribute("aria-busy", "true");
    expect(save!.querySelector('[data-slot="spinner"]')).toBeInTheDocument();
    expect(save).toHaveTextContent("Save");

    pending.resolve(undefined);
    await waitFor(() => expect(save).not.toHaveAttribute("aria-busy"));
  });

  it("loads and saves the research search budget without changing the pending label", async () => {
    const user = userEvent.setup();
    const pending = deferred<unknown>();
    vi.mocked(updateWebSearchTool).mockReturnValue(pending.promise as never);
    renderPage({
      webSearch: tool("web_search", {
        backend: "searxng",
        baseUrl: "http://searx",
        maxResults: 8,
        researchMaxSearchQueries: 40,
      }),
    });
    const cap = screen.getByLabelText("Search queries per research run");
    expect(cap).toHaveValue(40);
    await user.clear(cap);
    await user.type(cap, "60{Enter}");
    await waitFor(() =>
      expect(updateWebSearchTool).toHaveBeenCalledWith({
        data: { baseUrl: "http://searx", maxResults: 8, researchMaxSearchQueries: 60 },
      }),
    );
    const [save] = saveButtons();
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute("aria-busy", "true");
    expect(save).toHaveTextContent("Save");
    vi.mocked(getWebSearchTool).mockResolvedValue(
      tool("web_search", {
        backend: "searxng",
        baseUrl: "http://searx",
        maxResults: 8,
        researchMaxSearchQueries: 60,
      }),
    );
    pending.resolve(undefined);
    await waitFor(() => expect(save).not.toHaveAttribute("aria-busy"));
    await waitFor(() => expect(cap).toHaveValue(60));
  });

  it.each([
    ["11", "Between 12 and 120."],
    ["121", "Between 12 and 120."],
    ["12.5", "Enter a whole number."],
  ])("rejects research budget %s before saving", async (value, error) => {
    const user = userEvent.setup();
    renderPage();
    const cap = screen.getByLabelText("Search queries per research run");
    expect(cap).toHaveValue(80);
    await user.clear(cap);
    await user.type(cap, `${value}{Enter}`);
    expect(await screen.findByRole("alert")).toHaveTextContent(error);
    expect(updateWebSearchTool).not.toHaveBeenCalled();
  });

  it("retains the edited research budget after a failed save", async () => {
    const user = userEvent.setup();
    vi.mocked(updateWebSearchTool).mockRejectedValueOnce(new Error("offline"));
    renderPage();
    const cap = screen.getByLabelText("Search queries per research run");
    await user.clear(cap);
    await user.type(cap, "24{Enter}");
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Could not save the web search settings."),
    );
    expect(cap).toHaveValue(24);
    expect(saveButtons()[0]).not.toHaveAttribute("aria-busy");
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
    // The URL reader's own button confirms; the web search one is untouched.
    expect(await screen.findByRole("button", { name: "Saved" })).toBeInTheDocument();
    expect(saveButtons()).toHaveLength(1);
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
    const status = (await screen.findByText("Connection ok, 3 results in 42ms.")).closest(
      '[role="status"]',
    );
    expect(status).toHaveTextContent("Connection ok, 3 results in 42ms.");
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

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Could not update web search.", {
        description: "Boom.",
      }),
    );
  });

  it("shows an empty state when the tool row is missing", () => {
    renderPage({ webSearch: null, officeFiles: null });
    expect(screen.getAllByText("This tool isn’t set up yet")).toHaveLength(2);
    expect(screen.queryByText(/migrations/)).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Office files enabled" })).toBeNull();
  });

  it("switches Office file editing off", async () => {
    const user = userEvent.setup();
    vi.mocked(updateOfficeFilesTool).mockResolvedValue(undefined as never);
    renderPage();

    await user.click(screen.getByRole("switch", { name: "Office files enabled" }));

    await waitFor(() =>
      expect(updateOfficeFilesTool).toHaveBeenCalledWith({ data: { enabled: false } }),
    );
  });
});
