import * as m from "motion/react-m";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { CapabilityIcons } from "~/modules/providers/ui/capability-icons.tsx";
import { motionEase, useAppReducedMotion } from "~/ui/motion";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "~/ui/primitives/combobox";
import { rankModels, type PickableModel } from "./model-picker-rank.ts";

export type { PickableModel } from "./model-picker-rank.ts";

// Quick enough to follow the pointer, damped so it settles without a wobble.
const slideSpring = { type: "spring", stiffness: 700, damping: 48, mass: 0.6 } as const;

/**
 * Searchable model list, shared by the composer's model button, the retry menu
 * and the agent and schedule forms, so all of them offer the same rows in the
 * same order with the same typeahead. Only the trigger (and an optional
 * header) differs. One list in the admin's global order; a search ranks it.
 */
export function ModelPicker({
  models,
  value,
  onChange,
  trigger,
  children,
  header,
  disabled = false,
  align = "start",
  side = "top",
  emptyLabel = "No models match",
}: {
  models: readonly PickableModel[];
  /** Currently selected model id; null leaves the list unmarked. */
  value: string | null | undefined;
  onChange: (modelId: string) => void;
  /** Element the trigger renders as, following the DropdownMenuTrigger idiom. */
  trigger: React.ReactElement<Record<string, unknown>>;
  /** Visible trigger content; the primitive appends its own chevron. */
  children?: ReactNode;
  /**
   * Rendered inside the popup above the search input: extra actions that
   * belong to the trigger, not to any model (e.g. the retry menu's
   * "Retry same" row). Gets a `close` so a chosen action can dismiss the
   * popup, which model selection otherwise does on its own.
   */
  header?: (args: { close: () => void }) => ReactNode;
  disabled?: boolean;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom";
  emptyLabel?: string;
}) {
  // Controlled so the header's actions can close the popup, and so the search
  // starts empty each time it opens.
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState<string | null>(null);

  const items = useMemo(() => rankModels(models, query), [models, query]);
  const selected = useMemo(
    () => models.find((model) => model.id === value) ?? null,
    [models, value],
  );
  // With a single provider its name on every row says nothing.
  const showProvider = useMemo(
    () => new Set(models.map((model) => model.providerName)).size > 1,
    [models],
  );

  return (
    <Combobox
      open={open}
      onOpenChange={(next: boolean) => {
        setOpen(next);
        if (next) setQuery("");
      }}
      items={items}
      // rankModels filters and orders; the primitive's filter would only keep or drop.
      filter={null}
      inputValue={query}
      onInputValueChange={setQuery}
      value={selected}
      disabled={disabled}
      onValueChange={(model: PickableModel | null) => {
        if (model) onChange(model.id);
      }}
      onItemHighlighted={(model: PickableModel | undefined) => setHighlighted(model?.id ?? null)}
      itemToStringLabel={(model: PickableModel) => model.displayName}
      // Model rows are re-created by every refetch, so identity comparison
      // would drop the tick off the selected one.
      isItemEqualToValue={(a: PickableModel, b: PickableModel) => a.id === b.id}
      autoHighlight
    >
      <ComboboxTrigger render={trigger} disabled={disabled}>
        {children}
      </ComboboxTrigger>
      <ComboboxContent side={side} align={align} className="w-80 min-w-80">
        {header?.({ close: () => setOpen(false) })}
        <ComboboxInput placeholder="Search models…" showTrigger={false} />
        <ComboboxEmpty>{emptyLabel}</ComboboxEmpty>
        <ComboboxList className="relative">
          <HighlightIndicator id={highlighted} />
          {items.map((model) => (
            <ModelRow key={model.id} model={model} showProvider={showProvider} />
          ))}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

function ModelRow({ model, showProvider }: { model: PickableModel; showProvider: boolean }) {
  const detail = [showProvider ? model.providerName : null, model.description]
    .filter(Boolean)
    .join(" · ");
  return (
    // HighlightIndicator draws the highlight once and slides it between rows.
    <ComboboxItem
      value={model}
      data-model-id={model.id}
      highlight="shared"
      // oxlint-disable-next-line shadcn/no-restyle -- reserves room for the selected check, which sits absolute at right-2
      className="pr-9"
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{model.displayName}</span>
        {detail ? <span className="text-muted-foreground truncate text-xs">{detail}</span> : null}
      </span>
      <CapabilityIcons capabilities={model.capabilities} audience="user" />
    </ComboboxItem>
  );
}

/**
 * One highlight for the whole list that slides to the highlighted row instead
 * of each row lighting up on its own. It sits inside the scrolling list and is
 * placed by the row's offset, so scrolling moves it with the rows for free.
 */
function HighlightIndicator({ id }: { id: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useAppReducedMotion();
  const [box, setBox] = useState<{
    y: number;
    height: number;
    visible: boolean;
    /** Slide only from a visible highlight; one that reappears jumps into place. */
    slide: boolean;
  } | null>(null);

  // Measured after every render: rows move whenever the list is filtered,
  // not only when the highlight changes. Equal boxes keep the
  // previous state, so an unchanged measure does not render again.
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- deliberately every render, see above
  useLayoutEffect(() => {
    const list = ref.current?.parentElement;
    const row =
      id === null
        ? undefined
        : [...(list?.querySelectorAll<HTMLElement>("[data-model-id]") ?? [])].find(
            (element) => element.dataset.modelId === id,
          );
    setBox((previous) => {
      if (!row) return previous?.visible ? { ...previous, visible: false } : previous;
      const next = {
        y: row.offsetTop,
        height: row.offsetHeight,
        visible: true,
        slide: previous?.visible ?? false,
      };
      return previous &&
        previous.visible &&
        previous.y === next.y &&
        previous.height === next.height
        ? previous
        : next;
    });
  });

  const move = box?.slide && !reduced ? slideSpring : { duration: 0 };
  return (
    <m.div
      ref={ref}
      aria-hidden
      className="bg-accent pointer-events-none absolute inset-x-1.5 top-0 rounded-2xl"
      initial={false}
      animate={
        box
          ? { y: box.y, height: box.height, opacity: box.visible ? 1 : 0 }
          : { height: 0, opacity: 0 }
      }
      transition={{ y: move, height: move, opacity: { duration: 0.12, ease: motionEase } }}
    />
  );
}
