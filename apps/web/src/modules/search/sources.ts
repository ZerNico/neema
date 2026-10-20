import {
  Book02Icon,
  BubbleChatIcon,
  Calendar03Icon,
  ComputerIcon,
  Folder01Icon,
  FolderLibraryIcon,
  HelpCircleIcon,
  IncognitoIcon,
  Moon02Icon,
  PlusSignIcon,
  Robot01Icon,
  SecurityIcon,
  Settings02Icon,
  SidebarLeftIcon,
  Sun03Icon,
} from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import { ADMIN_SECTIONS } from "~/modules/admin/sections.ts";
import { useAgentSearch } from "~/modules/agents/client/search.ts";
import { useProjectSearch } from "~/modules/projects/client/search.ts";
import { sessionUserQuery } from "~/modules/auth/client.ts";
import { useChatSearch } from "~/modules/chat/client/search.ts";
import { capabilitiesQuery } from "~/modules/groups/client/queries.ts";
import type { Capabilities } from "~/modules/groups/policy.ts";
import { useCollectionSearch } from "~/modules/knowledge/client/search.ts";
import { useScheduleSearch } from "~/modules/schedules/client/search.ts";
import { useDesktop } from "~/modules/desktop/client/bridge.ts";
import { settingsSections } from "~/modules/settings/sections.ts";
import { useSkillSearch } from "~/modules/skills/client/search.ts";
import { setTheme } from "~/ui/theme.tsx";
import { useSidebar } from "~/ui/primitives/sidebar";
import { matchesWords } from "./match.ts";
import {
  collectGroups,
  parsePaletteQuery,
  RESULT_LIMIT,
  type SearchItem,
  type SearchResults,
  type SearchSource,
} from "./registry.ts";

type Entry = SearchItem & { keywords?: string };

const matching = (entries: ReadonlyArray<Entry | false | undefined>, query: string) =>
  entries.filter(
    (entry): entry is Entry =>
      !!entry && matchesWords(`${entry.label} ${entry.keywords ?? ""}`, query),
  );

/** Things to do rather than find. All of them fit, so an empty query lists them all. */
const useActionSearch: SearchSource = (query, active) => {
  const { data: capabilities } = useQuery(capabilitiesQuery);
  const { toggleSidebar } = useSidebar();
  const can = (capability: keyof Capabilities) => !!capabilities?.[capability];
  const items = matching(
    [
      { id: "action:new-chat", label: "New chat", icon: PlusSignIcon, href: "/" },
      {
        id: "action:new-temporary-chat",
        label: "New temporary chat",
        keywords: "incognito private",
        icon: IncognitoIcon,
        href: "/?temporary=1",
      },
      can("agentsCreate") && {
        id: "action:new-agent",
        label: "New agent",
        icon: Robot01Icon,
        href: "/agents/new",
      },
      can("schedules") && {
        id: "action:new-schedule",
        label: "New schedule",
        icon: Calendar03Icon,
        href: "/schedules/new",
      },
      can("skillsCreate") && {
        id: "action:new-skill",
        label: "New skill",
        icon: Book02Icon,
        href: "/skills/new",
      },
      can("skillsCreate") && {
        id: "action:import-skill",
        label: "Import skill",
        icon: Book02Icon,
        href: "/skills/import",
      },
      {
        id: "action:theme-light",
        label: "Use light theme",
        keywords: "appearance mode",
        icon: Sun03Icon,
        run: () => setTheme("light"),
      },
      {
        id: "action:theme-dark",
        label: "Use dark theme",
        keywords: "appearance mode night",
        icon: Moon02Icon,
        run: () => setTheme("dark"),
      },
      {
        id: "action:theme-system",
        label: "Use system theme",
        keywords: "appearance mode automatic",
        icon: ComputerIcon,
        run: () => setTheme("system"),
      },
      {
        id: "action:toggle-sidebar",
        label: "Toggle sidebar",
        keywords: "hide show",
        icon: SidebarLeftIcon,
        run: toggleSidebar,
      },
    ],
    query,
  );
  return { heading: "Actions", kind: "action", items: active ? items : [], pending: false };
};

const page = (to: string, label: string, icon: SearchItem["icon"], detail?: string) => ({
  id: `page:${to}`,
  label,
  icon,
  href: to,
  ...(detail ? { detail, keywords: detail } : {}),
});

/** App pages you may open, only once something is typed so they don't crowd recents. */
const usePageSearch: SearchSource = (query, active) => {
  const { data: capabilities } = useQuery(capabilitiesQuery);
  const { data: user } = useQuery(sessionUserQuery);
  const desktop = useDesktop();
  const can = (capability: keyof Capabilities) => !!capabilities?.[capability];
  const items =
    active && query
      ? matching(
          [
            page("/chats", "Chats", BubbleChatIcon),
            can("projectsUse") && page("/projects", "Projects", Folder01Icon),
            can("agentsUse") && page("/agents", "Agents", Robot01Icon),
            can("knowledgeUse") && page("/knowledge", "Knowledge", FolderLibraryIcon),
            can("schedules") && page("/schedules", "Schedules", Calendar03Icon),
            can("skillsUse") && page("/skills", "Skills", Book02Icon),
            page("/help", "Help", HelpCircleIcon),
            page("/settings", "Settings", Settings02Icon),
            ...settingsSections(desktop !== null).map((section) =>
              page(section.to, section.label, section.icon, "Settings"),
            ),
            ...(user?.role === "admin"
              ? [
                  page("/admin", "Admin", SecurityIcon),
                  ...ADMIN_SECTIONS.map((section) =>
                    page(section.to, section.label, section.icon, "Admin"),
                  ),
                ]
              : []),
          ],
          query,
        ).slice(0, RESULT_LIMIT)
      : [];
  return { heading: "Pages", kind: "result", items, pending: false };
};

/**
 * Every search source, called in display order. Adding a kind of thing to the
 * palette is one line here: a `SearchSource` hook from its own module.
 */
export function useSearchGroups(input: string, open: boolean) {
  const { actionsOnly, query } = parsePaletteQuery(input);
  // `>` narrows to actions; the other sources go quiet rather than disappear,
  // since hooks cannot be skipped.
  const everything = open && !actionsOnly;
  const sources: SearchResults[] = [
    useChatSearch(query, everything),
    useActionSearch(query, open),
    usePageSearch(query, everything),
    useProjectSearch(query, everything),
    useAgentSearch(query, everything),
    useCollectionSearch(query, everything),
    useSkillSearch(query, everything),
    useScheduleSearch(query, everything),
  ];
  return collectGroups(sources);
}
