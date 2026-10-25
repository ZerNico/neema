import { m } from "~/paraglide/messages.js";
import { ColorPicker } from "~/ui/color-picker";
import { Toolbar } from "@base-ui/react/toolbar";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type HugeiconsIconProps } from "@hugeicons/react";
import type { ReactNode } from "react";
import { Button } from "~/ui/primitives/button";
import { DropdownMenu, DropdownMenuTrigger } from "~/ui/primitives/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { cn } from "~/ui/utils";

// Pressing a ribbon control must not take focus from the text;
// a field in a menu, such as a colour's hex code, still takes it.
const keepFocus = (event: { preventDefault: () => void; target: EventTarget }) => {
  if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
};

/**
 * A toolbar button that opens a menu: an icon or a short label, a caret, and
 * a tooltip naming it. `children` is the menu's content.
 */
export function ToolbarMenu({
  label,
  icon,
  text,
  children,
}: {
  label: string;
  icon?: HugeiconsIconProps["icon"];
  /** Shown instead of the icon, such as the current font size. */
  text?: string;
  children: ReactNode;
}) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <Toolbar.Button
              render={
                <DropdownMenuTrigger
                  render={
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={label}
                      className="text-muted-foreground"
                      onMouseDown={keepFocus}
                    />
                  }
                />
              }
            />
          }
        >
          {icon ? <HugeiconsIcon icon={icon} strokeWidth={2} /> : null}
          {text ? <span className="max-w-24 truncate">{text}</span> : null}
          <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} data-icon="inline-end" />
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      {children}
    </DropdownMenu>
  );
}

/** Excel's palette: a row of greys and the theme's colours, then its standard colours. */
const PALETTE = [
  "#000000",
  "#404040",
  "#7F7F7F",
  "#BFBFBF",
  "#FFFFFF",
  "#44546A",
  "#4472C4",
  "#ED7D31",
  "#A5A5A5",
  "#FFC000",
  "#DDEBF7",
  "#FCE4D6",
  "#EDEDED",
  "#FFF2CC",
  "#E2EFDA",
  "#D9E1F2",
  "#5B9BD5",
  "#70AD47",
  "#C00000",
  "#FF0000",
  "#FFFF00",
  "#92D050",
  "#00B050",
  "#00B0F0",
  "#0070C0",
  "#002060",
  "#7030A0",
  "#F8CBAD",
  "#C6E0B4",
  "#BDD7EE",
] as const;

/** The palette's swatches, any colour, and the default, as a colour menu's content. */
export function ColorSwatches({
  value,
  resetLabel,
  onChange,
}: {
  value: string | undefined;
  resetLabel: string;
  onChange: (color: string | null) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Button size="sm" variant={value ? "ghost" : "secondary"} onClick={() => onChange(null)}>
        {resetLabel}
      </Button>
      <div className="grid grid-cols-10 gap-1">
        {PALETTE.map((swatch) => (
          <button
            key={swatch}
            type="button"
            aria-label={swatch}
            aria-pressed={value?.toUpperCase() === swatch}
            className={cn(
              "border-border ring-offset-background size-5 rounded-sm border outline-none focus-visible:ring-2",
              value?.toUpperCase() === swatch && "ring-ring ring-2 ring-offset-1",
            )}
            style={{ backgroundColor: swatch }}
            onClick={() => onChange(swatch)}
          />
        ))}
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-muted-foreground text-xs">{m.documents_color_more()}</span>
        <ColorPicker value={value} onChange={onChange} />
      </div>
    </div>
  );
}
