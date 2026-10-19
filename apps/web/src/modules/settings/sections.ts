import {
  Analytics01Icon,
  Archive02Icon,
  Brain02Icon,
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

/** Settings pages, shared by the section nav and search. */
export const SETTINGS_SECTIONS: SectionNavItem[] = [
  {
    to: "/settings/profile",
    label: "Profile",
    icon: UserCircleIcon,
    matchPrefix: "/settings/profile",
  },
  {
    to: "/settings/appearance",
    label: "Appearance",
    icon: PaintBoardIcon,
    matchPrefix: "/settings/appearance",
  },
  {
    to: "/settings/memory",
    label: "Memory",
    icon: Brain02Icon,
    matchPrefix: "/settings/memory",
  },
  {
    to: "/settings/notifications",
    label: "Notifications",
    icon: Notification03Icon,
    matchPrefix: "/settings/notifications",
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
    icon: LaptopPhoneSyncIcon,
    matchPrefix: "/settings/devices",
  },
  {
    to: "/settings/connected-apps",
    label: "Connected apps",
    icon: McpServerIcon,
    matchPrefix: "/settings/connected-apps",
  },
  {
    to: "/settings/api-keys",
    label: "API keys",
    icon: Key01Icon,
    matchPrefix: "/settings/api-keys",
  },
  {
    to: "/settings/computer",
    label: "This computer",
    icon: ComputerIcon,
    matchPrefix: "/settings/computer",
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
