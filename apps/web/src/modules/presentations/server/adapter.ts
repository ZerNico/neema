import {
  addSlide,
  createPresentation,
  getSlideLayoutName,
  getSlideLayouts,
  getSlidePartName,
  getSlides,
  loadPresentation,
  savePresentation,
  setPresentationTheme,
} from "@office-kit/pptx";
import { zipSync } from "fflate";
import { PresentationError } from "../errors.ts";
import { parsePresentationOperations } from "../operations.ts";
import { readPresentationArchive } from "./archive.ts";
import type { FontFace } from "./font-file.ts";
import { inspectPackage, templateOwners } from "./inspection.ts";
import { auditOverflow, compareOverflow, needsAudit } from "./overflow.ts";
import { openPackage } from "./package.ts";
import { fail, toPart } from "./package-xml.ts";
import { deckTypefaces, facesFor, operationTypefaces } from "./font-usage.ts";
import { prepareFonts } from "./render.ts";
import { apply, flush, startSession, worksOnParts, type Refs } from "./session.ts";
import { applyDeckTemplate, DEFAULT_THEME } from "./template.ts";

/**
 * The engine's entry points, each run inside a presentation worker: create a
 * deck, edit one atomically, inspect and render. The work itself lives in
 * `package` (open and validate), `session` (operations), `inspection`,
 * `overflow` and `render`.
 */
export { inspectPresentation } from "./inspection.ts";
export { checkFontFile, renderPresentation } from "./render.ts";

export async function createPresentationDraft(): Promise<Uint8Array> {
  const blank = createPresentation({ size: "16:9" });
  setPresentationTheme(blank, DEFAULT_THEME);
  const parts = readPresentationArchive(await savePresentation(blank));
  applyDeckTemplate(parts);
  const deck = await loadPresentation(zipSync(Object.fromEntries(parts)));
  const title = getSlideLayouts(deck).find(
    (layout) => getSlideLayoutName(layout) === "Title Slide",
  );
  if (!title) return fail("unsupported_content", "The standard Title Slide layout is missing.");
  addSlide(deck, { layout: title });
  const bytes = await savePresentation(deck);
  await openPackage(bytes);
  return bytes;
}

export async function editPresentation(
  input: Uint8Array,
  rawOperations: unknown,
  fonts: readonly FontFace[] = [],
  options: { readonly catalog?: boolean } = {},
) {
  const operations = parsePresentationOperations(rawOperations);
  const refs: Refs = {
    slides: new Map(),
    shapes: new Map(),
    touched: new Set(),
    created: new Set(),
  };
  let session = await startSession(input);
  // Moving, removing or annotating slides cannot change how text fits, so those edits skip the audit.
  const audit = needsAudit(operations)
    ? await prepareFonts(
        facesFor(
          fonts,
          new Set([...deckTypefaces(session.parts), ...operationTypefaces(operations)]),
        ),
      )
    : null;
  const baseline = audit
    ? auditOverflow(audit.preview, session.deck, session.ids, audit.measureText, true)
    : null;
  refs.slides.set("first", session.ids.get(toPart(getSlidePartName(getSlides(session.deck)[0]!)))!);
  const describe = (from: number, to: number) =>
    from === to ? `operations[${from}] ${operations[from]!.kind}` : `operations[${from}]–[${to}]`;
  const failed = (error: unknown, path: string) => {
    if (error instanceof PresentationError)
      return new PresentationError(error.code, `${path}: ${error.message}`);
    const detail = error instanceof Error ? error.message.slice(0, 200) : "";
    return new PresentationError(
      "processing_error",
      `${path}: PowerPoint could not apply this change.${detail ? ` ${detail}` : ""}`,
    );
  };
  // The first operation whose change is still unsaved, for naming a failed save.
  let pending = 0;
  const settle = async (through: number) => {
    try {
      session = await flush(session);
    } catch (error) {
      throw failed(error, describe(pending, through));
    }
  };
  for (const [index, operation] of operations.entries()) {
    if (worksOnParts(operation)) await settle(index - 1);
    if (!session.dirty) pending = index;
    try {
      session = await apply(session, operation, refs);
    } catch (error) {
      throw failed(error, describe(index, index));
    }
  }
  await settle(operations.length - 1);
  // The last verified revision is the result; nothing is opened again to describe it.
  const inspection = inspectPackage(session, {
    slides: "all",
    ...(options.catalog ? { catalog: true } : {}),
  });
  const touched = refs.touched;
  const changedSlideIds = inspection.slides
    .map((slide) => slide.slideId)
    .filter((id) => !touched || touched.has(id));
  const feedback = compareOverflow(
    baseline,
    audit
      ? auditOverflow(audit.preview, session.deck, session.ids, audit.measureText, false)
      : null,
    changedSlideIds,
    refs.created,
  );
  refs.slides.delete("first");
  return {
    bytes: session.bytes,
    inspection: {
      ...inspection,
      templateOwners: templateOwners(
        session,
        inspection.slides.filter((slide) => changedSlideIds.includes(slide.slideId)),
      ),
    },
    changedSlideIds,
    ...feedback,
    refs: { slides: Object.fromEntries(refs.slides), shapes: Object.fromEntries(refs.shapes) },
  };
}
