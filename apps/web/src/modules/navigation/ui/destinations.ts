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
import { m } from "~/paraglide/messages.js";

type Capabilities = Partial<Record<Capability, boolean>>;

const DESTINATIONS = {
  projects: {
    to: "/projects",
    label: m.navigation_projects,
    icon: Folder01Icon,
    gate: "projectsUse",
  },
  agents: { to: "/agents", label: m.navigation_agents, icon: Robot01Icon, gate: "agentsUse" },
  knowledge: {
    to: "/knowledge",
    label: m.navigation_knowledge,
    icon: FolderLibraryIcon,
    gate: "knowledgeUse",
  },
  schedules: {
    to: "/schedules",
    label: m.navigation_schedules,
    icon: Calendar03Icon,
    gate: "schedules",
  },
  skills: { to: "/skills", label: m.navigation_skills, icon: Book02Icon, gate: "skillsUse" },
  chats: { to: "/chats", label: m.navigation_chats, icon: BubbleChatIcon, gate: null },
} as const satisfies Record<
  DestinationId,
  { to: string; label: () => string; icon: unknown; gate: Capability | null }
>;

export type Destination = Omit<(typeof DESTINATIONS)[DestinationId], "label"> & {
  id: DestinationId;
  label: string;
};

const allowed = (id: DestinationId, capabilities: Capabilities | undefined) => {
  const gate = DESTINATIONS[id].gate;
  return gate === null || !!capabilities?.[gate];
};

// The label is read here, so it is in the locale of the page that shows it.
const toDestination = (id: DestinationId): Destination => ({
  id,
  ...DESTINATIONS[id],
  label: DESTINATIONS[id].label(),
});

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
