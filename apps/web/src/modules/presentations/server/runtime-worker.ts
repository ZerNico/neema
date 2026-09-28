import { parentPort } from "node:worker_threads";
import { PresentationError } from "../errors.ts";
import {
  checkFontFile,
  createPresentationDraft,
  editPresentation,
  inspectPresentation,
  renderPresentation,
} from "./adapter.ts";
import { resetFonts } from "./render.ts";
import type { PresentationReply, PresentationWork, PresentationWorkResult } from "./runtime.ts";

if (!parentPort) throw new Error("Presentation worker requires a worker thread.");
const port = parentPort;

async function perform(request: PresentationWork): Promise<PresentationWorkResult> {
  switch (request.kind) {
    case "create":
      return { kind: "bytes", bytes: await createPresentationDraft() };
    case "inspect":
      return {
        kind: "inspection",
        inspection: await inspectPresentation(request.bytes, request.scope),
      };
    case "edit":
      return {
        kind: "edited",
        ...(await editPresentation(
          request.bytes,
          request.operations,
          request.fonts,
          request.catalog ? { catalog: true } : {},
        )),
      };
    case "render":
      return {
        kind: "rendered",
        slides: await renderPresentation(request.bytes, request.slideIds, request.fonts),
      };
    case "font":
      return { kind: "font", info: await checkFontFile(request.path) };
  }
}

/** Result buffers move back to the parent; only whole buffers this task made are movable. */
const movable = (views: readonly Uint8Array[]) =>
  views.flatMap((view) =>
    view.buffer instanceof ArrayBuffer &&
    view.byteOffset === 0 &&
    view.byteLength === view.buffer.byteLength
      ? [view.buffer]
      : [],
  );

// One task at a time: the pool sends the next request only after this reply.
port.on("message", async (request: PresentationWork & { readonly id: number }) => {
  let reply: PresentationReply;
  let transfer: ArrayBuffer[] = [];
  try {
    const result = await perform(request);
    reply = { id: request.id, ok: true, result };
    transfer = movable(
      result.kind === "bytes" || result.kind === "edited"
        ? [result.bytes]
        : result.kind === "rendered"
          ? result.slides.map((slide) => slide.png)
          : [],
    );
  } catch (error) {
    reply = {
      id: request.id,
      ok: false,
      code: error instanceof PresentationError ? error.code : "processing_error",
      message: error instanceof PresentationError ? error.message : "PowerPoint processing failed.",
    };
  } finally {
    // Font registration is module state; no task may inherit another's.
    resetFonts();
  }
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker ports do not accept target origins.
  port.postMessage(reply, transfer);
});
