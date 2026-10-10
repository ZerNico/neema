import { Toolbar } from "@base-ui/react/toolbar";
import {
  ArrowDown01Icon,
  Redo02Icon,
  TextAlignCenterIcon,
  TextAlignLeftIcon,
  TextAlignRightIcon,
  TextBoldIcon,
  TextItalicIcon,
  TextWrapIcon,
  Undo02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { CellStyle } from "@chat/sheet-react/display";
import type { StylePatch } from "@chat/sheet/model/ops";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { Action, Format } from "../../ui/rich-editor/toolbar.tsx";

/** Number formats a person picks by name; the code is what a cell keeps. */
const NUMBER_FORMATS = [
  { label: "Automatic", code: null },
  { label: "Number", code: "#,##0.00" },
  { label: "Percent", code: "0.00%" },
  { label: "Currency", code: "$#,##0.00" },
  { label: "Date", code: "yyyy-mm-dd" },
  { label: "Time", code: "h:mm" },
  { label: "Text", code: "@" },
] as const;
const ALIGNMENTS = [
  { value: "left", label: "Align left", icon: TextAlignLeftIcon },
  { value: "center", label: "Align centre", icon: TextAlignCenterIcon },
  { value: "right", label: "Align right", icon: TextAlignRightIcon },
] as const;

/** A sheet's formatting row; `style` is the active cell's, which the buttons show pressed. */
export function SheetToolbar({
  style,
  canUndo,
  canRedo,
  readOnly,
  onUndo,
  onRedo,
  onFormat,
}: {
  style: CellStyle;
  canUndo: boolean;
  canRedo: boolean;
  readOnly: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onFormat: (patch: StylePatch) => void;
}) {
  if (readOnly) return null;
  const current = NUMBER_FORMATS.find((each) => each.code === (style.numberFormat ?? null));
  return (
    <Toolbar.Root aria-label="Formatting" className="flex min-w-0 flex-1 items-center gap-0.5">
      <Action icon={Undo02Icon} label="Undo" shortcut="⌘Z" disabled={!canUndo} onPress={onUndo} />
      <Action icon={Redo02Icon} label="Redo" shortcut="⇧⌘Z" disabled={!canRedo} onPress={onRedo} />
      <Toolbar.Separator className="bg-border mx-1 h-4 w-px" />
      <Format
        icon={TextBoldIcon}
        label="Bold"
        shortcut="⌘B"
        pressed={!!style.bold}
        onPress={() => onFormat({ bold: style.bold ? null : true })}
      />
      <Format
        icon={TextItalicIcon}
        label="Italic"
        shortcut="⌘I"
        pressed={!!style.italic}
        onPress={() => onFormat({ italic: style.italic ? null : true })}
      />
      <Format
        icon={TextWrapIcon}
        label="Wrap text"
        pressed={!!style.wrap}
        onPress={() => onFormat({ wrap: style.wrap ? null : true })}
      />
      <Toolbar.Separator className="bg-border mx-1 h-4 w-px" />
      {ALIGNMENTS.map((alignment) => (
        <Format
          key={alignment.value}
          icon={alignment.icon}
          label={alignment.label}
          pressed={style.horizontal === alignment.value}
          onPress={() =>
            onFormat({
              horizontal: style.horizontal === alignment.value ? null : alignment.value,
            })
          }
        />
      ))}
      <Toolbar.Separator className="bg-border mx-1 h-4 w-px" />
      <DropdownMenu>
        <Toolbar.Button
          render={
            <DropdownMenuTrigger
              render={
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  onMouseDown={(event) => event.preventDefault()}
                />
              }
            />
          }
        >
          {current?.label ?? "Custom"}
          <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} data-icon="inline-end" />
        </Toolbar.Button>
        <DropdownMenuContent align="start" className="w-40">
          {NUMBER_FORMATS.map((format) => (
            <DropdownMenuItem
              key={format.label}
              onClick={() => onFormat({ numberFormat: format.code })}
            >
              {format.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </Toolbar.Root>
  );
}
