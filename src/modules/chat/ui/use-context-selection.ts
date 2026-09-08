import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { agentSelectionQuery } from "~/modules/agents/client/queries.ts";
import type { ContextSelection } from "./context-picker.tsx";

type AgentIdentity = NonNullable<ContextSelection["agent"]>;
type ContextInput =
  | { mode: "draft"; agent: AgentIdentity | null }
  | {
      mode: "installed";
      agent:
        | (AgentIdentity & {
            collectionIds: ReadonlyArray<string>;
            skillIds?: ReadonlyArray<string>;
          })
        | null;
    };

/** Association is fixed; identity/dependencies refresh and standalone inputs stay local. */
export function useContextSelection(initial: ContextInput) {
  const agentLocked = initial.mode === "installed";
  const [draftAgent, setDraftAgent] = useState(initial.agent);
  const [standalone, setStandalone] = useState<ReadonlyArray<string>>([]);
  const agent = agentLocked ? initial.agent : draftAgent;
  const detail = useQuery({
    ...agentSelectionQuery(agent?.id ?? ""),
    enabled: !agentLocked && !!agent?.id,
  });
  const agentCollectionIds = new Set(
    initial.mode === "installed"
      ? (initial.agent?.collectionIds ?? [])
      : (detail.data?.collections.map((collection) => collection.id) ?? []),
  );
  const agentSkillIds = new Set(
    initial.mode === "installed"
      ? (initial.agent?.skillIds ?? [])
      : (detail.data?.skills?.map((skill) => skill.id) ?? []),
  );
  const selection: ContextSelection = {
    agent: agent
      ? {
          id: agent.id,
          name: agentLocked ? agent.name : (detail.data?.name ?? agent.name),
          icon: (agentLocked ? agent.icon : detail.data?.icon) ?? "robot",
        }
      : null,
    collectionIds: [...new Set([...agentCollectionIds, ...standalone])],
  };
  return {
    selection,
    detail,
    agentCollectionIds,
    agentSkillIds,
    agentLocked,
    onAgentChange: (agentId: string | null) => {
      if (agentLocked) return;
      setDraftAgent(agentId ? { id: agentId, name: null } : null);
    },
    onCollectionsChange: (next: ReadonlyArray<string>, additions: ReadonlyArray<string> = []) => {
      setStandalone(
        next.filter(
          (id) => !agentCollectionIds.has(id) || standalone.includes(id) || additions.includes(id),
        ),
      );
    },
    sendFields: {
      ...(!agentLocked && agent?.id ? { agentId: agent.id } : {}),
      collectionIds: standalone,
    },
    settle: () => setStandalone([]),
  };
}
