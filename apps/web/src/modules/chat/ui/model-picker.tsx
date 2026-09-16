import { useMemo, useState } from "react";
import { CapabilityIcons } from "~/modules/providers/ui/capability-icons.tsx";
import type { Capabilities } from "~/modules/providers/ui/capability-icons.tsx";
import type { ReactNode } from "react";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxTrigger,
} from "~/ui/primitives/combobox";

export interface PickableModel {
  id: string;
  displayName: string;
  providerName: string;
  contextLength: number | null;
  capabilities: Capabilities | null;
}

interface ProviderGroup {
  /** Doubles as the group heading and as the key. */
  value: string;
  items: PickableModel[];
}

// A model is worth showing for the provider it comes from as much as for its
// own name — "sonnet" and "anthropic" should both find the same row.
const matches = (model: PickableModel, query: string): boolean => {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = `${model.displayName} ${model.providerName}`.toLowerCase();
  return needle.split(/\s+/).every((word) => haystack.includes(word));
};

/**
 * Searchable, provider-grouped model list. Shared by the composer's model
 * button and the retry menu so both offer the same rows, the same grouping and
 * the same typeahead — only the trigger (and an optional header) differs.
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
   * Rendered inside the popup above the search input — extra actions that
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
  // Providers keep the order their models arrive in (display name, from the
  // server), so the list is stable between renders and refetches.
  const groups = useMemo<ProviderGroup[]>(() => {
    const byProvider = new Map<string, ProviderGroup>();
    for (const model of models) {
      const group = byProvider.get(model.providerName);
      if (group) group.items.push(model);
      else byProvider.set(model.providerName, { value: model.providerName, items: [model] });
    }
    return [...byProvider.values()];
  }, [models]);

  const selected = useMemo(
    () => models.find((model) => model.id === value) ?? null,
    [models, value],
  );

  // Controlled only so the header's actions can close the popup; model
  // selection still closes it through the primitive's own change event.
  const [open, setOpen] = useState(false);

  return (
    <Combobox
      open={open}
      onOpenChange={setOpen}
      items={groups}
      value={selected}
      disabled={disabled}
      onValueChange={(model: PickableModel | null) => {
        if (model) onChange(model.id);
      }}
      itemToStringLabel={(model: PickableModel) => model.displayName}
      // Model rows are re-created by every refetch, so identity comparison
      // would drop the tick off the selected one.
      isItemEqualToValue={(a: PickableModel, b: PickableModel) => a.id === b.id}
      filter={(model: PickableModel, query: string) => matches(model, query)}
      autoHighlight
    >
      <ComboboxTrigger render={trigger} disabled={disabled}>
        {children}
      </ComboboxTrigger>
      <ComboboxContent side={side} align={align} className="w-72 min-w-72">
        {header?.({ close: () => setOpen(false) })}
        <ComboboxInput placeholder="Search models…" showTrigger={false} />
        <ComboboxEmpty>{emptyLabel}</ComboboxEmpty>
        <ComboboxList>
          {(group: ProviderGroup) => (
            <ComboboxGroup key={group.value} items={group.items}>
              <ComboboxLabel>{group.value}</ComboboxLabel>
              <ComboboxCollection>
                {(model: PickableModel) => (
                  // oxlint-disable-next-line shadcn/no-restyle -- reserves room for the selected check, which sits absolute at right-2
                  <ComboboxItem key={model.id} value={model} className="pr-9">
                    <span className="min-w-0 flex-1 truncate">{model.displayName}</span>
                    <CapabilityIcons capabilities={model.capabilities} audience="user" />
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
