import { MinusSignIcon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "~/ui/primitives/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { ZOOM_STEPS, stepZoom } from "./zoom.ts";

/** The status bar's zoom: out, the percentage (back to 100% on a click), and in. */
export function SheetZoom({ zoom, onZoom }: { zoom: number; onZoom: (zoom: number) => void }) {
  return (
    <div className="text-muted-foreground flex shrink-0 items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Zoom out"
              disabled={zoom <= ZOOM_STEPS[0]}
              onClick={() => onZoom(stepZoom(zoom, -1))}
            />
          }
        >
          <HugeiconsIcon icon={MinusSignIcon} strokeWidth={2} />
        </TooltipTrigger>
        <TooltipContent>Zoom out</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="xs"
              variant="ghost"
              aria-label={`Zoom ${Math.round(zoom * 100)}%`}
              className="tabular-nums"
              onClick={() => onZoom(1)}
            />
          }
        >
          {Math.round(zoom * 100)}%
        </TooltipTrigger>
        <TooltipContent>Back to 100%</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Zoom in"
              disabled={zoom >= ZOOM_STEPS.at(-1)!}
              onClick={() => onZoom(stepZoom(zoom, 1))}
            />
          }
        >
          <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
        </TooltipTrigger>
        <TooltipContent>Zoom in</TooltipContent>
      </Tooltip>
    </div>
  );
}
