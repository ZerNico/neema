import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeAdminPage } from "./knowledge-admin-page.tsx";
import { getScanReading, updateToolSettings } from "~/modules/tools/server/functions.ts";
import type { PublicTool } from "~/modules/tools/server/repo.ts";
import { configureEmbeddings, rebuildAllKnowledgeIndexes } from "../server/functions.ts";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import { scanReadingQuery } from "~/modules/tools/client/queries.ts";
import { toast } from "sonner";

vi.mock("../server/functions.ts", () => ({
  getEmbeddingConfiguration: vi.fn(),
  configureEmbeddings: vi.fn(),
  disableEmbeddings: vi.fn(),
  rebuildAllKnowledgeIndexes: vi.fn(),
}));
vi.mock("~/modules/tools/server/functions.ts", () => ({
  getScanReading: vi.fn(),
  updateScanReading: vi.fn(),
  retryOcrModelDownload: vi.fn(),
  testMistralOcr: vi.fn(),
  getToolSettings: vi.fn(),
  listSearchProviders: vi.fn(),
  createSearchProvider: vi.fn(),
  updateSearchProvider: vi.fn(),
  deleteSearchProvider: vi.fn(),
  setSearchProviderOrder: vi.fn(),
  testSearchProvider: vi.fn(),
  updateToolSettings: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...rest }: Record<string, unknown> & { children?: unknown }) => (
    <a href={String(to)} {...(rest as object)}>
      {children as never}
    </a>
  ),
}));
vi.stubGlobal(
  "matchMedia",
  vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
);

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const parserTool: PublicTool = {
  id: "document_parser",
  name: "document_parser",
  kind: "local",
  enabled: true,
  config: { maxChars: 120000, maxPages: 200 },
  secretConfigured: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const MODEL = {
  id: "embed-1",
  displayName: "Qwen3 Embedding 8B",
  providerName: "OpenRouter",
  dimensions: 4096,
};

const embeddings = (
  overrides: Partial<{
    enabled: boolean;
    status: "disabled" | "ready" | "needs_approval";
    embeddingModelId: string | null;
    dimensions: number | null;
    spaceId: string | null;
    models: Array<typeof MODEL>;
  }> = {},
) => ({
  enabled: overrides.enabled ?? false,
  status: overrides.status ?? "disabled",
  config: {
    spaceId: overrides.spaceId ?? null,
    embeddingModelId: overrides.embeddingModelId ?? null,
    dimensions: overrides.dimensions ?? null,
    connectionRevision: overrides.spaceId ? "rev-1" : null,
    approvedConnection: overrides.spaceId
      ? {
          providerId: "p1",
          baseUrl: "https://openrouter.ai/api/v1",
          modelKey: "qwen/qwen3-embedding-8b",
          modelDimensions: overrides.dimensions ?? null,
          preprocessingRevision: 1,
        }
      : null,
  },
  models: overrides.models ?? [MODEL],
});

const scanSettings: NonNullable<Awaited<ReturnType<typeof getScanReading>>> = {
  scans: { mode: "off" },
  keyConfigured: false,
  localFiles: { accurate: { state: "missing" }, fast: { state: "missing" } },
  visionModels: [],
  needsApproval: false,
};

const renderPage = (config = embeddings()) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["admin", "tools", "embeddings"], config);
  client.setQueryData(["admin", "tools", "document-parser"], parserTool);
  client.setQueryData(scanReadingQuery.queryKey, scanSettings);
  return render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <Suspense fallback={null}>
          <KnowledgeAdminPage />
        </Suspense>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("KnowledgeAdminPage", () => {
  it("shows the embedding model by name, not id, and its actions left-aligned like every other section", () => {
    renderPage(
      embeddings({
        enabled: true,
        status: "ready",
        embeddingModelId: MODEL.id,
        dimensions: 4096,
        spaceId: "s1",
      }),
    );
    const trigger = screen.getByRole("combobox", { name: "Embedding model" });
    expect(trigger).toHaveTextContent("Qwen3 Embedding 8BOpenRouter");
    expect(trigger).not.toHaveTextContent("embed-1");
    const actions = screen.getByRole("button", { name: "Apply" }).parentElement!;
    expect(actions.className).not.toMatch(/justify-end/);
    expect(screen.getByRole("button", { name: "Rebuild all" })).toBeInTheDocument();
  });

  it("confirms before enabling, spelling out where document text goes", async () => {
    const user = userEvent.setup();
    vi.mocked(configureEmbeddings).mockResolvedValue({} as never);
    renderPage();
    await user.click(screen.getByRole("combobox", { name: "Embedding model" }));
    await user.click(await screen.findByRole("option", { name: /Qwen3 Embedding 8B/ }));
    await user.click(screen.getByRole("button", { name: "Enable" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(/sent to Qwen3 Embedding 8B · OpenRouter/);
    await user.click(within(dialog).getByRole("button", { name: "Enable" }));
    await waitFor(() =>
      expect(configureEmbeddings).toHaveBeenCalledWith({
        data: { modelId: MODEL.id, dimensions: 4096, decision: "rebuild", expectedRevision: null },
      }),
    );
  });

  it("rebuilds every collection only after confirmation and reports the totals", async () => {
    const user = userEvent.setup();
    vi.mocked(rebuildAllKnowledgeIndexes).mockResolvedValue({
      collections: 3,
      reextracted: 1,
      reembedded: 4,
    });
    renderPage(
      embeddings({
        enabled: true,
        status: "ready",
        embeddingModelId: MODEL.id,
        dimensions: 4096,
        spaceId: "s1",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Rebuild all" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(/across everyone's collections/);
    expect(rebuildAllKnowledgeIndexes).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Rebuild all" }));
    await waitFor(() => expect(rebuildAllKnowledgeIndexes).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Rebuilding 5 documents across 3 collections in the background.",
      ),
    );
  });

  it.each(["Cancel", "Escape"])(
    "does not approve on compatibility dialog %s",
    async (dismissal) => {
      const user = userEvent.setup();
      renderPage(
        embeddings({
          enabled: true,
          status: "needs_approval",
          embeddingModelId: MODEL.id,
          dimensions: 4096,
          spaceId: "s1",
        }),
      );
      await user.click(screen.getByRole("button", { name: "Apply" }));
      const dialog = await screen.findByRole("dialog");
      if (dismissal === "Escape") await user.keyboard("{Escape}");
      else await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(configureEmbeddings).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["Keep existing embeddings", "keep"],
    ["Rebuild instead", "rebuild"],
  ] as const)("allows same-model reapproval through %s", async (label, decision) => {
    const user = userEvent.setup();
    renderPage(
      embeddings({
        enabled: true,
        status: "needs_approval",
        embeddingModelId: MODEL.id,
        dimensions: 4096,
        spaceId: "s1",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: label }),
    );
    await waitFor(() =>
      expect(configureEmbeddings).toHaveBeenCalledWith({
        data: { modelId: MODEL.id, dimensions: 4096, decision, expectedRevision: "rev-1" },
      }),
    );
    expect(rebuildAllKnowledgeIndexes).not.toHaveBeenCalled();
  });

  it("never borrows the previous model's dimensions", () => {
    renderPage(
      embeddings({
        enabled: true,
        status: "needs_approval",
        embeddingModelId: MODEL.id,
        dimensions: 4096,
        spaceId: "s1",
        models: [{ ...MODEL, dimensions: null as never }],
      }),
    );
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Set the model’s dimensions");
  });

  it("submits the document parser form on Enter and flags a non-integer page count", async () => {
    const user = userEvent.setup();
    const pending = deferred<unknown>();
    vi.mocked(updateToolSettings).mockReturnValue(pending.promise as never);
    renderPage();

    const pages = screen.getByLabelText("Max pages");
    await user.clear(pages);
    await user.type(pages, "2.5{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a whole number.");
    expect(updateToolSettings).not.toHaveBeenCalled();

    await user.clear(pages);
    await user.type(pages, "300{Enter}");
    await waitFor(() =>
      expect(updateToolSettings).toHaveBeenCalledWith({
        data: { tool: "document_parser", maxChars: 120000, maxPages: 300 },
      }),
    );
    const save = within(pages.closest("form")!).getByRole("button", { name: "Save" });
    expect(save).toHaveAttribute("aria-busy", "true");
    expect(save.querySelector('[data-slot="spinner"]')).toBeInTheDocument();
    expect(save).toHaveTextContent("Save");
    pending.resolve(undefined);
    await waitFor(() => expect(save).not.toHaveAttribute("aria-busy"));
  });
});
