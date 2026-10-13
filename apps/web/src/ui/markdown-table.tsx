// A Markdown table drawn like every other table in the app, with the app's
// own controls. Streamdown's frame brings its own buttons, menus, icons and
// native title tooltips, none of which match the rest of the app and none of
// which take a class, so the table and its parts are ours.

import { Copy01Icon, Download01Icon, FullScreenIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState, type ComponentProps, type RefObject } from "react";
import {
  extractTableDataFromElement,
  tableDataToCSV,
  tableDataToMarkdown,
  tableDataToTSV,
  type ExtraProps,
} from "streamdown";
import { Button } from "~/ui/primitives/button";
import { Dialog, DialogContent, DialogTitle } from "~/ui/primitives/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/ui/primitives/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { cn } from "~/ui/utils";

const FORMATS = {
  markdown: {
    label: "Markdown",
    extension: "md",
    type: "text/markdown",
    write: tableDataToMarkdown,
  },
  csv: { label: "CSV", extension: "csv", type: "text/csv", write: tableDataToCSV },
  tsv: {
    label: "TSV",
    extension: "tsv",
    type: "text/tab-separated-values",
    write: tableDataToTSV,
  },
} as const;
type Format = keyof typeof FORMATS;

const textOf = (table: RefObject<HTMLTableElement | null>, format: Format) =>
  table.current ? FORMATS[format].write(extractTableDataFromElement(table.current)) : null;

function MenuButton({
  label,
  icon,
  formats,
  onPick,
}: {
  label: string;
  icon: typeof Copy01Icon;
  formats: readonly Format[];
  onPick: (format: Format) => void;
}) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={label}
                  className="text-muted-foreground"
                />
              }
            />
          }
        >
          <HugeiconsIcon icon={icon} strokeWidth={2} />
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        {formats.map((format) => (
          <DropdownMenuItem key={format} onClick={() => onPick(format)}>
            {FORMATS[format].label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TableActions({
  table,
  onExpand,
}: {
  table: RefObject<HTMLTableElement | null>;
  onExpand?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const copy = (format: Format) => {
    const text = textOf(table, format);
    if (text === null) return;
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    });
  };
  const download = (format: Format) => {
    const text = textOf(table, format);
    if (text === null) return;
    const url = URL.createObjectURL(new Blob([text], { type: FORMATS[format].type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `table.${FORMATS[format].extension}`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <MenuButton
        label={copied ? "Copied" : "Copy table"}
        icon={copied ? Tick02Icon : Copy01Icon}
        formats={["markdown", "csv", "tsv"]}
        onPick={copy}
      />
      <MenuButton
        label="Download table"
        icon={Download01Icon}
        formats={["csv", "markdown"]}
        onPick={download}
      />
      {onExpand ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Show full screen"
                onClick={onExpand}
                className="text-muted-foreground"
              />
            }
          >
            <HugeiconsIcon icon={FullScreenIcon} strokeWidth={2} />
          </TooltipTrigger>
          <TooltipContent>Show full screen</TooltipContent>
        </Tooltip>
      ) : null}
    </>
  );
}

/**
 * Rows and cells as every other table in the app draws them (the `Table`
 * primitive, as in ui blocks), except that Markdown cells wrap: they hold
 * prose, where a ui block's hold values.
 */
type Part<T extends keyof React.JSX.IntrinsicElements> = ComponentProps<T> & ExtraProps;

export const MarkdownTableHeader = ({ node: _node, ...props }: Part<"thead">) => (
  <TableHeader {...props} />
);
export const MarkdownTableBody = ({ node: _node, ...props }: Part<"tbody">) => (
  <TableBody {...props} />
);
export const MarkdownTableRow = ({ node: _node, ...props }: Part<"tr">) => <TableRow {...props} />;
export const MarkdownTableHead = ({ node: _node, className, ...props }: Part<"th">) => (
  <TableHead className={cn("whitespace-normal", className)} {...props} />
);
export const MarkdownTableCell = ({ node: _node, className, ...props }: Part<"td">) => (
  <TableCell className={cn("align-top whitespace-normal", className)} {...props} />
);

export function MarkdownTable({
  children,
  className,
  node: _node,
  ...props
}: ComponentProps<"table"> & ExtraProps) {
  const table = useRef<HTMLTableElement>(null);
  const wide = useRef<HTMLTableElement>(null);
  const [expanded, setExpanded] = useState(false);
  return (
    // The header's last cell keeps room at its end for the buttons, so they
    // never cover a heading and cost no height of their own.
    <div className="group/table relative my-4 [&_thead_th:last-child]:pr-28" data-markdown-table>
      <Table ref={table} className={className} {...props}>
        {children}
      </Table>
      {/* Shown on hover where there is hover, always on touch. */}
      <div className="absolute top-2 right-2 flex gap-0.5 transition-opacity duration-150 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within/table:opacity-100 [@media(hover:hover)]:group-hover/table:opacity-100">
        <TableActions table={table} onExpand={() => setExpanded(true)} />
      </div>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="sm:max-w-5xl">
          <div className="flex items-center justify-between gap-2 pr-10">
            <DialogTitle>Table</DialogTitle>
            <div className="flex gap-0.5">
              <TableActions table={wide} />
            </div>
          </div>
          <Table ref={wide} className={className}>
            {children}
          </Table>
        </DialogContent>
      </Dialog>
    </div>
  );
}
