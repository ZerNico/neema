import { Cause, Effect } from "effect";
import { sha256Hex } from "~/modules/attachments/server/sha256.ts";
import { formatFileRef, parseFileRef, type FileRef } from "~/modules/chat/server/file-ref.ts";
import type { ToolFile } from "~/modules/chat/server/tool-files.ts";
import type { WorkingFiles } from "~/modules/chat/server/working-files.ts";
import { advertisedParameter } from "~/modules/tools/server/toolset.ts";
import type { JobError } from "~/server/job-worker.ts";
import { OFFICE_FAMILIES, type OfficeFamily } from "../families.ts";

export type Arguments = Record<string, unknown>;

/** What every Office tool group needs from the attempt. */
export interface OfficeToolHost {
  workingFiles: WorkingFiles;
  /** The attempt's existing makeToolFileResolver; enforces sender access and project version. */
  resolveFile: (reference: string) => Effect.Effect<ToolFile, string>;
}

export const received = (value: unknown) =>
  Array.isArray(value) ? "an array" : value === null ? "null" : `a ${typeof value}`;

/** Absent and null mean the same thing; models send both. */
export function presentArguments(raw: unknown, invalid: (message: string) => never): Arguments {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return invalid(`Arguments must be an object; received ${received(raw)}`);
  return Object.fromEntries(
    Object.entries(raw).filter(([, value]) => value !== null && value !== undefined),
  );
}

/** The source parameters every Office tool takes, worded for its family. */
export function sourceParameters(family: OfficeFamily) {
  const { extension, inspect } = OFFICE_FAMILIES[family];
  return {
    sourceRef: advertisedParameter({
      type: "string",
      description: `An authorized .${extension}: attachment:<id>, project:<id>@<version>, a skill template's skill: reference from read_skill_file, or the working: reference import_local_file returned.`,
    }),
    sourceFingerprint: advertisedParameter({
      type: "string",
      pattern: "^[0-9a-f]{64}$",
      description: `The fingerprint ${inspect} returned for sourceRef.`,
    }),
    workingRef: advertisedParameter({
      type: "string",
      description: "An exact draft revision, working:<id>@<revision>, from the latest edit result.",
    }),
  };
}

export type OfficeSource = {
  readonly bytes: Uint8Array;
  readonly name: string;
  readonly ref: FileRef;
  /** A draft this family owns, edited in place; otherwise a source opened into a new draft. */
  readonly draft: boolean;
};

/** How an inspection names what it read: the draft's revision, or the source reference. */
export const sourceFields = (source: OfficeSource) =>
  source.draft && source.ref.kind === "working"
    ? {
        workingFileId: source.ref.id,
        revision: source.ref.revision,
        workingRef: formatFileRef(source.ref),
      }
    : { sourceRef: formatFileRef(source.ref) };

/**
 * The parts every Office tool group shares: argument checks, one error shape,
 * resolving a source by reference and fingerprint, and saving a draft. Each
 * family's tools add their own operations and results around these.
 */
