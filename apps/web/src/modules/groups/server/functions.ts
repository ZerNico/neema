import { createServerFn } from "@tanstack/react-start";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { runServerFn } from "~/server/run-server-fn.ts";
import { FeaturePolicy } from "./policy.ts";

export const getMyCapabilities = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(({ context }) =>
    runServerFn(FeaturePolicy.use((policy) => policy.forUser(context.session.user.id))),
  );
