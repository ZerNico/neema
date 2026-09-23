import { createServerFn } from "@tanstack/react-start";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { runtime } from "~/server/runtime.ts";
import { FeaturePolicy } from "./policy.ts";

export const getMyCapabilities = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(({ context }) =>
    runtime.runPromise(FeaturePolicy.use((policy) => policy.forUser(context.session.user.id))),
  );
