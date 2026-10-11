import { MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "~/ui/primitives/button";
import { ContextMenuItem, ContextMenuSeparator } from "~/ui/primitives/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { chartActions, type ChartAction } from "./chart-actions.ts";

/** A chart's actions in the sheet's right-click menu, while the chart is selected. */
export function ChartContextItems({
  readOnly,
  onAction,
}: {
  readOnly: boolean;
  onAction: (action: ChartAction) => void;
}) {
  return chartActions(readOnly).map((each, index) => [
    each.separated && index > 0 ? <ContextMenuSeparator key={`${each.action}-separator`} /> : null,
    <ContextMenuItem
      key={each.action}
      variant={each.action === "delete" ? "destructive" : "default"}
      onClick={() => onAction(each.action)}
    >
      <HugeiconsIcon icon={each.icon} strokeWidth={2} />
      {each.label}
    </ContextMenuItem>,
  ]);
}

/** The same actions from a button on the chart, for those who don't right-click. */
export function ChartMenuButton({
  readOnly,
  onAction,
}: {
  readOnly: boolean;
  onAction: (action: ChartAction) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Chart options"
            className="text-muted-foreground"
            // The menu opens without selecting or dragging the chart beneath.
            onPointerDown={(event) => event.stopPropagation()}
          />
        }
      >
        <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {chartActions(readOnly).map((each, index) => [
          each.separated && index > 0 ? (
            <DropdownMenuSeparator key={`${each.action}-separator`} />
          ) : null,
          <DropdownMenuItem
            key={each.action}
            variant={each.action === "delete" ? "destructive" : "default"}
            onClick={() => onAction(each.action)}
          >
            <HugeiconsIcon icon={each.icon} strokeWidth={2} />
            {each.label}
          </DropdownMenuItem>,
        ])}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
