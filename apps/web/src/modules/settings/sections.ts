import {
  Analytics01Icon,
  Archive02Icon,
  Brain02Icon,
  HardDriveIcon,
  ComputerIcon,
  Key01Icon,
  LaptopPhoneSyncIcon,
  McpServerIcon,
  Notification03Icon,
  PaintBoardIcon,
  PlugSocketIcon,
  UserCircleIcon,
} from "@hugeicons/core-free-icons";
import type { SectionNavItem } from "~/ui/page-shell.tsx";
import { m } from "~/paraglide/messages.js";

/** Settings pages, shared by the section nav and search, in a browser. */
// Functions, so the labels are read in the locale of the page.
const settingsSectionList = (): SectionNavItem[] => [
  {
    to: "/settings/profile",
    label: m.settings_section_profile(),
    icon: UserCircleIcon,
    matchPrefix: "/settings/profile",
  },
  {
    to: "/settings/appearance",
    label: m.settings_section_appearance(),
    icon: PaintBoardIcon,
    matchPrefix: "/settings/appearance",
  },
  {
    to: "/settings/memory",
    label: m.settings_section_memory(),
    icon: Brain02Icon,
    matchPrefix: "/settings/memory",
  },
  {
    to: "/settings/notifications",
    label: m.settings_section_notifications(),
    icon: Notification03Icon,
    matchPrefix: "/settings/notifications",
  },
  {
    to: "/settings/integrations",
    label: m.settings_section_integrations(),
    icon: PlugSocketIcon,
    matchPrefix: "/settings/integrations",
  },
  {
    to: "/settings/devices",
    label: m.settings_section_devices(),
    icon: LaptopPhoneSyncIcon,
    matchPrefix: "/settings/devices",
  },
  {
    to: "/settings/connected-apps",
    label: m.settings_section_connected_apps(),
    icon: McpServerIcon,
    matchPrefix: "/settings/connected-apps",
  },
  {
    to: "/settings/api-keys",
    label: m.settings_section_api_keys(),
    icon: Key01Icon,
    matchPrefix: "/settings/api-keys",
  },
  {
    to: "/settings/storage",
    label: m.settings_section_storage(),
    icon: HardDriveIcon,
    matchPrefix: "/settings/storage",
  },
  {
    to: "/settings/archived",
    label: m.settings_section_archived(),
    icon: Archive02Icon,
    matchPrefix: "/settings/archived",
  },
  {
    to: "/settings/usage",
    label: m.settings_section_usage(),
    icon: Analytics01Icon,
    matchPrefix: "/settings/usage",
  },
];

/** What Work may do on this machine, which only the desktop app can set. */
const computerSection = (): SectionNavItem => ({
  to: "/settings/computer",
  label: m.settings_section_computer(),
  icon: ComputerIcon,
  matchPrefix: "/settings/computer",
});

/** The pages for this app: a browser has no computer to set, so it is left out there. */
export const settingsSections = (desktop: boolean): SectionNavItem[] => {
  const sections = settingsSectionList();
  if (!desktop) return sections;
  const at = sections.findIndex((section) => section.to === "/settings/archived");
  return sections.toSpliced(at, 0, computerSection());
};
