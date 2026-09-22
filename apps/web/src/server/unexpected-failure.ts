import { isNotFound, isRedirect } from "@tanstack/react-router";
import { createMiddleware } from "@tanstack/react-start";
import { Effect } from "effect";
import { newErrorReference, unexpectedFailureBody } from "~/server-error.ts";

/**
 * Runs first on every server function. A thrown `Response` is a deliberate
 * answer and passes through; anything else is a failure nobody planned for,
 * whose message can carry SQL or settings. It is logged in full under a short
 * reference and the client gets only a friendly line and that reference.
 */
export const reportUnexpectedFailures = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    try {
      return await next();
    } catch (error) {
      if (error instanceof Response || isRedirect(error) || isNotFound(error)) throw error;
      const reference = newErrorReference((length) =>
        crypto.getRandomValues(new Uint8Array(length)),
      );
      // Imported here, inside the server-only body, so the client bundle
      // never pulls in the runtime module and its database layer.
      const { runtime } = await import("./runtime.ts");
      await runtime.runPromise(
        Effect.logError("unexpected server function failure", error).pipe(
          Effect.annotateLogs({ reference }),
        ),
      );
      throw new Response(unexpectedFailureBody(reference), { status: 500 });
    }
  },
);
