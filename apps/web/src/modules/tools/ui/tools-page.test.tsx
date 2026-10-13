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
  createSearchProvider,
  deleteSearchProvider,
  listSearchProviders,
  setSearchProviderOrder,
  testSearchProvider,
  updateInteractiveUiTool,
  updateMapsTool,
  updateMemoryTool,
  updateOfficeFilesTool,
  updateUrlReaderTool,
  updateSearchProvider,
  updateWebSearchTool,
} from "../server/functions.ts";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import { toast } from "sonner";

vi.mock("../server/functions.ts", () => ({
  getMemoryTool: vi.fn(),
  getWebSearchTool: vi.fn(),
  getUrlReaderTool: vi.fn(),
  getDocumentParserTool: vi.fn(),
  listSearchProviders: vi.fn(),
  createSearchProvider: vi.fn(),
  updateSearchProvider: vi.fn(),
  deleteSearchProvider: vi.fn(),
  setSearchProviderOrder: vi.fn(),
  testSearchProvider: vi.fn(),
  updateMemoryTool: vi.fn(),
  updateWebSearchTool: vi.fn(),
  updateUrlReaderTool: vi.fn(),
  updateDocumentParserTool: vi.fn(),
  getOfficeFilesTool: vi.fn(),
  updateOfficeFilesTool: vi.fn(),
  getInteractiveUiTool: vi.fn(),
  updateInteractiveUiTool: vi.fn(),
  getMapsTool: vi.fn(),
  updateMapsTool: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("~/modules/images/server/functions.ts", () => ({
  getImageGenerationTool: vi.fn(),
  updateImageGenerationTool: vi.fn(),
  listImageModels: vi.fn(async () => []),
  testImageModel: vi.fn(),
}));
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

type Provider = Awaited<ReturnType<typeof listSearchProviders>>[number];
const searchProvider = (
  id: string,
  settings: Provider["settings"],
  extra: Partial<Provider> = {},
): Provider => ({
  id,
  label: id,
  settings,
  enabled: true,
  position: 0,
  secretConfigured: settings.kind !== "searxng",
  createdAt: new Date(),
  updatedAt: new Date(),
  lastSuccessAt: null,
  lastError: null,
  coolingDownUntil: null,
  ...extra,
});
const defaultProviders = [
  searchProvider("Home SearXNG", { kind: "searxng", baseUrl: "http://searx" }),
  searchProvider("Tavily", { kind: "tavily" }),
];

const renderPage = ({
  webSearch = tool("web_search", { maxResults: 8 }),
  officeFiles = tool("office_files", {}),
  interactiveUi = tool("interactive_ui", { images: true }),
  maps = tool("maps", {}),
  providers = defaultProviders,
}: {
  webSearch?: ReturnType<typeof tool> | null;
  officeFiles?: ReturnType<typeof tool> | null;
  interactiveUi?: ReturnType<typeof tool> | null;
  maps?: ReturnType<typeof tool> | null;
  providers?: Provider[];
} = {}) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const memory = tool("memory", {});
  vi.mocked(getMemoryTool).mockResolvedValue(memory);
  vi.mocked(getWebSearchTool).mockResolvedValue(webSearch);
  vi.mocked(listSearchProviders).mockResolvedValue(providers);
  client.setQueryData(["admin", "tools", "search-providers"], providers);
  vi.mocked(getUrlReaderTool).mockResolvedValue(tool("read_url", { perPageCharCap: 12000 }));
  vi.mocked(getDocumentParserTool).mockResolvedValue(
    tool("document_parser", { maxChars: 120000, maxPages: 200 }),
  );
  client.setQueryData(["admin", "tools", "memory"], memory);
  client.setQueryData(["admin", "presentation-fonts"], []);
  client.setQueryData(["admin", "tools", "office-files"], officeFiles);
  client.setQueryData(["admin", "tools", "image-generation"], tool("image_generation", {}));
  client.setQueryData(["admin", "tools", "interactive-ui"], interactiveUi);
  client.setQueryData(["admin", "tools", "maps"], maps);
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

  it("switches interactive answers off, and their images with them", async () => {
    const user = userEvent.setup();
    vi.mocked(updateInteractiveUiTool).mockResolvedValue(undefined as never);
    renderPage();

    await user.click(screen.getByRole("switch", { name: "Images in interactive answers" }));
    await waitFor(() =>
      expect(updateInteractiveUiTool).toHaveBeenCalledWith({ data: { images: false } }),
    );
    await user.click(screen.getByRole("switch", { name: "Interactive answers enabled" }));
    await waitFor(() =>
      expect(updateInteractiveUiTool).toHaveBeenCalledWith({ data: { enabled: false } }),
    );
  });

  it("switches maps on their own and saves their services", async () => {
    const user = userEvent.setup();
    vi.mocked(updateMapsTool).mockResolvedValue(undefined as never);
    renderPage();
    // Maps are not part of interactive answers any more.
    expect(screen.queryByRole("switch", { name: "Maps in interactive answers" })).toBeNull();

    const routing = screen.getByLabelText("Routing");
    expect(routing).toHaveValue("https://routing.openstreetmap.de");
    await user.clear(routing);
    await user.type(routing, "https://osrm.example.org");
    await user.click(within(routing.closest("form")!).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(updateMapsTool).toHaveBeenCalledWith({
        data: {
          styleLight: "https://tiles.openfreemap.org/styles/positron",
          styleDark: "https://tiles.openfreemap.org/styles/dark",
          geocoder: "https://photon.komoot.io",
          routing: "https://osrm.example.org",
        },
      }),
    );

    await user.click(screen.getByRole("switch", { name: "Maps enabled" }));
    await waitFor(() => expect(updateMapsTool).toHaveBeenCalledWith({ data: { enabled: false } }));
  });

  it("keeps maps on while interactive answers are off", () => {
    renderPage({ interactiveUi: { ...tool("interactive_ui", { images: true }), enabled: false } });
    const maps = screen.getByRole("switch", { name: "Maps enabled" });
    expect(maps).toBeChecked();
    expect(maps).not.toHaveAttribute("aria-disabled", "true");
  });

  it("shows images as off while interactive answers are off", () => {
    renderPage({ interactiveUi: { ...tool("interactive_ui", { images: true }), enabled: false } });
    const images = screen.getByRole("switch", { name: "Images in interactive answers" });
    expect(images).not.toBeChecked();
    expect(images).toHaveAttribute("aria-disabled", "true");
  });

  it("submits the web search form on Enter and keeps the label while pending", async () => {
    const user = userEvent.setup();
    const pending = deferred<unknown>();
    vi.mocked(updateWebSearchTool).mockReturnValue(pending.promise as never);
    renderPage();

    await user.type(screen.getByLabelText("Max results per query"), "{Backspace}5{Enter}");

    await waitFor(() =>
      expect(updateWebSearchTool).toHaveBeenCalledWith({
        data: { maxResults: 5, researchMaxSearchQueries: 80 },
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
      webSearch: tool("web_search", { maxResults: 8, researchMaxSearchQueries: 40 }),
    });
    const cap = screen.getByLabelText("Search queries per research run");
    expect(cap).toHaveValue(40);
    await user.clear(cap);
    await user.type(cap, "60{Enter}");
    await waitFor(() =>
      expect(updateWebSearchTool).toHaveBeenCalledWith({
        data: { maxResults: 8, researchMaxSearchQueries: 60 },
      }),
    );
    const [save] = saveButtons();
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute("aria-busy", "true");
    expect(save).toHaveTextContent("Save");
    vi.mocked(getWebSearchTool).mockResolvedValue(
      tool("web_search", { maxResults: 8, researchMaxSearchQueries: 60 }),
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
    // The URL reader's own button confirms; the web search and map ones are untouched.
    expect(
      await within(cap.closest("form")!).findByRole("button", { name: "Saved" }),
    ).toBeInTheDocument();
    expect(saveButtons()).toHaveLength(2);
  });

  it("tests a provider from its dialog, keeping the label while testing", async () => {
    const user = userEvent.setup();
    const pending = deferred<{ ok: true; resultCount: number; latencyMs: number }>();
    vi.mocked(testSearchProvider).mockReturnValue(pending.promise as never);
    renderPage();

    await user.click(screen.getByRole("button", { name: "Edit Home SearXNG" }));
    const dialog = await screen.findByRole("dialog");
    const test = within(dialog).getByRole("button", { name: "Test" });
    await user.click(test);
    expect(testSearchProvider).toHaveBeenCalledWith({
      data: { id: "Home SearXNG", settings: { kind: "searxng", baseUrl: "http://searx" } },
    });
    expect(test).toHaveAttribute("aria-busy", "true");
    expect(test).toHaveTextContent("Test");

    pending.resolve({ ok: true, resultCount: 3, latencyMs: 42 });
    const status = await within(dialog).findByRole("status");
    expect(status).toHaveTextContent("Works: 3 results in 42ms.");
    expect(status).toHaveClass("text-success");
  });

  it("adds a SearXNG provider", async () => {
    const user = userEvent.setup();
    vi.mocked(createSearchProvider).mockResolvedValue(undefined as never);
    renderPage({ providers: [] });
    expect(screen.getByText("Add a provider to turn on web search.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add provider" }));
    const dialog = await screen.findByRole("dialog");
    const add = within(dialog).getByRole("button", { name: "Add provider" });
    expect(add).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Base URL"), "http://localhost:8081");
    await user.click(add);

    await waitFor(() =>
      expect(createSearchProvider).toHaveBeenCalledWith({
        data: { label: "SearXNG", settings: { kind: "searxng", baseUrl: "http://localhost:8081" } },
      }),
    );
  });

  it("keeps a stored key when a hosted provider is saved with the key field empty", async () => {
    const user = userEvent.setup();
    vi.mocked(updateSearchProvider).mockResolvedValue(undefined as never);
    renderPage();

    await user.click(screen.getByRole("button", { name: "Edit Tavily" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("API key")).toHaveAttribute("placeholder", "Unchanged");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateSearchProvider).toHaveBeenCalledWith({
        data: { id: "Tavily", label: "Tavily", settings: { kind: "tavily" } },
      }),
    );
  });

  it("saves the whole order when a provider moves", async () => {
    const user = userEvent.setup();
    vi.mocked(setSearchProviderOrder).mockResolvedValue(undefined as never);
    renderPage();

    expect(screen.getByRole("button", { name: "Move Home SearXNG up" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Move Tavily up" }));

    await waitFor(() =>
      expect(setSearchProviderOrder).toHaveBeenCalledWith({
        data: { ids: ["Tavily", "Home SearXNG"] },
      }),
    );
  });

  it("asks before removing a provider", async () => {
    const user = userEvent.setup();
    vi.mocked(deleteSearchProvider).mockResolvedValue(undefined as never);
    renderPage();

    await user.click(screen.getByRole("button", { name: "Remove Tavily" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm).toHaveTextContent("Remove Tavily?");
    expect(deleteSearchProvider).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole("button", { name: "Remove" }));

    await waitFor(() =>
      expect(deleteSearchProvider).toHaveBeenCalledWith({ data: { id: "Tavily" } }),
    );
  });

  it("says when a provider is being tried last and turns one off", async () => {
    const user = userEvent.setup();
    vi.mocked(updateSearchProvider).mockResolvedValue(undefined as never);
    renderPage({
      providers: [
        searchProvider(
          "Tavily",
          { kind: "tavily" },
          {
            lastError: { reason: "quota", message: "credits used up", at: 0 },
            coolingDownUntil: new Date(2026, 9, 2, 14, 5).getTime(),
          },
        ),
      ],
    });

    expect(screen.getByText(/Credits used up, tried last until/)).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "Tavily enabled" }));
    await waitFor(() =>
      expect(updateSearchProvider).toHaveBeenCalledWith({ data: { id: "Tavily", enabled: false } }),
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
