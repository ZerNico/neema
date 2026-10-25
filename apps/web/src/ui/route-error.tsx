import { FileNotFoundIcon } from "@hugeicons/core-free-icons";
import { Link, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { EmptyState, ErrorState } from "~/ui/page-shell.tsx";
import { buttonVariants } from "~/ui/primitives/button";
import { m } from "~/paraglide/messages.js";

export function RouteStatusScreen({ children }: { children: ReactNode }) {
  return <div className="flex h-full min-h-svh items-center justify-center p-6">{children}</div>;
}

function BackToChats() {
  return (
    <Link to="/chats" className={buttonVariants({ variant: "outline", size: "sm" })}>
      {m.ui_route_back_to_chats()}
    </Link>
  );
}

export function RouteError({ error }: ErrorComponentProps) {
  const router = useRouter();
  console.error(error);
  return (
    <RouteStatusScreen>
      <ErrorState
        title={m.ui_route_error_title()}
        className="w-full max-w-lg"
        onRetry={() => {
          void router.invalidate();
        }}
        action={<BackToChats />}
      />
    </RouteStatusScreen>
  );
}

export function RouteNotFound() {
  return (
    <RouteStatusScreen>
      <EmptyState
        icon={FileNotFoundIcon}
        title={m.ui_route_not_found_title()}
        description={m.ui_route_not_found_description()}
        className="w-full max-w-lg"
        action={<BackToChats />}
      />
    </RouteStatusScreen>
  );
}
