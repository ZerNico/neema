// The server has already filtered access and marked the default. Resolve during
// render so the label and search eligibility agree before the owner's effect runs.
export function resolveChatModel<T extends { id: string; isDefault?: boolean }>(
  models: ReadonlyArray<T>,
  modelId: string | null,
): T | undefined {
  return (
    models.find((model) => model.id === modelId) ??
    models.find((model) => model.isDefault) ??
    models[0]
  );
}
