import {
  CloudServerIcon,
  Logout03Icon,
  Settings02Icon,
  UserCircleIcon,
  UserIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { authClient } from "./client.ts";
import { useIdentityBoundary } from "./identity-boundary.tsx";
import { useDesktopAuth } from "~/modules/desktop/client/bridge.ts";
import { Avatar, AvatarFallback } from "~/ui/primitives/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { SidebarMenuButton } from "~/ui/primitives/sidebar";
import { Spinner } from "~/ui/primitives/spinner";
import { ThemeSwitch } from "~/ui/theme-switch.tsx";
import { toastError } from "~/ui/error-toast.ts";

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
  const accountLabel = `${user.name}, ${user.email}${impersonating ? ", Impersonating" : ""}`;
  const boundary = useIdentityBoundary();
  const desktopAuth = useDesktopAuth();
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
    onError: () =>
      toast.error(
        "Could not stop impersonating. Retry, or sign out and sign in with your admin account.",
      ),
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
    onError: (error) => toastError("Could not sign out. Please retry.", error),
  });
  const pending = stop.isPending || signOut.isPending;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<SidebarMenuButton size="lg" tooltip={accountLabel} />}
        aria-label={accountLabel}
      >
        {/* oxlint-disable-next-line shadcn/no-restyle -- marks an impersonated session, so it is a state signal rather than decoration */}
        <Avatar className={impersonating ? "size-8 ring-2 ring-warning" : "size-8"}>
          <AvatarFallback>
            {user.name.slice(0, 2).toUpperCase() || (
              <HugeiconsIcon icon={UserIcon} strokeWidth={2} className="size-4" />
            )}
          </AvatarFallback>
        </Avatar>
        <div className="grid flex-1 text-left text-sm leading-tight">
          <span className="truncate font-medium">{user.name}</span>
          {impersonating ? (
            <span className="text-warning truncate text-xs font-medium">Impersonating</span>
          ) : (
            <span className="text-muted-foreground truncate text-xs">{user.email}</span>
          )}
        </div>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
        <DropdownMenuItem render={<Link to="/settings" />}>
          <HugeiconsIcon icon={UserCircleIcon} strokeWidth={2} />
          Settings
        </DropdownMenuItem>
        {isAdmin ? (
          <DropdownMenuItem render={<Link to="/admin" />}>
            <HugeiconsIcon icon={Settings02Icon} strokeWidth={2} />
            Admin
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
              Change server
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
            Stop impersonating
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
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
