import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Without `globals: true`, testing-library can't register its own auto-cleanup,
// so renders leak into the next test's queries.
afterEach(cleanup);

// jsdom lays nothing out, and has no layout methods on ranges; ProseMirror (the
// composer, the document editor) measures the selection to keep it in view.
// An element's empty rect list stands in.
Range.prototype.getClientRects = () => document.createElement("div").getClientRects();
Range.prototype.getBoundingClientRect = () => new DOMRect();
// A click in an editor asks what lies under the pointer; with no layout, nothing does.
if (typeof document.elementFromPoint !== "function") document.elementFromPoint = () => null;

// jsdom has a DOM but no ResizeObserver, and dnd-kit (the panel's sortable tabs)
// subclasses it when imported wherever a DOM exists. Nothing is laid out, so
// there is never a size change to report.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
