import {
  Analytics01Icon,
  Archive02Icon,
  Brain02Icon,
  ComputerIcon,
  PlugSocketIcon,
  UserCircleIcon,
} from "@hugeicons/core-free-icons";
import type { SectionNavItem } from "~/ui/page-shell.tsx";

/** Settings pages, shared by the section nav and search. */
export const SETTINGS_SECTIONS: SectionNavItem[] = [
  {
    to: "/settings/profile",
    label: "Profile",
    icon: UserCircleIcon,
    matchPrefix: "/settings/profile",
  },
  {
    to: "/settings/memory",
    label: "Memory",
    icon: Brain02Icon,
    matchPrefix: "/settings/memory",
  },
  {
    to: "/settings/integrations",
    label: "Integrations",
    icon: PlugSocketIcon,
    matchPrefix: "/settings/integrations",
  },
  {
    to: "/settings/devices",
    label: "Devices",
    icon: ComputerIcon,
    matchPrefix: "/settings/devices",
  },
  {
    to: "/settings/archived",
    label: "Archived chats",
    icon: Archive02Icon,
    matchPrefix: "/settings/archived",
  },
  {
    to: "/settings/usage",
    label: "Usage",
    icon: Analytics01Icon,
    matchPrefix: "/settings/usage",
  },
];
