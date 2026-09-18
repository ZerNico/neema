import { Alert02Icon, ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useMatches } from "@tanstack/react-router";
import type { IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";
import { cardSurfaceClassName } from "~/ui/card.tsx";
import { Button, buttonVariants } from "~/ui/primitives/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/ui/primitives/empty";
import { Skeleton } from "~/ui/primitives/skeleton";
import { cn } from "~/ui/utils";
import { focusRingClassName } from "~/ui/focus-ring.ts";

export interface SectionNavItem {
  to: string;
  label: string;
  icon: IconSvgElement;
  /** Marks the item active for any deeper route too (e.g. provider details). */
  matchPrefix: string;
}

/**
 * Secondary sidebar layout for sectioned areas (admin, settings). On >=md it
 * renders nav + content side by side. On mobile the nav is its own full
 * screen; detail pages take over the viewport and get a back button via Page.
 */
export function SectionShell({
  title,
  rootPath,
  items,
  children,
}: {
  title: string;
  rootPath: string;
  items: SectionNavItem[];
  children: ReactNode;
}) {
  const matches = useMatches();
  const path = matches.at(-1)?.pathname ?? "";
  // On mobile, show the nav screen only at the section root.
  const atRoot = path.replace(/\/$/, "") === rootPath;

  return (
    <div className="flex h-full min-h-0">
      <nav
        aria-label={title}
        className={cn(
          "border-border flex w-full shrink-0 flex-col gap-1 border-r p-3 md:w-56",
          atRoot ? "flex" : "hidden md:flex",
        )}
      >
        <div className="flex h-9 items-center gap-1 px-1">
          <Link
            to="/"
            aria-label="Back to chat"
            className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
          >
            <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
          </Link>
          <span className="text-sm font-medium">{title}</span>
        </div>
        <div className="mt-2 flex flex-col gap-0.5">
          {items.map((item) => {
            const active = path.startsWith(item.matchPrefix);
            return (
              <Link
                key={item.to}
                to={item.to}
                aria-current={active ? "page" : undefined}
                className={cn(
                  focusRingClassName,
                  "flex h-9 items-center gap-2.5 rounded-2xl px-2.5 text-sm transition-colors",
                  active
                    ? "bg-accent text-accent-foreground font-medium"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <HugeiconsIcon icon={item.icon} strokeWidth={2} className="size-4" />
                {item.label}
              </Link>
            );
          })}
        </div>
      </nav>
      {/* Page provides the scroll container, so a page body never has two. */}
      <div className={cn("min-w-0 min-h-0 flex-1", atRoot && "hidden md:block")}>{children}</div>
    </div>
  );
}

/**
 * Consistent page chrome: title row with optional back target (shown on
 * mobile always, on desktop only for detail pages) and actions slot, then
 * the page body. `width="wide"` is for dashboards that want the room.
 *
 * Page is the scroll container; see docs/internals/ui.md#page-chrome-and-layout
 * for why <main> itself never scrolls.
 */
export function Page({
  title,
  description,
  backTo,
  backLabel,
  onBack,
  rootPath = "/admin",
  rootLabel = "Admin",
  actions,
  width = "default",
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  backTo?: string;
  backLabel?: string;
  /** Returns to a previous step within the route; replaces the back link. */
  onBack?: () => void;
  /** Mobile-only back target when no explicit backTo is given. */
  rootPath?: string;
  rootLabel?: string;
  actions?: ReactNode;
  width?: "default" | "wide";
  children: ReactNode;
}) {
  const back = backTo
    ? { to: backTo, label: backLabel ?? "Back", mobileOnly: false }
    : { to: rootPath, label: rootLabel, mobileOnly: true };
  const backClassName = cn(
    focusRingClassName,
    "text-muted-foreground hover:text-foreground -ml-1 mb-1 flex w-fit items-center gap-1 rounded-2xl text-sm transition-colors",
  );
  return (
    <div className="h-full overflow-y-auto">
      <div
        className={cn(
          "mx-auto flex w-full flex-col gap-6 p-4 md:p-6",
          width === "wide" ? "max-w-6xl" : "max-w-3xl",
        )}
      >
        <header className="flex flex-col gap-1">
          {onBack ? (
            <button type="button" className={backClassName} onClick={onBack}>
              <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} className="size-4" />
              {backLabel ?? "Back"}
            </button>
          ) : (
            <Link to={back.to} className={cn(backClassName, back.mobileOnly && "md:hidden")}>
              <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} className="size-4" />
              {back.label}
            </Link>
          )}
          <div className="flex flex-wrap items-center justify-between gap-4">
            <h1 className="min-w-0 break-words text-lg font-medium">{title}</h1>
            {actions ? (
              <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>
            ) : null}
          </div>
          {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
        </header>
        {children}
      </div>
    </div>
  );
}

/**
 * Titled block within a Page. The eyebrow heading is the one style used for
 * every in-page section across admin, settings and tools.
 */
export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0 flex flex-col gap-1 break-words">
          <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            {title}
          </h2>
          {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
        </div>
        {actions ? (
          <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/**
 * The row a section acts from: Save/Apply/Reset, or a control paired with the
 * button that consumes it. Left-aligned below the fields, not `Section`'s
 * `actions` slot ("add one of these" by the heading). See
 * docs/internals/ui.md#page-chrome-and-layout for why this exists.
 */
export function FormActions({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-wrap items-center gap-2", className)}>{children}</div>;
}

/**
 * Shared list-row primitives so providers, models, users and settings read the
 * same. Radius sits on the app's 2xl/3xl/4xl scale like every other surface.
 */
export function ListCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn(cardSurfaceClassName, "divide-border divide-y overflow-hidden", className)}>
      {children}
    </div>
  );
}

export function ListRow({
  children,
  className,
  interactive = false,
}: {
  children: ReactNode;
  className?: string;
  /** Row is (or wraps) a link: adds hover feedback. */
  interactive?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 px-4 py-3",
        interactive && "hover:bg-accent/50 transition-colors",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * The one loading shape for a list-shaped page: for windows a loader can't
 * cover (no-preload routes, a query that only starts once interactive). Same
 * shape everywhere, or each module invents its own.
 */
export function ListSkeleton({
  rows = 3,
  media = "tile",
  label = "Loading",
}: {
  rows?: number;
  /** Matches the row anatomy being stood in for: icon tile, avatar, or neither. */
  media?: "tile" | "avatar" | "none";
  label?: string;
}) {
  return (
    <div role="status" aria-label={label}>
      <ListCard>
        {Array.from({ length: rows }, (_, key) => (
          <ListRow key={key}>
            {media === "none" ? null : (
              <Skeleton className={cn("size-9 shrink-0", media === "avatar" && "rounded-full")} />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Skeleton className="h-3.5 w-32 max-w-full" />
              <Skeleton className="h-3 w-48 max-w-full" />
            </div>
          </ListRow>
        ))}
      </ListCard>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon: IconSvgElement;
  title: string;
  /** Optional, like `ErrorState`: a title that already says it needs no sentence under it. */
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <Empty className={cn("border-border rounded-3xl border border-dashed", className)}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <HugeiconsIcon icon={icon} strokeWidth={2} />
        </EmptyMedia>
        <EmptyTitle className="text-sm">{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  );
}

/**
 * Failed-to-load state for a query. Distinct from EmptyState ("nothing here
 * yet") so the two can't be confused, with a retry when one is available.
 */
export function ErrorState({
  title = "Something went wrong",
  description,
  onRetry,
  action,
  className,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
  /** Extra way out besides retry; route errors use this for a home link. */
  action?: ReactNode;
  className?: string;
}) {
  return (
    <Empty role="alert" className={cn("border-border rounded-3xl border border-dashed", className)}>
      <EmptyHeader>
        <EmptyMedia variant="icon" className="text-destructive">
          <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} />
        </EmptyMedia>
        <EmptyTitle className="text-sm">{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {onRetry || action ? (
        <EmptyContent>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {onRetry ? (
              <Button variant="outline" size="sm" onClick={onRetry}>
                Try again
              </Button>
            ) : null}
            {action}
          </div>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}
