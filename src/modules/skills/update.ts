import type { SkillFile } from "./package.ts";
export interface SkillFileChange {
  path: string;
  baseline: string | null;
  local: string | null;
  upstream: string | null;
  conflict: boolean;
  selected: "local" | "upstream";
}
/** Three-way file comparison, never an automatic text merge. Deletion is an explicit null side. */
export function compareSkillUpdate(
  baseline: readonly SkillFile[],
  local: readonly SkillFile[],
  upstream: readonly SkillFile[],
): SkillFileChange[] {
  const maps = [baseline, local, upstream].map(
    (files) => new Map(files.map((file) => [file.path, file.content])),
  );
  const paths = [...new Set([...baseline, ...local, ...upstream].map((file) => file.path))].sort();
  return paths.map((path) => {
    const before = maps[0]!.get(path) ?? null;
    const current = maps[1]!.get(path) ?? null;
    const next = maps[2]!.get(path) ?? null;
    return {
      path,
      baseline: before,
      local: current,
      upstream: next,
      conflict: current !== before && next !== before && current !== next,
      selected: current !== before ? "local" : "upstream",
    };
  });
}
export function resolveSkillUpdate(changes: readonly SkillFileChange[]): SkillFile[] {
  return changes.flatMap((change) => {
    const content = change[change.selected];
    return content === null ? [] : [{ path: change.path, content }];
  });
}
