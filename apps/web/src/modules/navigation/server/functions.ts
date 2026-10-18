import { createServerFn } from "@tanstack/react-start";
import { Schema } from "effect";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { runServerFn } from "~/server/run-server-fn.ts";
import { UpdateSidebarPinsInput } from "../schema.ts";
import { SidebarPinsService } from "./service.ts";

export const getSidebarPins = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(({ context }) =>
    runServerFn(SidebarPinsService.use((service) => service.get(context.session.user.id))),
  );

export const updateSidebarPins = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(UpdateSidebarPinsInput))
  .handler(({ data, context }) =>
    runServerFn(
      SidebarPinsService.use((service) => service.set(context.session.user.id, data.pinned)),
    ),
  );
