import { columnLetters } from "@chat/sheet/a1";
import type { Axis } from "@chat/sheet/model";
import type { PlacedGroup } from "@chat/sheet/model/outline";
import type { OnOutline } from "./grid-types.ts";
import { HEADER_COLUMN_PX, HEADER_ROW_PX, OUTLINE_STEP, type AxisLayout } from "./layout.ts";

/**
 * Each group's bracket and its button, on the summary row or column after
 * it, as Excel draws them. `offset` is where the axis's cells start.
 */
export function OutlineMarks({
  axis,
  groups,
  layout,
  offset,
  onOutline,
}: {
  axis: Axis;
  groups: readonly PlacedGroup[];
  layout: AxisLayout;
  offset: number;
  /** Without it, the brackets show and no buttons do. */
  onOutline: OnOutline | undefined;
}) {
  return groups.flatMap((group) => {
    const across = (group.level - 1) * OUTLINE_STEP + OUTLINE_STEP / 2;
    const [from, to] = [layout.starts[group.start - 1]!, layout.starts[group.end]!];
    const after = group.end < layout.ids.length ? group.end : group.end - 1;
    const along = layout.starts[after]! + (layout.size(after) - 12) / 2;
    const line =
      !group.group.collapsed && to > from ? (
        <div
          key={`line-${group.index}`}
          aria-hidden
          className="border-muted-foreground/60 pointer-events-none absolute"
          style={
            axis === "rows"
              ? {
                  top: offset + from + 2,
                  left: across,
                  height: to - from - 2,
                  width: 4,
                  borderLeftWidth: 1,
                  borderBottomWidth: 1,
                }
              : {
                  left: offset + from + 2,
                  top: across,
                  width: to - from - 2,
                  height: 4,
                  borderTopWidth: 1,
                  borderRightWidth: 1,
                }
          }
        />
      ) : null;
    const button = onOutline ? (
      <button
        key={`button-${group.index}`}
        type="button"
        aria-label={`${group.group.collapsed ? "Expand" : "Collapse"} ${axis === "rows" ? "rows" : "columns"} ${
          axis === "rows" ? group.start : columnLetters(group.start)
        } to ${axis === "rows" ? group.end : columnLetters(group.end)}`}
        className="border-border bg-background text-muted-foreground hover:text-foreground absolute flex size-3 items-center justify-center rounded-xs border text-[10px] leading-none"
        style={
          axis === "rows"
            ? { top: offset + along, left: across - 6 }
            : { left: offset + along, top: across - 6 }
        }
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => onOutline(axis, { group })}
      >
        {group.group.collapsed ? "+" : "−"}
      </button>
    ) : null;
    return [line, button];
  });
}

/** Excel's numbered buttons in the corner: show the outline down to a level. */
export function OutlineLevels({
  rowDepth,
  colDepth,
  rowGutter,
  colGutter,
  onOutline,
}: {
  rowDepth: number;
  colDepth: number;
  rowGutter: number;
  colGutter: number;
  onOutline: OnOutline;
}) {
  const buttons = (axis: Axis, depth: number) =>
    depth
      ? Array.from({ length: depth + 1 }, (_, index) => (
          <button
            key={`${axis}-level-${index}`}
            type="button"
            aria-label={`Show ${axis === "rows" ? "row" : "column"} outline level ${index + 1}`}
            className="border-border bg-background text-muted-foreground hover:text-foreground absolute flex size-3 items-center justify-center rounded-xs border text-[9px] leading-none"
            style={
              axis === "rows"
                ? { left: index * OUTLINE_STEP + 1, top: colGutter + (HEADER_ROW_PX - 12) / 2 }
                : { top: index * OUTLINE_STEP + 1, left: rowGutter + (HEADER_COLUMN_PX - 12) / 2 }
            }
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onOutline(axis, { level: index + 1 })}
          >
            {index + 1}
          </button>
        ))
      : [];
  return [...buttons("rows", rowDepth), ...buttons("columns", colDepth)];
}
