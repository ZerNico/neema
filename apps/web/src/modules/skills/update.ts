import { isBinarySkillFile, withoutBytes, type SkillFile } from "./package.ts";
export interface SkillFileChange {
  path: string;
  baseline: SkillFile | null;
  local: SkillFile | null;
  upstream: SkillFile | null;
  conflict: boolean;
  selected: "local" | "upstream";
}

/** What makes two versions of a file the same: text by content, a binary by its hash. */
const identity = (file: SkillFile | null) =>
  file === null ? null : isBinarySkillFile(file) ? `binary:${file.binary.sha256}` : file.content;

/** Three-way file comparison, never an automatic text merge. Deletion is an explicit null side. */
export function compareSkillUpdate(
  baseline: readonly SkillFile[],
  local: readonly SkillFile[],
  upstream: readonly SkillFile[],
): SkillFileChange[] {
  const maps = [baseline, local, upstream].map(
    (files) => new Map(files.map((file) => [file.path, file])),
  );
  const paths = [...new Set([...baseline, ...local, ...upstream].map((file) => file.path))].sort();
  return paths.map((path) => {
    const before = maps[0]!.get(path) ?? null;
    const current = maps[1]!.get(path) ?? null;
    const next = maps[2]!.get(path) ?? null;
    const [was, is, will] = [identity(before), identity(current), identity(next)];
    return {
      path,
      baseline: before,
      local: current,
      upstream: next,
      conflict: is !== was && will !== was && is !== will,
      selected: is !== was ? "local" : "upstream",
    };
  });
}
export function resolveSkillUpdate(changes: readonly SkillFileChange[]): SkillFile[] {
  return changes.flatMap((change) => {
    const file = change[change.selected];
    return file === null ? [] : [{ ...file, path: change.path }];
  });
}

/** The comparison as the browser sees it: binary sides are described, never sent. */
export const changesWithoutBytes = (changes: readonly SkillFileChange[]): SkillFileChange[] =>
  changes.map((change) => ({
    ...change,
    baseline: change.baseline && withoutBytes(change.baseline),
    local: change.local && withoutBytes(change.local),
    upstream: change.upstream && withoutBytes(change.upstream),
  }));
