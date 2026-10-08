import {
  Book02Icon,
  BubbleChatIcon,
  Calendar03Icon,
  Folder01Icon,
  FolderLibraryIcon,
  Robot01Icon,
} from "@hugeicons/core-free-icons";
import type { Capability } from "~/modules/groups/policy.ts";
import { DESTINATION_IDS, type DestinationId } from "../schema.ts";

type Capabilities = Partial<Record<Capability, boolean>>;

const DESTINATIONS = {
  projects: { to: "/projects", label: "Projects", icon: Folder01Icon, gate: "projectsUse" },
  agents: { to: "/agents", label: "Agents", icon: Robot01Icon, gate: "agentsUse" },
  knowledge: {
    to: "/knowledge",
    label: "Knowledge",
    icon: FolderLibraryIcon,
    gate: "knowledgeUse",
  },
  schedules: { to: "/schedules", label: "Schedules", icon: Calendar03Icon, gate: "schedules" },
  skills: { to: "/skills", label: "Skills", icon: Book02Icon, gate: "skillsUse" },
  chats: { to: "/chats", label: "Chats", icon: BubbleChatIcon, gate: null },
} as const satisfies Record<
  DestinationId,
  { to: string; label: string; icon: unknown; gate: Capability | null }
>;

export type Destination = (typeof DESTINATIONS)[DestinationId] & { id: DestinationId };

const allowed = (id: DestinationId, capabilities: Capabilities | undefined) => {
  const gate = DESTINATIONS[id].gate;
  return gate === null || !!capabilities?.[gate];
};

const toDestination = (id: DestinationId): Destination => ({ id, ...DESTINATIONS[id] });

/** Every page this person may open, in the "…" menu's order. */
export const availableDestinations = (capabilities: Capabilities | undefined) =>
  DESTINATION_IDS.filter((id) => allowed(id, capabilities)).map(toDestination);

/**
 * The rail's pages, in rail order whatever order the list arrived in. A pin to
 * a page the person lost access to is kept but hidden, so it comes back if
 * access does.
 */
export const pinnedDestinations = (
  pinned: ReadonlyArray<DestinationId>,
  capabilities: Capabilities | undefined,
) =>
  DESTINATION_IDS.filter((id) => pinned.includes(id) && allowed(id, capabilities)).map(
    toDestination,
  );