export function officeToolKit<F extends OfficeFamily>(
  family: F,
  host: OfficeToolHost,
  ErrorClass: new (code: string, message: string) => JobError,
) {
  const info = OFFICE_FAMILIES[family];
  const invalid = (message: string): never => {
    throw new ErrorClass("invalid_operation", message);
  };
  const isError = (value: unknown): value is JobError => value instanceof ErrorClass;
  const text = (raw: unknown, field: string, max = 300) =>
    typeof raw === "string" && raw.length > 0 && raw.length <= max
      ? raw
      : invalid(`${field}: expected a string; received ${received(raw)}`);
  const accepts = (file: { name: string; mediaType: string }) =>
    file.mediaType === info.mediaType || file.name.toLowerCase().endsWith(`.${info.extension}`);

  /** A handler whose failures become one result shape the model can act on. */
  const execute =
    <R>(operation: string, work: (raw: Arguments, signal: AbortSignal) => Promise<R>) =>
    (raw: unknown) =>
      Effect.tryPromise({
        try: (signal) => {
          signal.throwIfAborted();
          return work(presentArguments(raw, invalid), signal);
        },
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          (isError(cause)
            ? Effect.void
            : Effect.logError(`${info.label} ${operation} failed unexpectedly`, Cause.die(cause))
          ).pipe(
            Effect.as({
              family,
              operation,
              outcome: "error",
              message: isError(cause)
                ? `${cause.code}: ${cause.message}`
                : `${info.label} operation failed or access is unavailable.`,
            }),
          ),
        ),
      );

  /** The resolver enforces access and version pins; its reason is one the model can act on. */
  const resolve = (ref: FileRef, signal: AbortSignal) => {
    signal.throwIfAborted();
    return Effect.runPromise(
      host
        .resolveFile(formatFileRef(ref))
        .pipe(Effect.mapError((reason) => new ErrorClass("unavailable", reason))),
      { signal },
    );
  };

  /** The file named by exactly one of sourceRef or workingRef, checked as this family's. */
  const openSource = async (
    raw: Arguments,
    signal: AbortSignal,
    requireFingerprint = true,
  ): Promise<OfficeSource> => {
    signal.throwIfAborted();
    if ((raw.sourceRef === undefined) === (raw.workingRef === undefined))
      return invalid("Provide exactly one of sourceRef or workingRef.");
    const field = raw.sourceRef !== undefined ? "sourceRef" : "workingRef";
    const ref = parseFileRef(text(raw[field], field));
    if (!ref || (field === "workingRef" && ref.kind !== "working"))
      return invalid(
        field === "workingRef"
          ? "workingRef: expected working:<id>@<revision> from the latest edit result."
          : "sourceRef: expected attachment:<id>, project:<id>@<version>, skill:<revision>/<path> or a working:<id>@<revision> reference exactly as a result returned it.",
      );
    if (ref.kind === "working") {
      await host.workingFiles.load(ref);
      signal.throwIfAborted();
      const file = host.workingFiles.read(ref);
      // A draft is edited in place; an import from the user's computer opens
      // into a draft of its own. The reference says which it is, so either
      // field reads it as meant: models mix the two up.
      if (file.owner === family) return { bytes: file.bytes, name: file.name, ref, draft: true };
      if (file.owner !== "local" || !accepts(file))
        invalid(`${field}: this working file is not ${info.file}.`);
      return { bytes: file.bytes, name: file.name, ref, draft: false };
    }
    if (requireFingerprint && raw.sourceFingerprint === undefined)
      return invalid(
        "sourceFingerprint: inspect the source first and pass the fingerprint it returned.",
      );
    if (
      raw.sourceFingerprint !== undefined &&
      (typeof raw.sourceFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(raw.sourceFingerprint))
    )
      return invalid("sourceFingerprint: expected the 64-character hex fingerprint.");
    const file = await resolve(ref, signal);
    signal.throwIfAborted();
    if (!accepts(file)) invalid(`${file.name} is not ${info.file}.`);
    if (raw.sourceFingerprint !== undefined && sha256Hex(file.bytes) !== raw.sourceFingerprint)
      invalid("The source changed since its fingerprint was observed; inspect it again.");
    // The resolved reference: in a branched chat, the attachment an old ID stands for.
    return { bytes: file.bytes, name: file.name, ref: file.ref, draft: false };
  };

  /**
   * An edit's start: exactly one of create, sourceRef or workingRef, and the
   * file's name, which a new file takes from fileName.
   */
  const beginEdit = async (raw: Arguments, defaultName: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (raw.create !== undefined && raw.create !== true && raw.create !== "true")
      invalid("create: expected true, or leave it out.");
    const create = raw.create !== undefined;
    if (
      Number(create) +
        Number(raw.sourceRef !== undefined) +
        Number(raw.workingRef !== undefined) !==
      1
    )
      invalid("Provide exactly one of create, sourceRef or workingRef.");
    const source = create ? null : await openSource(raw, signal);
    const name = source?.name ?? raw.fileName ?? defaultName;
    if (
      typeof name !== "string" ||
      name.length > 200 ||
      !name.toLowerCase().endsWith(`.${info.extension}`)
    )
      return invalid(`fileName: expected a name ending in .${info.extension}.`);
    return { create, source, name };
  };

  /** The edited bytes as the draft's next revision, or a new draft opened from the source. */
  const saveDraft = (
    source: OfficeSource | null,
    bytes: Uint8Array,
    name: string,
    signal: AbortSignal,
  ) => {
    // Lower work may already have completed when Stop wins the awaiting Effect.
    signal.throwIfAborted();
    const file = { bytes, name, mediaType: info.mediaType, owner: family };
    const snapshot =
      source?.draft && source.ref.kind === "working"
        ? host.workingFiles.replace(source.ref, file)
        : host.workingFiles.create({
            ...file,
            ...(source ? { source: formatFileRef(source.ref) } : {}),
          });
    return {
      snapshot,
      fields: {
        workingFileId: snapshot.ref.id,
        revision: snapshot.ref.revision,
        workingRef: formatFileRef(snapshot.ref),
        fingerprint: snapshot.fingerprint,
      },
    };
  };

  return {
    invalid,
    text,
    accepts,
    execute,
    resolve,
    openSource,
    sourceFields,
    beginEdit,
    saveDraft,
  };
}
