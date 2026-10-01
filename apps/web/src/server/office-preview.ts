import { Effect } from "effect";
import { AttachmentService } from "~/modules/attachments/server/service.ts";
import { OFFICE_FAMILIES, type OfficeFamily } from "~/modules/office/families.ts";
import { ProjectFileService } from "~/modules/projects/server/project-files.ts";
import { SkillService } from "~/modules/skills/server/service.ts";
import { approvedSession } from "~/server/approved-route.ts";
import { runtime } from "~/server/runtime.ts";

/** Access can be taken away, so nothing is cached outside this process. */
export const previewHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};
export const previewText = (body: string, status: number) =>
  new Response(body, { status, headers: previewHeaders });

/** A rendered preview: JSON for the client to lay out, or an image. */
export interface Preview {
  readonly body: Uint8Array;
  readonly type: "application/json" | "image/png";
}
export const jsonPreview = (value: unknown): Preview => ({
  body: new TextEncoder().encode(JSON.stringify(value)),
  type: "application/json",
});

/**
 * Previews by content, never by file: a hit is served only after the request's
 * own access check, so revoking access still takes effect at once. Bounded by
 * entries and bytes, oldest out first.
 */
export function createPreviewCache(limits = { entries: 512, bytes: 64 * 1024 * 1024 }) {
  const cache = new Map<string, Preview>();
  let cachedBytes = 0;
  return {
    get(key: string) {
      const hit = cache.get(key);
      if (hit) {
        cache.delete(key);
        cache.set(key, hit);
      }
      return hit;
    },
    set(key: string, value: Preview) {
      if (value.body.length > limits.bytes / 8) return;
      const replaced = cache.get(key);
      if (replaced) cachedBytes -= replaced.body.length;
      cache.delete(key);
      cache.set(key, value);
      cachedBytes += value.body.length;
      for (const [oldest, preview] of cache) {
        if (cache.size <= limits.entries && cachedBytes <= limits.bytes) break;
        cache.delete(oldest);
        cachedBytes -= preview.body.length;
      }
    },
  };
}

/**
 * A file a preview route may show: a chat attachment, a project file version
 * or a skill's file (`<skillId>:<sha256>`, its owner's only) the person can
 * read, or null. Attachment and project bytes load only when a cache misses.
 */
export const openPreviewFile = (userId: string, kind: string, fileId: string) =>
  kind !== "attachment" && kind !== "project-version" && kind !== "skill-file"
    ? Promise.resolve(null)
    : runtime.runPromise(
        Effect.gen(function* () {
          if (kind === "skill-file") {
            const [skillId = "", sha256 = ""] = fileId.split(":");
            if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
            const file = yield* Effect.flatMap(SkillService, (skills) =>
              skills.readFile(userId, skillId, sha256),
            ).pipe(Effect.catchTag("SkillNotAvailable", () => Effect.succeed(null)));
            return (
              file && {
                name: file.path.slice(file.path.lastIndexOf("/") + 1),
                mediaType: file.mediaType,
                sha256,
                bytes: Effect.succeed<Uint8Array | null>(file.bytes),
              }
            );
          }
          if (kind === "project-version")
            return yield* Effect.flatMap(ProjectFileService, (projects) =>
              projects.openVersion(userId, fileId),
            );
          const found = yield* Effect.flatMap(AttachmentService, (attachments) =>
            attachments.open({ userId, attachmentId: fileId }),
          ).pipe(Effect.catchTag("AttachmentNotAvailable", () => Effect.succeed(null)));
          return found && { ...found, name: found.fileName };
        }),
      );

/** One budget for every Office family's previews, keyed by family and content. */
const cache = createPreviewCache();

/** Fails like the family's worker: a code, and a message written for people. */
type PreviewError = Error & { readonly code: string };

/**
 * The GET handler every Office preview route shares: the session, access to
 * the file, its stored type (decided from the bytes, so nothing else reaches a
 * worker), the cache, and one error ladder. A family supplies what a request
 * asks for and how to produce it.
 */
export function officePreviewHandler<Q>(config: {
  readonly family: OfficeFamily;
  /** How the 500 names the file: "presentation", "workbook", "document". */
  readonly noun: string;
  /** What the request asks for; null names nothing that can exist, a 404. */
  readonly query: (url: URL) => Q | null;
  /** Said when the query, or the worker's `not_found`, names nothing. */
  readonly missing: string;
  /** The cache key past the file's content hash; may depend on more than the query. */
  readonly key: (query: Q) => string | Promise<string>;
  readonly produce: (
    bytes: Uint8Array,
    query: Q,
    run: { readonly signal: AbortSignal; readonly owner: string },
  ) => Promise<Preview>;
  readonly isError: (error: unknown) => error is PreviewError;
}) {
  const { app, mediaType } = OFFICE_FAMILIES[config.family];
  const serve = (preview: Preview) =>
    new Response(preview.body as BodyInit, {
      headers: { ...previewHeaders, "Content-Type": preview.type },
    });
  return async ({
    request,
    params,
  }: {
    request: Request;
    params: { kind: string; fileId: string };
  }): Promise<Response> => {
    const session = await approvedSession(request);
    if (!session) return previewText("Unauthorized", 401);
    const owner = session.user.id;
    const file = await openPreviewFile(owner, params.kind, params.fileId);
    if (!file) return previewText("Not found", 404);
    if (file.mediaType !== mediaType) return previewText(`Only ${app} files have a preview.`, 422);
    const query = config.query(new URL(request.url));
    if (query === null) return previewText(config.missing, 404);
    try {
      const key = `${config.family}:${file.sha256}:${await config.key(query)}`;
      const hit = cache.get(key);
      if (hit) return serve(hit);
      const bytes = await runtime.runPromise(file.bytes);
      if (!bytes) return previewText("Not found", 404);
      const preview = await config.produce(bytes, query, { signal: request.signal, owner });
      cache.set(key, preview);
      return serve(preview);
    } catch (error) {
      if (request.signal.aborted) return previewText("Cancelled", 499);
      if (config.isError(error)) {
        if (error.code === "not_found") return previewText(config.missing, 404);
        return previewText(error.message, error.code === "busy" ? 503 : 422);
      }
      await runtime.runPromise(
        Effect.logError(`${config.family} preview failed`, { kind: params.kind, error }),
      );
      return previewText(`Could not preview this ${config.noun}.`, 500);
    }
  };
}
