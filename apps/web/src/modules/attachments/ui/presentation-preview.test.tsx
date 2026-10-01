import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AttachmentPreviewDialog } from "./attachment-preview.tsx";
import { officePreview } from "./office-preview.ts";

afterEach(() => vi.unstubAllGlobals());

it("reserves a full slide frame while loading, then uses the deck’s actual ratio", async () => {
  let respond!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>((resolve) => (respond = resolve))),
  );
  render(
    <AttachmentPreviewDialog
      open
      onOpenChange={() => {}}
      target={{
        fileName: "Old deck.pptx",
        size: 1024,
        kind: "file",
        url: "/api/files/deck",
        office: { type: "presentation", source: { kind: "attachment", id: "deck" } },
      }}
    />,
  );
  const placeholder = screen.getByRole("status", { name: "Loading slides" }).parentElement;
  expect(placeholder).toHaveStyle({ aspectRatio: String(16 / 9) });
  respond(Response.json({ slideIds: [256], aspectRatio: 4 / 3 }));
  expect(await screen.findByText("Slide 1 of 1")).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "Slide 1 of 1" }).parentElement).toHaveStyle({
    aspectRatio: String(4 / 3),
  });
});

it("pages slides with the arrow keys while focus sits on the dialog's download link", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ slideIds: [256, 257] })),
  );
  render(
    <AttachmentPreviewDialog
      open
      onOpenChange={() => {}}
      target={{
        fileName: "Deck.pptx",
        size: 1024,
        kind: "file",
        url: "/api/files/deck",
        office: { type: "presentation", source: { kind: "attachment", id: "deck" } },
      }}
    />,
  );
  expect(await screen.findByText("Slide 1 of 2")).toBeInTheDocument();
  fireEvent.load(screen.getByRole("img", { name: "Slide 1 of 2" }));
  const download = screen.getByRole("link", { name: /download|open original/i });
  download.focus();
  // The dialog stops keydown from bubbling past it, as it does in a browser.
  fireEvent.keyDown(download, { key: "ArrowRight" });
  expect(screen.getByText("Slide 2 of 2")).toBeInTheDocument();
  // Changing slides replaces the old picture with a loading state immediately.
  expect(screen.getByRole("status", { name: "Loading slide" })).toBeInTheDocument();
  const next = screen.getByRole("img", { name: "Slide 2 of 2" });
  expect(document.querySelectorAll("img")).toHaveLength(1);
  expect(next).toHaveClass("opacity-0");
  fireEvent.load(next);
  expect(screen.queryByRole("status", { name: "Loading slide" })).toBeNull();
  expect(next).toHaveClass("opacity-100");
  fireEvent.keyDown(download, { key: "ArrowLeft" });
  expect(screen.getByText("Slide 1 of 2")).toBeInTheDocument();
  expect(screen.queryByText(/approximate/i)).toBeNull();
});

it("previews a deck or workbook by its media type, or by its extension when the type says nothing", () => {
  const source = { kind: "attachment", id: "file" } as const;
  const pptx = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  const deck = { type: "presentation", source };
  expect(officePreview({ fileName: "export.bin", mediaType: pptx }, source)).toEqual(deck);
  expect(officePreview({ fileName: "Deck.PPTX" }, source)).toEqual(deck);
  expect(
    officePreview({ fileName: "Deck.pptx", mediaType: "application/octet-stream" }, source),
  ).toEqual(deck);
  expect(officePreview({ fileName: "notes.pptx", mediaType: "text/plain" }, source)).toBeNull();
  expect(officePreview({ fileName: "Sheet.xlsx" }, source)).toEqual({
    type: "spreadsheet",
    source,
  });
  expect(officePreview({ fileName: "Sheet.csv" }, source)).toBeNull();
});

it("reports a deck it cannot load as an alert", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("Broken", { status: 422 })),
  );
  render(
    <AttachmentPreviewDialog
      open
      onOpenChange={() => {}}
      target={{
        fileName: "Broken.pptx",
        size: 1024,
        kind: "file",
        url: "/api/files/broken",
        office: { type: "presentation", source: { kind: "attachment", id: "broken" } },
      }}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not load this presentation.");
});
