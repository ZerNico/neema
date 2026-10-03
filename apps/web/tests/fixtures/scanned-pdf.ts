import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts } from "pdf-lib";

/** A page as a scanner makes it: a photo of text and nothing else, or an empty sheet. */
export type FixturePage =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "scan"; readonly text: string; readonly stamp?: string }
  | { readonly kind: "outlined" }
  | { readonly kind: "blank" };

const WIDTH = 595;
const HEIGHT = 842;

/** Black text on off-white paper, as a scan's image. */
const scanImage = async (text: string) => {
  const canvas = createCanvas(WIDTH * 2, HEIGHT * 2);
  const context = canvas.getContext("2d");
  context.fillStyle = "#f4f1ea";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#111111";
  context.font = "48px sans-serif";
  context.fillText(text, 120, 300);
  return new Uint8Array(await canvas.encode("png"));
};

/**
 * A PDF with the given pages, built in the test so no binary fixture is
 * committed: text pages have a text layer, scans are one full-page image,
 * an outlined page draws shapes with no text layer, and a blank page is empty.
 */
export async function buildScannedPdf(pages: ReadonlyArray<FixturePage>) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const spec of pages) {
    const page = document.addPage([WIDTH, HEIGHT]);
    if (spec.kind === "text") page.drawText(spec.text, { x: 72, y: 720, size: 12, font });
    else if (spec.kind === "scan") {
      const image = await document.embedPng(await scanImage(spec.text));
      page.drawImage(image, { x: 0, y: 0, width: WIDTH, height: HEIGHT });
      if (spec.stamp) page.drawText(spec.stamp, { x: 20, y: 20, size: 6, font });
    } else if (spec.kind === "outlined")
      for (let row = 0; row < 12; row++)
        page.drawRectangle({ x: 72, y: 700 - row * 40, width: 400, height: 14 });
  }
  return new Uint8Array(await document.save());
}
