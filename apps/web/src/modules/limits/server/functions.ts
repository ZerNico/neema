import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireAdmin, requireSession } from "~/modules/auth/server/middleware.ts";
import { runServerFn } from "~/server/run-server-fn.ts";
import {
  EveryoneStorageInput,
  GroupStorageInput,
  LimitIdInput,
  LibraryFileInput,
  SaveLimitInput,
  TimeZoneInput,
} from "../schema.ts";
import { UsageLimits } from "./service.ts";
import { StorageQuota } from "./storage.ts";
import { StorageLibrary } from "./library.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { ChatService } from "~/modules/chat/server/service.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";

const standard = Schema.toStandardSchemaV1;

/** The limits the signed-in person is held to, with what is used of each. */
export const getMyLimits = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(({ context }) =>
    runServerFn(UsageLimits.use((limits) => limits.standing(context.session.user.id))),
  );

/** Every rule, everyone's and each group's, with the time zone periods begin in. */
export const getUsageLimitRules = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() =>
    runServerFn(
      UsageLimits.use((limits) =>
        Effect.all({ rules: limits.rules(), timeZone: limits.timeZone() }),
      ),
    ),
  );

export const saveUsageLimit = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(SaveLimitInput))
  .handler(({ data }) => runServerFn(UsageLimits.use((limits) => limits.saveRule(data))));

export const deleteUsageLimit = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(LimitIdInput))
  .handler(({ data }) => runServerFn(UsageLimits.use((limits) => limits.deleteRule(data.id))));

export const setLimitTimeZone = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(TimeZoneInput))
  .handler(({ data }) =>
    runServerFn(UsageLimits.use((limits) => limits.setTimeZone(data.timeZone))),
  );

/** What the signed-in person stores, against their quota. */
export const getMyStorage = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(({ context }) =>
    runServerFn(StorageQuota.use((quota) => quota.standing(context.session.user.id))),
  );

export const getStorageQuotas = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() => runServerFn(StorageQuota.use((quota) => quota.quotas())));

export const setEveryoneStorage = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(EveryoneStorageInput))
  .handler(({ data }) => runServerFn(StorageQuota.use((quota) => quota.setEveryone(data.bytes))));

export const setGroupStorage = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(GroupStorageInput))
  .handler(({ data }) =>
    runServerFn(
      StorageQuota.use((quota) =>
        quota.setGroup(data.groupId, "bytes" in data ? data.bytes : undefined),
      ),
    ),
  );

/** Every file the signed-in person stores, largest first, with where each is used. */
export const getMyLibrary = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(({ context }) =>
    runServerFn(StorageLibrary.use((library) => library.list(context.session.user.id))),
  );

/** Takes a file out of a sent message in the person's own chat, freeing its room. */
export const removeChatFile = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(LibraryFileInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.gen(function* () {
        const userId = context.session.user.id;
        const { conversationId } = yield* AttachmentService.use((service) =>
          service.removeFromChat({ userId, attachmentId: data.attachmentId }),
        );
        // A tab with the chat open drops the file instead of offering a dead link.
        yield* SyncBus.use((bus) =>
          bus.publish(userId, { type: "conversation.updated", conversationId }),
        );
      }),
    ),
  );

/** Purges the person's deleted chats now, rather than when their Undo runs out. */
export const emptyDeletedChats = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .handler(({ context }) =>
    runServerFn(ChatService.use((chat) => chat.emptyDeleted({ userId: context.session.user.id }))),
  );
