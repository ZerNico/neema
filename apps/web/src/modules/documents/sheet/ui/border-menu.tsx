import {
  BorderAll01Icon,
  BorderBottomIcon,
  BorderFullIcon,
  BorderInnerIcon,
  BorderLeftIcon,
  BorderNone01Icon,
  BorderRightIcon,
  BorderTopIcon,
  PaintBrush01Icon,
  RulerIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import type { BorderKind } from "@chat/sheet-react/format-commands";
import { edgeCss } from "@chat/sheet-react/display";
import { BORDER_STYLES, type BorderLine, type BorderStyle } from "@chat/sheet/model/style";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "~/ui/primitives/dropdown-menu";
import { ColorSwatches, ToolbarMenu } from "../../ui/ribbon-controls.tsx";

const BORDERS: ReadonlyArray<{ border: BorderKind; label: string; icon: typeof BorderAll01Icon }> =
  [
    { border: "all", label: "All borders", icon: BorderAll01Icon },
    { border: "outer", label: "Outside borders", icon: BorderFullIcon },
    { border: "inner", label: "Inside borders", icon: BorderInnerIcon },
    { border: "top", label: "Top border", icon: BorderTopIcon },
    { border: "bottom", label: "Bottom border", icon: BorderBottomIcon },
    { border: "left", label: "Left border", icon: BorderLeftIcon },
    { border: "right", label: "Right border", icon: BorderRightIcon },
    { border: "none", label: "No border", icon: BorderNone01Icon },
  ];
/** Excel's ready-made borders, each in its own line whatever line is chosen. */
const PRESETS: ReadonlyArray<{
  border: BorderKind;
  style: BorderStyle | null;
  label: string;
  icon: typeof BorderAll01Icon;
}> = [
  { border: "outer", style: "thick", label: "Thick outside borders", icon: BorderFullIcon },
  { border: "bottom", style: "thick", label: "Thick bottom border", icon: BorderBottomIcon },
  { border: "bottom", style: "double", label: "Bottom double border", icon: BorderBottomIcon },
  { border: "topBottom", style: null, label: "Top and bottom border", icon: BorderTopIcon },
];
const STYLE_LABELS: Readonly<Record<BorderStyle, string>> = {
  thin: "Thin",
  medium: "Medium",
  thick: "Thick",
  dashed: "Dashed",
  dotted: "Dotted",
  double: "Double",
};

/**
 * The Borders menu, as Excel's: which edges of the selection to draw, the
 * ready-made thick and double ones, and the line and colour the plain ones
 * draw in, kept while the sheet is open.
 */
export function BorderMenu({
  onBorder,
}: {
  onBorder: (border: BorderKind, line: BorderLine) => void;
}) {
  const [line, setLine] = useState<BorderLine>({ style: "thin" });
  return (
    <ToolbarMenu label="Borders" icon={BorderAll01Icon}>
      <DropdownMenuContent align="start" className="w-56">
        {BORDERS.map((each) => (
          <DropdownMenuItem key={each.border} onClick={() => onBorder(each.border, line)}>
            <HugeiconsIcon icon={each.icon} strokeWidth={2} />
            {each.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {PRESETS.map((each) => (
          <DropdownMenuItem
            key={each.label}
            onClick={() =>
              onBorder(each.border, each.style ? { ...line, style: each.style } : line)
            }
          >
            <HugeiconsIcon icon={each.icon} strokeWidth={2} />
            {each.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <HugeiconsIcon icon={RulerIcon} strokeWidth={2} />
            Line style
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-44">
            <DropdownMenuRadioGroup
              value={line.style}
              onValueChange={(style) => setLine({ ...line, style: style as BorderStyle })}
            >
              {BORDER_STYLES.map((style) => (
                <DropdownMenuRadioItem key={style} value={style}>
                  <span
                    aria-hidden
                    className="w-10 shrink-0"
                    // The line itself, as the sheet draws it.
                    style={{ borderTop: edgeCss({ style }) }}
                  />
                  {STYLE_LABELS[style]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <HugeiconsIcon icon={PaintBrush01Icon} strokeWidth={2} />
            Line colour
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-64">
            <div className="p-2">
              <ColorSwatches
                value={line.color}
                resetLabel="Automatic"
                onChange={(color) => setLine(color ? { ...line, color } : { style: line.style })}
              />
            </div>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </ToolbarMenu>
  );
}
