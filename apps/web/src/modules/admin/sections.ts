import {
  Analytics01Icon,
  CloudServerIcon,
  CodeIcon,
  Key01Icon,
  FolderLibraryIcon,
  UserGroupIcon,
  UserMultipleIcon,
  WrenchIcon,
  PlugSocketIcon,
} from "@hugeicons/core-free-icons";
import type { SectionNavItem } from "~/ui/page-shell.tsx";

/** Admin pages, shared by the section nav and search. */
export const ADMIN_SECTIONS: SectionNavItem[] = [
  {
    to: "/admin/providers",
    label: "Providers",
    icon: CloudServerIcon,
    matchPrefix: "/admin/providers",
  },
  {
    to: "/admin/tools",
    label: "Tools",
    icon: WrenchIcon,
    matchPrefix: "/admin/tools",
  },
  {
    to: "/admin/custom-tools",
    label: "Custom tools",
    icon: CodeIcon,
    matchPrefix: "/admin/custom-tools",
  },
  {
    to: "/admin/integrations",
    label: "Integrations",
    icon: PlugSocketIcon,
    matchPrefix: "/admin/integrations",
  },
  {
    to: "/admin/documents",
    label: "Documents",
    icon: FolderLibraryIcon,
    matchPrefix: "/admin/documents",
  },
  {
    to: "/admin/auth",
    label: "Sign-in",
    icon: Key01Icon,
    matchPrefix: "/admin/auth",
  },
  {
    to: "/admin/users",
    label: "Users",
    icon: UserMultipleIcon,
    matchPrefix: "/admin/users",
  },
  {
    to: "/admin/groups",
    label: "Groups",
    icon: UserGroupIcon,
    matchPrefix: "/admin/groups",
  },
  {
    to: "/admin/analytics",
    label: "Analytics",
    icon: Analytics01Icon,
    matchPrefix: "/admin/analytics",
  },
];
