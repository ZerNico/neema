import {
  CloudServerIcon,
  HelpCircleIcon,
  Logout03Icon,
  SecurityIcon,
  Settings02Icon,
  UserIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { authClient } from "./client.ts";
import { useIdentityBoundary } from "./identity-context.ts";
import { useDesktopAuth } from "~/modules/desktop/client/bridge.ts";
import { initials } from "~/ui/initials";
import { Avatar, AvatarFallback } from "~/ui/primitives/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { SidebarMenuButton } from "~/ui/primitives/sidebar";
import { useRailTooltip } from "~/modules/navigation/ui/use-rail-tooltip.ts";
import { Spinner } from "~/ui/primitives/spinner";
import { ThemeSwitch } from "~/ui/theme-switch.tsx";
import { toastError } from "~/ui/error-toast.ts";
import { m } from "~/paraglide/messages.js";

async function signOutSession() {
  const { error } = await authClient.signOut();
  if (error) throw new Error(error.message);
}

export function AccountMenu({
  user,
  impersonating = false,
}: {
  user: { name: string; email: string; role?: string | null | undefined };
  impersonating?: boolean;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isAdmin = user.role === "admin";
  const accountLabel = (impersonating ? m.auth_menu_label_impersonating : m.auth_menu_label)({
    name: user.name,
    email: user.email,
  });
  const boundary = useIdentityBoundary();
  const desktopAuth = useDesktopAuth();
  const tooltip = useRailTooltip();
  const changeServer = useMutation({
    mutationFn: () => desktopAuth!.changeServer(),
    onError: (cause) => toast.error(cause.message),
  });
  const stop = useMutation({
    mutationFn: async () => {
      if (!boundary) throw new Error("Missing identity boundary");
      await boundary.changeIdentity(async () => {
        const { error } = await authClient.admin.stopImpersonating();
        if (error) throw new Error(error.message);
      }, "/admin/users");
    },
    onError: () => toast.error(m.auth_menu_error_stop()),
  });
  const signOut = useMutation({
    mutationFn: async () => {
      if (impersonating) {
        if (!boundary) throw new Error("Missing identity boundary");
        await boundary.changeIdentity(signOutSession, "/login");
      } else {
        await signOutSession();
        queryClient.clear();
        await navigate({ to: "/login" });
      }
    },
    onError: (error) => toastError(m.auth_menu_error_sign_out(), error),
  });
  const pending = stop.isPending || signOut.isPending;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<SidebarMenuButton size="icon" tooltip={tooltip(accountLabel)} />}
        aria-label={accountLabel}
      >
        {/* oxlint-disable-next-line shadcn/no-restyle -- marks an impersonated session, so it is a state signal rather than decoration */}
        <Avatar className={impersonating ? "size-8 ring-2 ring-warning" : "size-8"}>
          <AvatarFallback>
            {user.name.trim() ? (
              initials(user.name)
            ) : (
              <HugeiconsIcon icon={UserIcon} strokeWidth={2} className="size-4" />
            )}
          </AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            <span className="text-foreground block truncate font-medium">{user.name}</span>
            {impersonating ? (
              <span className="text-warning block truncate font-medium">
                {m.auth_menu_impersonating()}
              </span>
            ) : (
              <span className="block truncate">{user.email}</span>
            )}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link to="/settings" />}>
          <HugeiconsIcon icon={Settings02Icon} strokeWidth={2} />
          {m.auth_menu_settings()}
        </DropdownMenuItem>
        <DropdownMenuItem render={<Link to="/help" />}>
          <HugeiconsIcon icon={HelpCircleIcon} strokeWidth={2} />
          {m.auth_menu_help()}
        </DropdownMenuItem>
        {isAdmin ? (
          <DropdownMenuItem render={<Link to="/admin" />}>
            <HugeiconsIcon icon={SecurityIcon} strokeWidth={2} />
            {m.auth_menu_admin()}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        {/* Same inset as a DropdownMenuItem so the switch lines up
            with the rows around it. */}
        <div
          className="flex items-center px-3 py-2"
          // Keep the menu open while switching themes.
          onClick={(e) => e.stopPropagation()}
        >
          <ThemeSwitch className="w-full" />
        </div>
        <DropdownMenuSeparator />
        {desktopAuth?.canChangeServer ? (
          <>
            <DropdownMenuItem
              disabled={changeServer.isPending}
              onClick={() => changeServer.mutate()}
            >
              <HugeiconsIcon icon={CloudServerIcon} strokeWidth={2} />
              {m.auth_menu_change_server()}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {impersonating && (
          <DropdownMenuItem
            disabled={pending}
            aria-busy={stop.isPending || undefined}
            closeOnClick={false}
            onClick={() => stop.mutate()}
          >
            {stop.isPending ? (
              <Spinner aria-hidden />
            ) : (
              <HugeiconsIcon icon={UserIcon} strokeWidth={2} />
            )}
            {m.auth_menu_stop_impersonating()}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          disabled={pending}
          aria-busy={signOut.isPending || undefined}
          closeOnClick={false}
          onClick={() => signOut.mutate()}
        >
          {signOut.isPending ? (
            <Spinner aria-hidden />
          ) : (
            <HugeiconsIcon icon={Logout03Icon} strokeWidth={2} />
          )}
          {m.auth_menu_sign_out()}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
