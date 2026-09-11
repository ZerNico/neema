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
