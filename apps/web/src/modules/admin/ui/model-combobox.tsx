import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { fetchProviderCatalog } from "../server/functions.ts";
import { MODEL_TYPE_LABELS } from "./model-settings-labels.ts";
import type { ImageFamily } from "@chat/model-client/image-families";
import type {
  ModelCapabilities,
  ModelPricing,
  ModelType,
} from "~/modules/providers/model-config.ts";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "~/ui/primitives/combobox";

export interface CatalogPick {
  id: string;
  name: string;
  type: ModelType;
  contextLength: number | null;
  capabilities?: ModelCapabilities;
  /** USD per 1M tokens, when the catalog stated prices. */
  pricing?: ModelPricing | null;
  /** True when the entry was typed by the user rather than picked from the catalog. */
  custom?: boolean;
  /** The family an image entry is called with. */
  imageFamily?: ImageFamily;
}

/**
 * Autocomplete over the provider's live /models catalog. While typing, a
 * creatable row (`Add "x" as custom model`) is appended so ids the catalog
 * doesn't know, or a fully unavailable catalog, still go through the normal
 * selection flow.
 */
export function ModelCombobox({
  providerId,
  inputId,
  onPick,
  onInput,
  disabled = false,
  placeholder,
}: {
  providerId: string;
  /** Forwarded to the text input so a FieldLabel can point at it. */
  inputId?: string;
  onPick: (model: CatalogPick) => void;
  /** Fires on every keystroke with the raw text, for free-text fallback. */
  onInput?: (text: string) => void;
  disabled?: boolean;
  /** Replaces the search prompt, e.g. where names are typed rather than found. */
  placeholder?: string;
}) {
  const [input, setInput] = useState("");

  const catalog = useQuery({
    queryKey: ["provider-catalog", providerId],
    queryFn: () => fetchProviderCatalog({ data: { providerId } }),
    staleTime: 5 * 60_000,
  });

  const models = useMemo<CatalogPick[]>(
    () => (catalog.data?.ok ? [...catalog.data.models] : []),
    [catalog.data],
  );

  const items = useMemo<CatalogPick[]>(() => {
    const typed = input.trim();
    if (!typed || models.some((m) => m.id === typed)) return models;
    // The custom row's label equals the typed text, so it always survives
    // Base UI's own filtering and sits at the end of the matches.
    return [...models, { id: typed, name: typed, type: "chat", contextLength: null, custom: true }];
  }, [models, input]);

  return (
    <Combobox
      items={items}
      disabled={disabled}
      itemToStringLabel={(item: CatalogPick) => item.id}
      onValueChange={(value: CatalogPick | null) => {
        if (value) onPick(value);
      }}
      onInputValueChange={(text: string) => {
        setInput(text);
        onInput?.(text);
      }}
    >
      <ComboboxInput
        id={inputId}
        placeholder={
          placeholder ??
          (catalog.isLoading
            ? "Loading models…"
            : catalog.data?.ok === false
              ? "Catalog unavailable, type a model ID"
              : "Search models or type an ID…")
        }
      />
      <ComboboxContent>
        <ComboboxEmpty>Type a model ID to add it.</ComboboxEmpty>
        <ComboboxList>
          {(item: CatalogPick) =>
            item.custom ? (
              <ComboboxItem key="__custom__" value={item}>
                <span className="flex items-center gap-2">
                  <HugeiconsIcon
                    icon={PlusSignIcon}
                    strokeWidth={2}
                    className="text-muted-foreground size-4"
                  />
                  <span>
                    Add “<span className="font-medium">{item.id}</span>” as custom model
                  </span>
                </span>
              </ComboboxItem>
            ) : (
              // A model that both chats and draws is listed once per type.
              <ComboboxItem key={`${item.type}:${item.id}`} value={item}>
                <span className="flex flex-col">
                  <span>{item.id}</span>
                  <span className="text-muted-foreground text-xs">
                    {item.name}
                    {item.contextLength ? ` · ${Math.round(item.contextLength / 1000)}k ctx` : ""}
                    {` · ${MODEL_TYPE_LABELS[item.type]}`}
                  </span>
                </span>
              </ComboboxItem>
            )
          }
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
