import { ArrowRight01Icon, Folder01Icon, MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { ConversationMenu } from "~/modules/chat/ui/conversation-actions.tsx";
import { useConversationActions } from "~/modules/chat/ui/use-conversation-actions.tsx";
import { capabilitiesQuery } from "~/modules/groups/client/queries.ts";
import { DisclosureContent } from "~/ui/disclosure.tsx";
import { disclosureChevronMotionClassName } from "~/ui/disclosure-classes.ts";
import { Collapsible, CollapsibleTrigger } from "~/ui/primitives/collapsible";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "~/ui/primitives/sidebar";
import { cn } from "~/ui/utils";
import { projectChatsQuery, projectsQuery } from "../client/queries.ts";
import type { ProjectSummary } from "../schema.ts";

/** Chats listed under an open project; the rest are a click away on its page. */
const SIDEBAR_CHATS = 5;
const GROUP_OPEN_KEY = "chat.sidebar.projects-open";

const readGroupOpen = () => {
  try {
    return localStorage.getItem(GROUP_OPEN_KEY) !== "false";
  } catch {
    return true;
  }
};

/**
 * The person's projects in the sidebar, each collapsed until opened, with
 * their own chats in it underneath. The project holding the chat on screen
 * opens by itself, so where you are is always visible.
 */
export function ProjectsSidebarGroup({
  activeConversationId,
  activeProjectId,
}: {
  activeConversationId: string | undefined;
  /** The project of the chat on screen, when the list knows it. */
  activeProjectId: string | null;
}) {
  const { data: capabilities } = useQuery(capabilitiesQuery);
  const projects = useQuery({ ...projectsQuery, enabled: !!capabilities?.projectsUse });
  const params = useParams({ strict: false });
  const routeProjectId = "projectId" in params ? params.projectId : undefined;
  const [open, setOpen] = useState(readGroupOpen);
  if (!capabilities?.projectsUse || !projects.data?.length) return null;
  const current = activeProjectId ?? routeProjectId ?? null;
  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        try {
          localStorage.setItem(GROUP_OPEN_KEY, String(next));
        } catch {
          // Private mode: the choice lasts for this page only.
        }
      }}
    >
      <SidebarGroup>
        <SidebarGroupLabel render={<CollapsibleTrigger />}>
          Projects
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            strokeWidth={2}
            className={cn("ml-1", disclosureChevronMotionClassName, open && "rotate-90")}
            aria-hidden
          />
        </SidebarGroupLabel>
        <DisclosureContent>
          <SidebarGroupContent>
            <SidebarMenu>
              {projects.data.map((project) => (
                <ProjectItem
                  key={project.id}
                  project={project}
                  current={project.id === current}
                  activeConversationId={activeConversationId}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </DisclosureContent>
      </SidebarGroup>
    </Collapsible>
  );
}

function ProjectItem({
  project,
  current,
  activeConversationId,
}: {
  project: ProjectSummary;
  current: boolean;
  activeConversationId: string | undefined;
}) {
  const [open, setOpen] = useState(current);
  // Opens when it becomes the current project; never closes itself after.
  const [wasCurrent, setWasCurrent] = useState(current);
  if (current !== wasCurrent) {
    setWasCurrent(current);
    if (current) setOpen(true);
  }
  // Loaded on first open, then kept: removing the list as the panel closes
  // left it nothing to collapse, so closing had no motion.
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  const routeParams = useParams({ strict: false });
  const onProjectPage = "projectId" in routeParams && routeParams.projectId === project.id;
  return (
    <Collapsible open={open} onOpenChange={setOpen} render={<SidebarMenuItem />}>
      <SidebarMenuButton
        isActive={onProjectPage}
        render={<Link to="/projects/$projectId" params={{ projectId: project.id }} />}
      >
        <HugeiconsIcon icon={Folder01Icon} strokeWidth={2} />
        <span>{project.name}</span>
      </SidebarMenuButton>
      <SidebarMenuAction
        render={<CollapsibleTrigger />}
        aria-label={open ? `Hide chats in ${project.name}` : `Show chats in ${project.name}`}
      >
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          strokeWidth={2}
          className={cn(disclosureChevronMotionClassName, open && "rotate-90")}
        />
      </SidebarMenuAction>
      <DisclosureContent>
        {opened ? (
          <ProjectChats projectId={project.id} activeConversationId={activeConversationId} />
        ) : null}
      </DisclosureContent>
    </Collapsible>
  );
}

function ProjectChats({
  projectId,
  activeConversationId,
}: {
  projectId: string;
  activeConversationId: string | undefined;
}) {
  const chats = useQuery(projectChatsQuery(projectId));
  const actions = useConversationActions();
  const rows = chats.data ?? [];
  if (!chats.data) return null;
  return (
    // The same rows as the chat list, indented under their project, so they
    // read at the same size and keep the same menu; the top margin is the
    // menu's own row gap, which a nested list does not get from its parent.
    <SidebarMenu className="mt-0.5 ml-6 w-auto">
      {rows.length === 0 ? (
        <SidebarMenuItem>
          {/* A row's height and inset, so it lines up with chat titles. */}
          <span className="text-muted-foreground flex h-9 items-center px-3 text-sm">
            No chats yet
          </span>
        </SidebarMenuItem>
      ) : null}
      {rows.slice(0, SIDEBAR_CHATS).map((chat) => (
        <SidebarMenuItem key={chat.id}>
          <SidebarMenuButton
            isActive={chat.id === activeConversationId}
            render={<Link to="/chat/$conversationId" params={{ conversationId: chat.id }} />}
          >
            <span>{chat.title ?? "New chat"}</span>
          </SidebarMenuButton>
          <ConversationMenu
            conversation={{ id: chat.id, title: chat.title, projectId }}
            actions={actions}
            trigger={<SidebarMenuAction showOnHover aria-label="Chat actions" />}
          >
            <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
          </ConversationMenu>
        </SidebarMenuItem>
      ))}
      {rows.length > SIDEBAR_CHATS ? (
        <SidebarMenuItem>
          <SidebarMenuButton render={<Link to="/projects/$projectId" params={{ projectId }} />}>
            <span className="text-muted-foreground">All chats</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : null}
      {actions.renameDialog}
    </SidebarMenu>
  );
}
