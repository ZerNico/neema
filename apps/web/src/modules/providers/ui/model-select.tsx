import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";

/** The one thing every admin model dropdown needs to say about a row. */
export interface ModelSelectOption {
  readonly id: string;
  readonly displayName: string;
  readonly providerName: string;
  /** Extra right-hand detail for the row, e.g. "4096d" for an embedding model. */
  readonly detail?: string | null | undefined;
}

/**
 * The admin-side model dropdown: a plain single-value select, the same rows
 * and the same "Name · Provider" wording wherever an admin picks one model
 * from a list (default model order, semantic search). The chat composer and
 * the agent editor use `ModelPicker` instead — a searchable, capability-
 * annotated combobox — because a user picks from many models often; an admin
 * picks one, rarely.
 *
 * Base UI resolves the trigger's text from `items`, never from the rendered
 * <SelectItem> children, so the label is passed both ways on purpose.
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
  const items = models.map((model) => ({
    value: model.id,
    label: `${model.displayName} · ${model.providerName}`,
  }));
  return (
    <Select
      items={items}
      value={value}
      onValueChange={(next) => onChange(typeof next === "string" ? next : null)}
      disabled={disabled || models.length === 0}
    >
      <SelectTrigger id={id} aria-label={ariaLabel} className={className}>
        <SelectValue placeholder={models.length === 0 ? emptyPlaceholder : placeholder} />
      </SelectTrigger>
      <SelectContent>
        {models.map((model) => (
          <SelectItem key={model.id} value={model.id}>
            {model.displayName}
            <span className="text-muted-foreground ml-2 text-xs">
              {model.providerName}
              {model.detail ? ` · ${model.detail}` : ""}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
