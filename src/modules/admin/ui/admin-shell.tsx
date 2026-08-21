import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useMatches } from "@tanstack/react-router";
import type { IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";
import { Button } from "~/ui/primitives/button";
import { cn } from "~/ui/utils";

export interface AdminNavItem {
  to: string;
  label: string;
  icon: IconSvgElement;
  /** Marks the item active for any deeper route too (e.g. provider details). */
  matchPrefix: string;
}

// Secondary sidebar layout for sectioned areas (admin, settings). On >=md it
// renders nav + content side by side. On mobile the nav is its own full
// screen; detail pages take over the viewport and get a back button via
// AdminPage.
export function AdminShell({
  title = "Admin",
  rootPath = "/admin",
  items,
  children,
}: {
  title?: string;
  rootPath?: string;
  items: AdminNavItem[];
  children: ReactNode;
}) {
  const matches = useMatches();
  const path = matches.at(-1)?.pathname ?? "";
  // On mobile, show the nav screen only at the section root.
  const atRoot = path.replace(/\/$/, "") === rootPath;

  return (
    <div className="flex h-full min-h-0">
      <nav
        className={cn(
          "border-border flex w-full shrink-0 flex-col gap-1 border-r p-3 md:w-56",
          atRoot ? "flex" : "hidden md:flex",
        )}
      >
        <div className="flex h-9 items-center gap-1 px-1">
          <Button
            variant="ghost"
            size="icon-sm"
            nativeButton={false}
            aria-label="Back to chat"
            render={<Link to="/" />}
          >
            <HugeiconsIcon icon={ArrowLeft01Icon} className="size-4" />
          </Button>
          <span className="text-sm font-semibold">{title}</span>
        </div>
        <div className="mt-2 flex flex-col gap-0.5">
          {items.map((item) => {
            const active = path.startsWith(item.matchPrefix);
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors",
                  active
                    ? "bg-accent text-accent-foreground font-medium"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <HugeiconsIcon icon={item.icon} className="size-4" />
                {item.label}
              </Link>
            );
          })}
        </div>
      </nav>
      <div className={cn("min-w-0 flex-1 overflow-y-auto", atRoot && "hidden md:block")}>
        {children}
      </div>
    </div>
  );
}

// Consistent page chrome for admin content: title row with optional back
// target (shown on mobile always, on desktop only for detail pages) and
// actions slot, then the page body.
export function AdminPage({
  title,
  description,
  backTo,
  backLabel,
  rootPath = "/admin",
  rootLabel = "Admin",
  actions,
  children,
}: {
  title: ReactNode;
  description?: string;
  backTo?: string;
  backLabel?: string;
  /** Mobile-only back target when no explicit backTo is given. */
  rootPath?: string;
  rootLabel?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 md:p-6">
      <header className="flex flex-col gap-1">
        {backTo ? (
          <Link
            to={backTo}
            className="text-muted-foreground hover:text-foreground -ml-1 mb-1 flex w-fit items-center gap-1 text-sm transition-colors"
          >
            <HugeiconsIcon icon={ArrowLeft01Icon} className="size-4" />
            {backLabel ?? "Back"}
          </Link>
        ) : (
          // Mobile-only back to the admin nav screen
          <Link
            to={rootPath}
            className="text-muted-foreground hover:text-foreground -ml-1 mb-1 flex w-fit items-center gap-1 text-sm transition-colors md:hidden"
          >
            <HugeiconsIcon icon={ArrowLeft01Icon} className="size-4" />
            {rootLabel}
          </Link>
        )}
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-lg font-semibold">{title}</h1>
          {actions}
        </div>
        {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
      </header>
      {children}
    </div>
  );
}

// Shared list-row primitives so providers, models, and users read the same.
export function ListCard({ children }: { children: ReactNode }) {
  return (
    <div className="border-border divide-border divide-y overflow-hidden rounded-lg border">
      {children}
    </div>
  );
}

export function ListRow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("bg-background flex items-center gap-3 px-4 py-3", className)}>
      {children}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: IconSvgElement;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="border-border flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center">
      <div className="bg-muted text-muted-foreground flex size-10 items-center justify-center rounded-full">
        <HugeiconsIcon icon={icon} className="size-5" />
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
      {action}
    </div>
  );
}
