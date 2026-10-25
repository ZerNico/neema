import {
  Analytics01Icon,
  CloudServerIcon,
  CodeIcon,
  Key01Icon,
  Mail01Icon,
  FolderLibraryIcon,
  UserGroupIcon,
  UserMultipleIcon,
  WrenchIcon,
  PlugSocketIcon,
} from "@hugeicons/core-free-icons";
import { m } from "~/paraglide/messages.js";
import type { SectionNavItem } from "~/ui/page-shell.tsx";

/** Admin pages, shared by the section nav and search. Labels are read where shown. */
export const ADMIN_SECTIONS: SectionNavItem[] = [
  {
    to: "/admin/providers",
    get label() {
      return m.admin_section_providers();
    },
    icon: CloudServerIcon,
    matchPrefix: "/admin/providers",
  },
  {
    to: "/admin/tools",
    get label() {
      return m.admin_section_tools();
    },
    icon: WrenchIcon,
    matchPrefix: "/admin/tools",
  },
  {
    to: "/admin/custom-tools",
    get label() {
      return m.admin_section_custom_tools();
    },
    icon: CodeIcon,
    matchPrefix: "/admin/custom-tools",
  },
  {
    to: "/admin/integrations",
    get label() {
      return m.admin_section_integrations();
    },
    icon: PlugSocketIcon,
    matchPrefix: "/admin/integrations",
  },
  {
    to: "/admin/email",
    get label() {
      return m.admin_section_email();
    },
    icon: Mail01Icon,
    matchPrefix: "/admin/email",
  },
  {
    to: "/admin/documents",
    get label() {
      return m.admin_section_documents();
    },
    icon: FolderLibraryIcon,
    matchPrefix: "/admin/documents",
  },
  {
    to: "/admin/auth",
    get label() {
      return m.admin_section_sign_in();
    },
    icon: Key01Icon,
    matchPrefix: "/admin/auth",
  },
  {
    to: "/admin/users",
    get label() {
      return m.admin_section_users();
    },
    icon: UserMultipleIcon,
    matchPrefix: "/admin/users",
  },
  {
    to: "/admin/groups",
    get label() {
      return m.admin_section_groups();
    },
    icon: UserGroupIcon,
    matchPrefix: "/admin/groups",
  },
  {
    to: "/admin/analytics",
    get label() {
      return m.admin_section_analytics();
    },
    icon: Analytics01Icon,
    matchPrefix: "/admin/analytics",
  },
];
