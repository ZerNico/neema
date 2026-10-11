import {
  collapseColumnGroup,
  collapseRowGroup,
  groupColumns,
  groupRows,
  type Worksheet,
} from "@office-kit/xlsx/worksheet";

/**
 * Grouped rows and columns as Excel files keep them: an outline level on
 * each row or column, and collapsed groups' rows hidden. Live sheets keep
 * groups as spans, so a file's levels are read back as runs at each level.
 */
export interface FileGroup {
  readonly from: number;
  readonly to: number;
  /** 1 for an outermost group. */
  readonly level: number;
  readonly collapsed?: true;
}
export interface FileOutline {
  readonly rows?: readonly FileGroup[];
  readonly cols?: readonly FileGroup[];
}

const DEEPEST = 7;

/** An axis's groups from its levels: each run at or above a level is one group of that level. */
export function readGroups(
  count: number,
  levelAt: (index: number) => number,
  hiddenAt: (index: number) => boolean,
): FileGroup[] {
  const groups: FileGroup[] = [];
  for (let level = 1; level <= DEEPEST; level++) {
    let start = 0;
    for (let index = 1; index <= count + 1; index++) {
      const inside = index <= count && levelAt(index) >= level;
      if (inside && !start) start = index;
      if (!inside && start) {
        let hidden = true;
        for (let at = start; at < index && hidden; at++) hidden = hiddenAt(at);
        groups.push({ from: start, to: index - 1, level, ...(hidden ? { collapsed: true } : {}) });
        start = 0;
      }
    }
  }
  return groups;
}

/** Writes an axis's groups, outer levels first so inner ones raise their rows' level, then collapses. */
export function writeOutline(sheet: Worksheet, outline: FileOutline) {
  for (const [groups, group, collapse] of [
    [outline.rows, groupRows, collapseRowGroup],
    [outline.cols, groupColumns, collapseColumnGroup],
  ] as const) {
    const ordered = (groups ?? []).toSorted((a, b) => a.level - b.level);
    for (const each of ordered) group(sheet, each.from, each.to, Math.min(DEEPEST, each.level));
    for (const each of ordered) if (each.collapsed) collapse(sheet, each.from, each.to);
  }
}
