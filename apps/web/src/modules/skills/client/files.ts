import { isBinarySkillFile, type SkillFile } from "../package.ts";
import { uploadSkillAsset } from "../server/functions.ts";

/** What a save sends: a binary file names stored bytes, it never carries them. */
export const skillFileInput = (file: SkillFile) =>
  isBinarySkillFile(file)
    ? {
        path: file.path,
        binary: {
          size: file.binary.size,
          mediaType: file.binary.mediaType,
          ...(file.binary.sha256 ? { sha256: file.binary.sha256 } : {}),
          ...(file.binary.uploadId ? { uploadId: file.binary.uploadId } : {}),
        },
      }
    : { path: file.path, content: file.content };

export const uploadSkillFile = (file: File) => {
  const data = new FormData();
  data.set("file", file);
  return uploadSkillAsset({ data });
};
