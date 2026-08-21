import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Without `globals: true`, testing-library can't register its own auto-cleanup,
// so renders leak into the next test's queries.
afterEach(cleanup);
