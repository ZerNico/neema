import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Suspense } from "react";
import { toast } from "sonner";
import { beforeEach, expect, it, vi } from "vitest";
import { ConfirmProvider } from "~/ui/confirm.tsx";
import {
  deletePresentationFont,
  listPresentationFonts,
  uploadPresentationFont,
} from "../server/font-functions.ts";
import { PresentationFontsRow } from "./presentation-fonts.tsx";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("../server/font-functions.ts", () => ({
  listPresentationFonts: vi.fn(),
  uploadPresentationFont: vi.fn(),
  deletePresentationFont: vi.fn(),
}));

const font = {
  id: "f1",
  family: "Brand Sans",
  style: "Bold",
  bold: true,
  italic: false,
  embeddable: false,
  fileName: "BrandSans-Bold.ttf",
  byteSize: 120_000,
  createdAt: new Date().toISOString(),
};
const renderRow = (fonts: (typeof font)[]) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["admin", "presentation-fonts"], fonts);
  return render(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <Suspense fallback={null}>
          <PresentationFontsRow />
        </Suspense>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listPresentationFonts).mockResolvedValue([]);
});

it("lists faces with their style and warns when the licence forbids embedding", () => {
  renderRow([font]);
  expect(screen.getByText("Brand Sans")).toBeInTheDocument();
  expect(screen.getByText(/Bold · 117 KB · licence forbids embedding/)).toBeInTheDocument();
});

it("uploads each chosen file on its own, naming one that fails, and removes a face after confirming", async () => {
  vi.mocked(uploadPresentationFont)
    .mockRejectedValueOnce(new Error("Not a font"))
    .mockResolvedValue({ ...font, embeddable: true });
  vi.mocked(listPresentationFonts).mockResolvedValue([font]);
  const { container } = renderRow([font]);
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  const files = [new File(["a"], "A.ttf"), new File(["b"], "B.otf")];
  fireEvent.change(input, { target: { files } });
  await waitFor(() => expect(uploadPresentationFont).toHaveBeenCalledTimes(2));
  const sent = vi
    .mocked(uploadPresentationFont)
    .mock.calls.map(([call]) => ((call as { data: FormData }).data.get("file") as File).name);
  expect(sent).toEqual(["A.ttf", "B.otf"]);
  expect(toast.error).toHaveBeenCalledTimes(1);
  expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toBe("Could not add the font “A.ttf”.");

  fireEvent.click(screen.getByRole("button", { name: "Remove Brand Sans Bold" }));
  expect(await screen.findByText("Remove “Brand Sans” bold?")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Remove font" }));
  await waitFor(() => expect(deletePresentationFont).toHaveBeenCalledWith({ data: { id: "f1" } }));
});

it("uploads fonts dropped anywhere on the row", async () => {
  vi.mocked(uploadPresentationFont).mockResolvedValue({ ...font, embeddable: true });
  const { container } = renderRow([]);
  expect(screen.getByText(/None yet/)).toBeInTheDocument();
  const zone = container.querySelector('[data-drop-zone="fonts"]')!;
  const overlay = zone.lastElementChild!;
  const files = [new File(["a"], "Dropped.ttf")];
  const dataTransfer = { types: ["Files"], files };
  fireEvent.dragEnter(zone, { dataTransfer });
  expect(overlay.getAttribute("aria-hidden")).toBe("false");
  fireEvent.drop(zone, { dataTransfer });
  await waitFor(() => expect(uploadPresentationFont).toHaveBeenCalledTimes(1));
  expect(overlay.getAttribute("aria-hidden")).toBe("true");
});
