import { Toolbar } from "@base-ui/react/toolbar";
import { MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "~/ui/primitives/button";
import { Popover, PopoverContent, PopoverTrigger } from "~/ui/primitives/popover";
import { Tabs, TabsList, TabsTrigger } from "~/ui/primitives/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";

/**
 * A ribbon as Word's: Undo and Redo,
 * tabs, and what the caller keeps at the row's end, then the selected tab's
 * groups on one line.
 */

const Separator = () => <Toolbar.Separator className="bg-border mx-1 h-4 w-px" />;

/** One labelled group of a ribbon tab, as Excel's Font or Alignment. */
export interface RibbonGroup {
  readonly id: string;
  readonly label: string;
  readonly controls: ReactNode;
}
/** Room kept for the More button when some groups do not fit. */
const MORE_PX = 40;

/**
 * A tab's groups on one line. Groups that do not fit go, last first, into a
 * More popover that holds the same controls, as Excel's simplified ribbon
 * does; each group is measured while it is on the line.
 */
function RibbonRow({ label, groups }: { label: string; groups: readonly RibbonGroup[] }) {
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  const [room, setRoom] = useState(Number.POSITIVE_INFINITY);
  const [widths, setWidths] = useState<Readonly<Record<string, number>>>({});
  useEffect(() => {
    if (!row) return;
    const observer = new ResizeObserver(([entry]) => setRoom(entry?.contentRect.width ?? 0));
    observer.observe(row);
    return () => observer.disconnect();
  }, [row]);
  const measure = (id: string) => (element: HTMLDivElement | null) => {
    if (!element) return;
    const width = element.offsetWidth;
    setWidths((known) => (known[id] === width ? known : { ...known, [id]: width }));
  };
  const total = groups.reduce((sum, group) => sum + (widths[group.id] ?? 0), 0);
  // The first group always stays, so a narrow panel still has its commonest controls.
  const ends = groups.reduce<number[]>(
    (sums, group) => [...sums, (sums.at(-1) ?? 0) + (widths[group.id] ?? 0)],
    [],
  );
  const fitting = ends.findIndex((end, index) => index > 0 && end > room - MORE_PX);
  const shown = total <= room || fitting === -1 ? groups.length : fitting;
  // Even the first group cut short: More then holds it too, so nothing is out of reach.
  const cut = total > room && (ends[0] ?? 0) > room - MORE_PX;
  const more = groups.slice(cut ? 0 : shown);
  return (
    <div ref={setRow} className="flex min-w-0 items-center overflow-hidden">
      {/* The line clips before the More button does, so what did not fit stays reachable. */}
      <Toolbar.Root aria-label={label} className="flex min-w-0 items-center overflow-hidden">
        {groups.slice(0, shown).map((group, index) => (
          <div
            key={group.id}
            ref={measure(group.id)}
            role="group"
            aria-label={group.label}
            className="flex shrink-0 items-center gap-0.5"
          >
            {index ? <Separator /> : null}
            {group.controls}
          </div>
        ))}
      </Toolbar.Root>
      {more.length ? (
        <Popover>
          <Tooltip>
            <TooltipTrigger
              render={
                <PopoverTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`More ${label} tools`}
                      className="text-muted-foreground shrink-0"
                    />
                  }
                />
              }
            >
              <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
            </TooltipTrigger>
            <TooltipContent>More</TooltipContent>
          </Tooltip>
          <PopoverContent align="end" className="w-auto max-w-96">
            <Toolbar.Root aria-label={`More ${label} tools`} className="flex flex-col gap-3">
              {more.map((group) => (
                <div
                  key={group.id}
                  role="group"
                  aria-label={group.label}
                  className="flex flex-col gap-1"
                >
                  <span className="text-muted-foreground text-xs">{group.label}</span>
                  <div className="flex flex-wrap items-center gap-0.5">{group.controls}</div>
                </div>
              ))}
            </Toolbar.Root>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}

/** One tab of a ribbon: its name and its groups, in the order they give way to More. */
export interface RibbonTab<Name extends string> {
  readonly value: Name;
  readonly label: string;
  readonly groups: readonly RibbonGroup[];
}

/**
 * The tab row and the selected tab's line. `history` leads the row; `extra`
 * ends it. In a panel too narrow for one line, the tabs take a line of their own.
 */
export function Ribbon<Name extends string>({
  tabs,
  history,
  extra,
  extraLabel,
}: {
  tabs: readonly RibbonTab<Name>[];
  history: ReactNode;
  extra?: ReactNode;
  /** What the end of the row holds, for assistive tech. */
  extraLabel?: string;
}) {
  const [tab, setTab] = useState<Name>(tabs[0]!.value);
  const selected = tabs.find((each) => each.value === tab) ?? tabs[0]!;
  return (
    // A size container: in a panel too narrow for one line, the tabs take a line of their own.
    <Tabs
      value={selected.value}
      onValueChange={(next: Name) => setTab(next)}
      className="@container min-w-0 flex-1"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <Toolbar.Root aria-label="History" className="flex shrink-0 items-center gap-0.5">
          {history}
        </Toolbar.Root>
        <TabsList
          variant="line"
          size="sm"
          className="@max-[25rem]:order-last @max-[25rem]:basis-full"
        >
          {tabs.map((each) => (
            <TabsTrigger key={each.value} value={each.value}>
              {each.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {extra ? (
          <Toolbar.Root
            aria-label={extraLabel ?? "More actions"}
            className="ml-auto flex shrink-0 items-center"
          >
            {extra}
          </Toolbar.Root>
        ) : null}
      </div>
      <RibbonRow key={selected.value} label={selected.label} groups={selected.groups} />
    </Tabs>
  );
}
