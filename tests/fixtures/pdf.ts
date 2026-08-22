// Hand-built single-line-per-page PDFs. A real fixture file would be opaque
// binary in the repo; this keeps the input to the parser tests readable and
// lets each test pick its own page count and content.
const escape = (text: string) => text.replace(/([()\\])/g, "\\$1");

export const buildPdf = (pages: ReadonlyArray<string>): Uint8Array => {
  let nextId = 3;
  const laid = pages.map((text) => ({ text, contentId: nextId++, pageId: nextId++ }));
  const fontId = nextId;

  const objects: string[] = [
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`,
    `2 0 obj\n<< /Type /Pages /Kids [${laid
      .map((page) => `${page.pageId} 0 R`)
      .join(" ")}] /Count ${laid.length} >>\nendobj\n`,
  ];
  for (const page of laid) {
    const stream = `BT /F1 12 Tf 72 720 Td (${escape(page.text)}) Tj ET`;
    objects.push(
      `${page.contentId} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
      `${page.pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${page.contentId} 0 R >>\nendobj\n`,
    );
  }
  objects.push(`${fontId} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);

  let pdf = "%PDF-1.4\n";
  const offsets = new Map<number, number>();
  for (const object of objects) {
    offsets.set(Number(object.slice(0, object.indexOf(" "))), pdf.length);
    pdf += object;
  }

  const startXref = pdf.length;
  pdf += `xref\n0 ${fontId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= fontId; id++) {
    pdf += `${String(offsets.get(id) ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${fontId + 1} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
};

/** A structurally valid PDF whose only page carries no text operators. */
export const buildEmptyPdf = (): Uint8Array => buildPdf([""]);
