import { Schema } from "effect";
import { EntityId } from "~/entity-id.ts";

/** Shared by the file picker and the server; no node or browser imports. */
export const PROJECT_FILE_LIMITS = {
  /** One upload or one version. */
  fileBytes: 50 * 1024 * 1024,
  filesPerProject: 200,
  /** Unpinned versions older than this are dropped; the current one never is. */
  historyDays: 30,
  /** Unpinned versions kept per file, the current one included. */
  historyVersions: 25,
  pinsPerFile: 10,
  /** How much of a file's text one read hands the model. */
  readChars: 60_000,
} as const;

const Version = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
export const ProjectFileIdInput = Schema.Struct({ fileId: EntityId });
export const RestoreProjectFileInput = Schema.Struct({
  versionId: EntityId,
  basedOnVersion: Version,
});
export const PinProjectFileVersionInput = Schema.Struct({
  versionId: EntityId,
  pinned: Schema.Boolean,
  label: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(80))),
});
export const SaveAttachmentToProjectInput = Schema.Struct({
  projectId: EntityId,
  attachmentId: EntityId,
});

export interface ProjectFileSummary {
  id: string;
  name: string;
  version: number;
  /** The current version's id, which is what a download names. */
  versionId: string;
  mediaType: string;
  size: number;
  updatedAt: string;
  updatedBy: string | null;
  origin: "user" | "model";
  versionCount: number;
}
export interface ProjectFileList {
  files: ReadonlyArray<ProjectFileSummary>;
  usedBytes: number;
}
export interface ProjectFileVersion {
  id: string;
  number: number;
  size: number;
  mediaType: string;
  origin: "user" | "model";
  createdBy: string | null;
  pinned: boolean;
  label: string | null;
  createdAt: string;
  current: boolean;
}
