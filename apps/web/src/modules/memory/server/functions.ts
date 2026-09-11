import { createServerFn } from "@tanstack/react-start";
import { Schema } from "effect";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { runtime } from "~/server/runtime.ts";
import {
  CreateMemoryInput,
  DeleteMemoryInput,
  UpdateMemoryInput,
  UpdateMemorySettingsInput,
} from "../schema.ts";
import { MemoryService } from "./service.ts";

const standard = Schema.toStandardSchemaV1;

export const getMemorySettings = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(({ context }) =>
    runtime.runPromise(
      MemoryService.use((service) => service.getSettings(context.session.user.id)),
    ),
  );

export const updateMemorySettings = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(UpdateMemorySettingsInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      MemoryService.use((service) => service.updateSettings(context.session.user.id, data)),
    ),
  );

export const listMemories = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(({ context }) =>
    runtime.runPromise(MemoryService.use((service) => service.list(context.session.user.id))),
  );

export const createMemory = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(CreateMemoryInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      MemoryService.use((service) => service.createManual(context.session.user.id, data.content)),
    ),
  );

export const updateMemory = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(UpdateMemoryInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      MemoryService.use((service) => service.updateManual(context.session.user.id, data)),
    ),
  );

export const deleteMemory = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(DeleteMemoryInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      MemoryService.use((service) => service.delete(context.session.user.id, data.memoryId)),
    ),
  );

export const clearMemories = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .handler(({ context }) =>
    runtime.runPromise(MemoryService.use((service) => service.clear(context.session.user.id))),
  );
