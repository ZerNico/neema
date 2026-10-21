import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { CapabilityIcons } from "~/modules/providers/ui/capability-icons.tsx";
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
  limited = false,
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
  /** Picking to answer now: a model whose usage limit is used up cannot be chosen. */
  limited?: boolean;
}) {
  // Controlled so the header's actions can close the popup, and so the search
  // starts empty each time it opens.
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // When the list opened: a limit whose reset has passed since it loaded frees its model.
  const [openedAt, setOpenedAt] = useState(0);

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
        if (next) {
          setQuery("");
          setOpenedAt(Date.now());
        }
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
        <ComboboxList>
          {items.map((model) => (
            <ModelRow
              key={model.id}
              model={model}
              showProvider={showProvider}
              respectLimit={limited}
              now={openedAt}
            />
          ))}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

/** "Available again at 14:00", or on another day "Available again Monday 1 Dec". */
const availableAgain = (iso: string) => {
  const at = new Date(iso);
  const today = new Date().toDateString() === at.toDateString();
  return `Available again ${
    today
      ? `at ${at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
      : at.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" })
  }`;
};

function ModelRow({
  model,
  showProvider,
  respectLimit,
  now,
}: {
  model: PickableModel;
  showProvider: boolean;
  respectLimit: boolean;
  now: number;
}) {
  const limited =
    respectLimit && model.limitedUntil && new Date(model.limitedUntil).getTime() > now
      ? model.limitedUntil
      : null;
  const detail = limited
    ? availableAgain(limited)
    : [showProvider ? model.providerName : null, model.description].filter(Boolean).join(" · ");
  return (
    <ComboboxItem
      value={model}
      disabled={limited !== null}
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
