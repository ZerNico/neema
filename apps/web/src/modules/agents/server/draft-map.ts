import type { DraftSettings } from "../draft-schema.ts";
import type { StoredAgent } from "./repo.ts";

/** A saved agent as editable draft settings; the draft store stays agent-free. */
export const storedAgentToDraftSettings = ({
  row,
  collectionIds,
  skillIds,
  customToolIds,
  integrationIds,
}: StoredAgent): DraftSettings => ({
  name: row.name,
  description: row.description,
  icon: row.icon as DraftSettings["icon"],
  instructions: row.instructions,
  modelId: row.modelId,
  imageModelId: row.imageModelId,
  searchEnabled: row.searchEnabled,
  planEnabled: row.planEnabled,
  starters: row.starters,
  collectionIds,
  skillIds,
  customToolIds,
  integrationIds,
});
