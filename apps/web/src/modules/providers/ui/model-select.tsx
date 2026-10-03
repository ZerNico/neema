import { SearchableSelect } from "~/ui/searchable-select.tsx";

/** The one thing every admin model dropdown needs to say about a row. */
export interface ModelSelectOption {
  readonly id: string;
  readonly displayName: string;
  readonly providerName: string;
  /** Extra right-hand detail for the row, e.g. "4096d" for an embedding model. */
  readonly detail?: string | null | undefined;
}

/**
 * The admin-side model dropdown: the same rows and the same "Name, provider"
 * wording wherever an admin picks one model (default model order, semantic
 * search, OCR). Searchable, since every vision model of every provider can be
 * a candidate. The chat composer and agent editor use `ModelPicker` instead,
 * which annotates capabilities for people choosing often.
 */
export function ModelSelect({
  models,
  value,
  onChange,
  placeholder = "Choose a model",
  emptyPlaceholder = "No models available",
  disabled = false,
  id,
  "aria-label": ariaLabel,
  className,
}: {
  models: ReadonlyArray<ModelSelectOption>;
  value: string | null;
  onChange: (modelId: string | null) => void;
  placeholder?: string;
  /** Shown when `models` is empty; the control is disabled then. */
  emptyPlaceholder?: string;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
  className?: string;
}) {
  return (
    <SearchableSelect
      options={models.map((model) => ({
        value: model.id,
        label: model.displayName,
        detail: [model.providerName, model.detail].filter(Boolean).join(" · "),
      }))}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      emptyPlaceholder={emptyPlaceholder}
      searchPlaceholder="Search models…"
      noMatches="No models match"
      disabled={disabled}
      {...(id ? { id } : {})}
      {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
      {...(className ? { className } : {})}
    />
  );
}
