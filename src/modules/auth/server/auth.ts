import { Effect } from "effect";
import { getDb } from "~/db/client.ts";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { runtime } from "~/server/runtime.ts";
import { createAppAuth } from "./config.ts";

export const auth = createAppAuth({
  db: getDb(),
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  purgeUserFiles: async (userId) => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const attachments = yield* AttachmentService;
        yield* attachments.purgeUserFiles(userId);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("attachment purge after user delete failed", {
            userId,
            cause: String(cause),
          }),
        ),
      ),
    );
  },
});

export type Auth = typeof auth;
export type Session = Auth["$Infer"]["Session"];
