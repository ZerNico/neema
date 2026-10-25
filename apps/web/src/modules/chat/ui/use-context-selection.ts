import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { agentSelectionQuery } from "~/modules/agents/client/queries.ts";
import { MAX_SELECTED_COLLECTIONS, type ContextSelection } from "./context-picker.tsx";

type AgentIdentity = NonNullable<ContextSelection["agent"]>;
type ContextInput =
  | { mode: "draft"; agent: AgentIdentity | null }
  | {
      mode: "installed";
      agent: (AgentIdentity & { collectionIds: ReadonlyArray<string> }) | null;
    };

/**
 * The agent and the person's own collections for the next message. An agent
 * is one bundle: its collections ride with it and are never part of the
 * selection, only of what is offered and of the per-message limit. A pick the
 * agent also brings stays out of the selection while that agent is chosen.
 */
export function useContextSelection(initial: ContextInput) {
  const agentLocked = initial.mode === "installed";
  const [draftAgent, setDraftAgent] = useState(initial.agent);
  const [picked, setPicked] = useState<ReadonlyArray<string>>([]);
  const agent = agentLocked ? initial.agent : draftAgent;
  const detail = useQuery({
    ...agentSelectionQuery(agent?.id ?? ""),
    enabled: !agentLocked && !!agent?.id,
  });
  const agentCollectionIds: ReadonlySet<string> = new Set(
    initial.mode === "installed"
      ? (initial.agent?.collectionIds ?? [])
      : (detail.data?.collections.map((collection) => collection.id) ?? []),
  );
  const collectionIds = picked.filter((id) => !agentCollectionIds.has(id));
  const selection: ContextSelection = {
    agent: agent
      ? {
          id: agent.id,
          name: agentLocked ? agent.name : (detail.data?.name ?? agent.name),
          icon: (agentLocked ? agent.icon : detail.data?.icon) ?? "robot",
        }
      : null,
    collectionIds,
  };
  return {
    selection,
    detail,
    agentCollectionIds,
    /** How many collections the person may add beside the agent's own. */
    maxCollections: MAX_SELECTED_COLLECTIONS - agentCollectionIds.size,
    agentLocked,
    onAgentChange: (agentId: string | null) => {
      if (agentLocked) return;
      setDraftAgent(agentId ? { id: agentId, name: null } : null);
    },
    // Callers only see the visible picks, so the ones the agent hides are kept.
    onCollectionsChange: (ids: ReadonlyArray<string>) =>
      setPicked([...new Set([...ids, ...picked.filter((id) => agentCollectionIds.has(id))])]),
    sendFields: {
      ...(!agentLocked && agent?.id ? { agentId: agent.id } : {}),
      collectionIds,
    },
    /**
     * Replaces the selection outright. An editor is one instance mounted for
     * the whole view and seeded when an edit opens, like the upload store
     * beside it, so the ids arrive from an event rather than from an effect
     * watching a prop.
     */
    seed: setPicked,
    settle: () => setPicked([]),
  };
}
