import { FileNotFoundIcon } from "@hugeicons/core-free-icons";
import { Link, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { EmptyState, ErrorState } from "~/ui/page-shell.tsx";
import { buttonVariants } from "~/ui/primitives/button";

export function RouteStatusScreen({ children }: { children: ReactNode }) {
  return <div className="flex h-full min-h-svh items-center justify-center p-6">{children}</div>;
}

function BackToChats() {
  return (
    <Link to="/chats" className={buttonVariants({ variant: "outline", size: "sm" })}>
      Back to chats
    </Link>
  );
}

export function RouteError({ error }: ErrorComponentProps) {
  const router = useRouter();
  console.error(error);
  return (
    <RouteStatusScreen>
      <ErrorState
        title="Could not load this page"
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
        title="Page not found"
        description="This page doesn’t exist, or the link is no longer available."
        className="w-full max-w-lg"
        action={<BackToChats />}
      />
    </RouteStatusScreen>
  );
}
