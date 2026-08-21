import { useQuery } from "@tanstack/react-query";
import { fetchProviderCatalog } from "../server/functions.ts";
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
  type: "chat" | "embedding" | "image" | "audio";
  contextLength: number | null;
}

// Autocomplete over the provider's live /models catalog. Falls back to free
// text when the provider does not expose a model list.
export function ModelCombobox({
  providerId,
  onPick,
}: {
  providerId: string;
  onPick: (model: CatalogPick) => void;
}) {
  const catalog = useQuery({
    queryKey: ["provider-catalog", providerId],
    queryFn: () => fetchProviderCatalog({ data: { providerId } }),
    staleTime: 5 * 60_000,
  });

  const models = catalog.data?.ok ? catalog.data.models : [];

  return (
    <Combobox
      items={models}
      itemToStringLabel={(item: CatalogPick) => item.id}
      onValueChange={(value: CatalogPick | null) => {
        if (value) onPick(value);
      }}
    >
      <ComboboxInput
        placeholder={
          catalog.isLoading
            ? "Loading models…"
            : catalog.data?.ok === false
              ? "Catalog unavailable — type a model id"
              : "Search models…"
        }
      />
      <ComboboxContent>
        <ComboboxEmpty>No models found.</ComboboxEmpty>
        <ComboboxList>
          {(item: CatalogPick) => (
            <ComboboxItem key={item.id} value={item}>
              <span className="flex flex-col">
                <span>{item.id}</span>
                <span className="text-muted-foreground text-xs">
                  {item.name}
                  {item.contextLength ? ` · ${Math.round(item.contextLength / 1000)}k ctx` : ""}
                  {` · ${item.type}`}
                </span>
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
