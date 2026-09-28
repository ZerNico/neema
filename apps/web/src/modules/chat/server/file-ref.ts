import type { FileRef } from "~/modules/custom-tools/authoring.ts";

// One reference format for the host and authored tools; the authoring runtime
// owns it because it is bundled into tools and cannot import server code.
export {
  formatFileRef,
  type FileRef,
  type WorkingFileRef,
} from "~/modules/custom-tools/authoring.ts";

export const parseFileRef = (raw: string): FileRef | undefined => {
  const attachment = /^attachment:([0-9a-f-]{36})$/.exec(raw);
  if (attachment) return { kind: "attachment", id: attachment[1]! };
  const pinned = /^(project|working):([0-9a-f-]{36})@([1-9]\d*)$/.exec(raw);
  if (pinned) {
    const version = Number(pinned[3]);
    if (!Number.isSafeInteger(version)) return undefined;
    return pinned[1] === "working"
      ? { kind: "working", id: pinned[2]!, revision: version }
      : { kind: "project", id: pinned[2]!, version };
  }
  return undefined;
};
