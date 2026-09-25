import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Without `globals: true`, testing-library can't register its own auto-cleanup,
// so renders leak into the next test's queries.
afterEach(cleanup);

// jsdom has no PointerEvent, but Base UI re-dispatches clicks as one (e.g.
// SwitchRoot's dispatchClickWithModifiers). MouseEvent is shape-compatible
// for everything the components read.
if (typeof globalThis.PointerEvent === "undefined") {
  globalThis.PointerEvent = class PointerEvent extends MouseEvent {} as never;
}

// jsdom lays nothing out, and has no layout methods on ranges; ProseMirror (the
// composer, the document editor) measures the selection to keep it in view.
// An element's empty rect list stands in.
Range.prototype.getClientRects = () => document.createElement("div").getClientRects();
Range.prototype.getBoundingClientRect = () => new DOMRect();
// A click in an editor asks what lies under the pointer; with no layout, nothing does.
if (typeof document.elementFromPoint !== "function") document.elementFromPoint = () => null;
