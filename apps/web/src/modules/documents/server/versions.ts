/**
 * A document's versions as its history lists them, newest first: runs of one
 * author's steps, a run ending where another author's starts or after a
 * pause, as Google Docs groups its edits. The server's own repairs (block
 * IDs) join the run they follow.
 */

export type VersionAuthor = { kind: "person"; name: string } | { kind: "assistant" };

export interface DocumentVersion {
  /** The revision the document had when this version ended. */
  readonly revision: number;
  readonly at: string;
  /** Null for the oldest kept version, whose authors were folded away. */
  readonly author: VersionAuthor | null;
}

/** A pause this long between one author's steps starts a new version. */
const PAUSE_MS = 10 * 60_000;
/** Versions a history shows at most; older ones are listed as one. */
export const VERSIONS_SHOWN = 200;

export function groupVersions(
  steps: ReadonlyArray<{
    revision: number;
    origin: "user" | "model";
    userName: string | null;
    createdAt: Date;
  }>,
  oldest: { revision: number; at: Date },
): DocumentVersion[] {
  const versions: DocumentVersion[] = [];
  let last: { key: string; at: number } | null = null;
  for (const step of steps) {
    const author: VersionAuthor | null =
      step.origin === "model"
        ? { kind: "assistant" }
        : step.userName !== null
          ? { kind: "person", name: step.userName }
          : null;
    const at = step.createdAt.getTime();
    const current = versions.at(-1);
    // A repair has no author: it belongs to the run it follows.
    if (!author && current) {
      versions[versions.length - 1] = { ...current, revision: step.revision };
      continue;
    }
    const key = author?.kind === "person" ? `person:${author.name}` : (author?.kind ?? "server");
    if (current && last && last.key === key && at - last.at <= PAUSE_MS) {
      versions[versions.length - 1] = {
        ...current,
        revision: step.revision,
        at: step.createdAt.toISOString(),
      };
    } else versions.push({ revision: step.revision, at: step.createdAt.toISOString(), author });
    last = { key, at };
  }
  const shown = versions.toReversed().slice(0, VERSIONS_SHOWN);
  // Before the first kept step, the document as compaction last folded it.
  shown.push({ revision: oldest.revision, at: oldest.at.toISOString(), author: null });
  return shown;
}
