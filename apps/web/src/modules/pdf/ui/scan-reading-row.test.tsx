import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getScanReading,
  retryOcrModelDownload,
  testMistralOcr,
  updateScanReading,
} from "~/modules/tools/server/functions.ts";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import { ScanReadingRow } from "./scan-reading-row.tsx";

vi.mock("~/modules/tools/server/functions.ts", () => ({
  getScanReading: vi.fn(),
  updateScanReading: vi.fn(async () => undefined),
  retryOcrModelDownload: vi.fn(async () => undefined),
  testMistralOcr: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

type Settings = NonNullable<Awaited<ReturnType<typeof getScanReading>>>;
const settings = (overrides: Partial<Settings> = {}): Settings => ({
  scans: { mode: "off" },
  keyConfigured: false,
  localFiles: { accurate: { state: "missing" }, fast: { state: "missing" } },
  visionModels: [{ id: "vision-1", displayName: "Vision One", providerName: "OpenRouter" }],
  needsApproval: false,
  ...overrides,
});

const renderRow = (data: Settings) => {
  vi.mocked(getScanReading).mockResolvedValue(data);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <Suspense fallback={null}>
          <ScanReadingRow disabled={false} />
        </Suspense>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
};

const choose = async (label: string, option: string) => {
  await userEvent.click(await screen.findByRole("combobox", { name: label }));
  await userEvent.click(await screen.findByRole("option", { name: new RegExp(`^${option}`) }));
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ScanReadingRow", () => {
  it("saves reading on this server without asking, since nothing leaves it", async () => {
    renderRow(settings());
    await choose("OCR provider", "Local");
    expect(screen.getByText("Runs on this server. Pages never leave it.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Not downloaded yet");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(updateScanReading).toHaveBeenCalledWith({
        data: { scans: { mode: "local", quality: "accurate" } },
      }),
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("asks before sending pages to the OCR service, naming its host, and sends the typed key", async () => {
    renderRow(settings());
    await choose("OCR provider", "Mistral OCR");
    const save = screen.getByRole("button", { name: "Save" });
    // No stored key and none typed: nothing to save yet.
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByLabelText("API key"), "sk-test");
    await userEvent.click(save);
    expect(
      await screen.findByRole("alertdialog", { name: "Send scanned pages to api.mistral.ai?" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Send pages" }));
    await waitFor(() =>
      expect(updateScanReading).toHaveBeenCalledWith({
        data: {
          scans: { mode: "mistral" },
          secret: "sk-test",
        },
      }),
    );
  });

  it("never shows a stored key, and tests with it when none is typed", async () => {
    vi.mocked(testMistralOcr).mockResolvedValue({ ok: true, latencyMs: 812 });
    renderRow(
      settings({
        scans: { mode: "mistral", baseUrl: "https://ocr.example.eu/v1" },
        keyConfigured: true,
      }),
    );
    expect(await screen.findByLabelText("API key")).toHaveValue("");
    expect(screen.getByLabelText("API key")).toHaveAttribute("placeholder", "Unchanged");
    await userEvent.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByText("Works: read the sample page in 812ms.")).toBeInTheDocument();
    expect(testMistralOcr).toHaveBeenCalledWith({ data: { baseUrl: "https://ocr.example.eu/v1" } });
  });

  it("offers a retry when the model files failed to download", async () => {
    renderRow(
      settings({
        scans: { mode: "local", quality: "fast" },
        localFiles: {
          accurate: { state: "missing" },
          fast: { state: "failed", error: "the download answered 503" },
        },
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Download failed: the download answered 503",
    );
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(retryOcrModelDownload).toHaveBeenCalledWith({ data: { quality: "fast" } }),
    );
  });

  it("says when a chosen model must be approved again, and lets Save approve it", async () => {
    renderRow(settings({ scans: { mode: "model", modelId: "vision-1" }, needsApproval: true }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Save to approve it again");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await userEvent.click(await screen.findByRole("button", { name: "Send pages" }));
    await waitFor(() =>
      expect(updateScanReading).toHaveBeenCalledWith({
        data: { scans: { mode: "model", modelId: "vision-1" } },
      }),
    );
  });
});
