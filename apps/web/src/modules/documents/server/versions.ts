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
  /** What a person named it; a named version is never thinned away. */
  readonly name: string | null;
}

export interface StepAuthor {
  revision: number;
  origin: "user" | "model";
  userId: string | null;
  userName: string | null;
  createdAt: Date;
}

/** One run's end: the step it ends on, by its author, when that step came. */
export interface VersionEnd {
  readonly revision: number;
  readonly at: Date;
  readonly origin: "user" | "model" | null;
  readonly userId: string | null;
  readonly author: VersionAuthor | null;
}

/** A pause this long between one author's steps starts a new version. */
const PAUSE_MS = 10 * 60_000;
/** Versions a history shows at most; older ones are listed as one. */
export const VERSIONS_SHOWN = 200;

/** Where each run of steps ends, oldest first. The last run may still be going. */
export function versionEnds(steps: ReadonlyArray<StepAuthor>): VersionEnd[] {
  const ends: VersionEnd[] = [];
  let last: { key: string; at: number } | null = null;
  for (const step of steps) {
    const author: VersionAuthor | null =
      step.origin === "model"
        ? { kind: "assistant" }
        : step.userName !== null
          ? { kind: "person", name: step.userName }
          : null;
    const at = step.createdAt.getTime();
    const current = ends.at(-1);
    // A repair has no author: it belongs to the run it follows.
    if (!author && current) {
      ends[ends.length - 1] = { ...current, revision: step.revision };
      continue;
    }
    // By id, not name: two people called Alex are two authors.
    const key = author?.kind === "person" ? `person:${step.userId}` : (author?.kind ?? "server");
    const end = {
      revision: step.revision,
      at: step.createdAt,
      origin: author ? step.origin : null,
      userId: author?.kind === "person" ? step.userId : null,
      author,
    };
    if (current && last && last.key === key && at - last.at <= PAUSE_MS)
      ends[ends.length - 1] = end;
    else ends.push(end);
    last = { key, at };
  }
  return ends;
}

export function groupVersions(
  steps: ReadonlyArray<StepAuthor>,
  oldest: { revision: number; at: Date },
): DocumentVersion[] {
  const shown: DocumentVersion[] = versionEnds(steps)
    .toReversed()
    .slice(0, VERSIONS_SHOWN)
    .map(({ revision, at, author }) => ({ revision, at: at.toISOString(), author, name: null }));
  // Before the first kept step, the document as compaction last folded it.
  shown.push({ revision: oldest.revision, at: oldest.at.toISOString(), author: null, name: null });
  return shown;
}

/** Checkpoints kept daily for this long, then weekly. */
const DAILY_DAYS = 90;
/** Unnamed checkpoints a document keeps at most; the oldest go first. */
export const CHECKPOINTS_KEPT = 200;
/** Names a document holds at most, each a whole copy of its text. */
export const NAMED_VERSIONS = 50;

const DAY_MS = 24 * 60 * 60_000;
/** Weeks counted from a Monday, so a week runs Monday to Sunday in UTC. */
const MONDAY_MS = Date.UTC(1970, 0, 5);

/**
 * The checkpoints to drop: of the unnamed ones, all but the last of each day
 * within 90 days and of each week before, then the oldest past 200. A named
 * one stays whatever its age.
 */
export function thinnedCheckpoints(
  checkpoints: ReadonlyArray<{ revision: number; at: Date; named: boolean }>,
  now: number,
): number[] {
  const unnamed = checkpoints
    .filter((checkpoint) => !checkpoint.named)
    .toSorted((a, b) => b.revision - a.revision);
  const seen = new Set<string>();
  const kept: number[] = [];
  const dropped: number[] = [];
  for (const checkpoint of unnamed) {
    const at = checkpoint.at.getTime();
    const period =
      now - at <= DAILY_DAYS * DAY_MS
        ? `day:${Math.floor(at / DAY_MS)}`
        : `week:${Math.floor((at - MONDAY_MS) / (7 * DAY_MS))}`;
    if (seen.has(period) || kept.length >= CHECKPOINTS_KEPT) dropped.push(checkpoint.revision);
    else {
      seen.add(period);
      kept.push(checkpoint.revision);
    }
  }
  return dropped;
}
