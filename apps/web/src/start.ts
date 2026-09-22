import { createStart } from "@tanstack/react-start";
import { reportUnexpectedFailures } from "~/server/unexpected-failure.ts";

export const startInstance = createStart(() => ({
  functionMiddleware: [reportUnexpectedFailures],
}));
