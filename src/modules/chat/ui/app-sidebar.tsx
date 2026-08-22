import {
  Delete02Icon,
  Logout03Icon,
  PencilEdit02Icon,
  PlusSignIcon,
  Settings02Icon,
  UserCircleIcon,
  UserIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { authClient } from "~/modules/auth/client.ts";
import { conversationsQuery } from "../client/queries.ts";
import { ConversationTitle, createTitleRevealRegistry } from "./conversation-title.tsx";
import { deleteConversation, renameConversation } from "../server/functions.ts";
import { Avatar, AvatarFallback } from "~/ui/primitives/avatar";
import { Button } from "~/ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { Input } from "~/ui/primitives/input";
import { useConfirm } from "~/ui/confirm.tsx";
import { ThemeSwitch } from "~/ui/theme-switch.tsx";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "~/ui/primitives/sidebar";

export function AppSidebar({
  user,
}: {
  user: { id: string; name: string; email: string; role?: string | null | undefined };
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: conversations } = useSuspenseQuery(conversationsQuery);
  const params = useParams({ strict: false });
  const activeId = "conversationId" in params ? params.conversationId : undefined;
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  // One registry for the whole shell: rows come and go with refetches, the
  // record of which titles already played their reveal must not.
  const [revealRegistry] = useState(createTitleRevealRegistry);
  const confirm = useConfirm();

  const removeMutation = useMutation({
    mutationFn: (conversationId: string) => deleteConversation({ data: { conversationId } }),
    onSuccess: async (_, conversationId) => {
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
      if (activeId === conversationId) await navigate({ to: "/" });
    },
  });

  const renameMutation = useMutation({
    mutationFn: (input: { conversationId: string; title: string }) =>
      renameConversation({ data: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["conversations"] }),
  });

  const isAdmin = user.role === "admin";

  return (
    <Sidebar>
      <SidebarHeader>
        <Button
          variant="outline"
          className="justify-start gap-2"
          nativeButton={false}
          render={<Link to="/" />}
        >
          <HugeiconsIcon icon={PlusSignIcon} className="size-4" />
          New chat
        </Button>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Chats</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {conversations.map((conversation) => (
                <SidebarMenuItem key={conversation.id}>
                  <SidebarMenuButton
                    isActive={conversation.id === activeId}
                    render={
                      <Link
                        to="/chat/$conversationId"
                        params={{ conversationId: conversation.id }}
                      />
                    }
                  >
                    <ConversationTitle
                      conversationId={conversation.id}
                      title={conversation.title}
                      registry={revealRegistry}
                    />
                  </SidebarMenuButton>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={<SidebarMenuAction showOnHover aria-label="Chat actions" />}
                    >
                      …
                    </DropdownMenuTrigger>
                    <DropdownMenuContent side="right" align="start">
                      <DropdownMenuItem
                        onClick={() =>
                          setRenaming({ id: conversation.id, title: conversation.title ?? "" })
                        }
                      >
                        <HugeiconsIcon icon={PencilEdit02Icon} className="size-4" />
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={async () => {
                          if (
                            await confirm({
                              title: `Delete "${conversation.title ?? "New chat"}"?`,
                              description: "The chat and all its messages are removed permanently.",
                              confirmLabel: "Delete chat",
                            })
                          ) {
                            removeMutation.mutate(conversation.id);
                          }
                        }}
                      >
                        <HugeiconsIcon icon={Delete02Icon} className="size-4" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </SidebarMenuItem>
              ))}
              {conversations.length === 0 ? (
                <p className="text-muted-foreground px-2 py-1.5 text-sm">No chats yet</p>
              ) : null}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger render={<SidebarMenuButton size="lg" />}>
                <Avatar className="size-8">
                  <AvatarFallback>
                    {user.name.slice(0, 2).toUpperCase() || <HugeiconsIcon icon={UserIcon} />}
                  </AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{user.name}</span>
                  <span className="text-muted-foreground truncate text-xs">{user.email}</span>
                </div>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-56">
                <DropdownMenuItem render={<Link to="/settings" />}>
                  <HugeiconsIcon icon={UserCircleIcon} className="size-4" />
                  Settings
                </DropdownMenuItem>
                {isAdmin ? (
                  <DropdownMenuItem render={<Link to="/admin" />}>
                    <HugeiconsIcon icon={Settings02Icon} className="size-4" />
                    Admin
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator />
                <div
                  className="flex items-center px-2 py-1.5"
                  // Keep the menu open while switching themes.
                  onClick={(e) => e.stopPropagation()}
                >
                  <ThemeSwitch className="w-full" />
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={async () => {
                    await authClient.signOut();
                    await navigate({ to: "/login" });
                  }}
                >
                  <HugeiconsIcon icon={Logout03Icon} className="size-4" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename chat</DialogTitle>
          </DialogHeader>
          <Input
            value={renaming?.title ?? ""}
            onChange={(e) => setRenaming((r) => (r ? { ...r, title: e.target.value } : r))}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (renaming && renaming.title.trim()) {
                  renameMutation.mutate({
                    conversationId: renaming.id,
                    title: renaming.title.trim(),
                  });
                  setRenaming(null);
                }
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Sidebar>
  );
}
