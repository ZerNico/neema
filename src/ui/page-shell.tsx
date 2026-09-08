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
import { cn } from "~/ui/utils";

export interface SectionNavItem {
  to: string;
  label: string;
  icon: IconSvgElement;
  /** Marks the item active for any deeper route too (e.g. provider details). */
  matchPrefix: string;
}

// Secondary sidebar layout for sectioned areas (admin, settings). On >=md it
// renders nav + content side by side. On mobile the nav is its own full
// screen; detail pages take over the viewport and get a back button via Page.
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
                  "focus-visible:ring-ring/30 flex h-9 items-center gap-2.5 rounded-2xl px-2.5 text-sm transition-colors outline-none focus-visible:ring-3",
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

// Consistent page chrome: title row with optional back target (shown on
// mobile always, on desktop only for detail pages) and actions slot, then
// the page body. `width="wide"` is for dashboards that want the room.
//
// Page is also the scroll container. The app layout's <main> is a fixed-height
// flex child that never scrolls: the chat view needs it that way (a virtual
// list and a pinned composer share the height), and every other route got its
// own scroller ad hoc until Agents and Knowledge shipped without one. Owning it
// here means a route built from Page scrolls by construction, whether it sits
// under SectionShell or directly in <main>.
export function Page({
  title,
  description,
  backTo,
  backLabel,
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
  return (
    <div className="h-full overflow-y-auto">
      <div
        className={cn(
          "mx-auto flex w-full flex-col gap-6 p-4 md:p-6",
          width === "wide" ? "max-w-6xl" : "max-w-3xl",
        )}
      >
        <header className="flex flex-col gap-1">
          <Link
            to={back.to}
            className={cn(
              "text-muted-foreground hover:text-foreground focus-visible:ring-ring/30 -ml-1 mb-1 flex w-fit items-center gap-1 rounded-2xl text-sm transition-colors outline-none focus-visible:ring-3",
              back.mobileOnly && "md:hidden",
            )}
          >
            <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} className="size-4" />
            {back.label}
          </Link>
          <div className="flex items-center justify-between gap-4">
            <h1 className="text-lg font-medium">{title}</h1>
            {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
          </div>
          {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
        </header>
        {children}
      </div>
    </div>
  );
}

// Titled block within a Page. The eyebrow heading is the one style used for
// every in-page section across admin, settings and tools.
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
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            {title}
          </h2>
          {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

// Shared list-row primitives so providers, models, users and settings read the
// same. Radius sits on the app's 2xl/3xl/4xl scale like every other surface.
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

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon: IconSvgElement;
  title: string;
  description: string;
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
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  );
}

// Failed-to-load state for a query. Distinct from EmptyState ("nothing here
// yet") so the two can't be confused, with a retry when one is available.
export function ErrorState({
  title = "Something went wrong",
  description,
  onRetry,
  className,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
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
      {onRetry ? (
        <EmptyContent>
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}
