import {
  MoreHorizontalIcon,
  PencilEdit02Icon,
  PinIcon,
  SidebarLeftIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { Link, useRouterState } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { capabilitiesQuery } from "~/modules/groups/client/queries.ts";
import { NeemaGlyph } from "~/ui/brand.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "~/ui/primitives/popover";
import {
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "~/ui/primitives/sidebar";
import { collapseMotion } from "~/ui/motion-presets.ts";
import { useAppReducedMotion } from "~/ui/reduced-motion.ts";
import { cn } from "~/ui/utils";
import { sidebarPinsQuery, useTogglePin } from "../client/queries.ts";
import { DEFAULT_PINS, type DestinationId } from "../schema.ts";
import { useRailTooltip } from "./use-rail-tooltip.ts";
import { availableDestinations, pinnedDestinations, type Destination } from "./destinations.ts";

/**
 * The sidebar's first column: the toggle, a new chat, the pages the person
 * pinned, "…" for the rest, and the account at the foot. It stays when the
 * chat panel beside it collapses.
 */
export function SidebarNavRail({ account }: { account: ReactNode }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const trimmed = pathname.replace(/\/$/, "");
  const { data: capabilities } = useQuery(capabilitiesQuery);
  const { data: pins } = useQuery(sidebarPinsQuery);
  const pinned = pins?.pinned ?? DEFAULT_PINS;
  const tooltip = useRailTooltip();
  const isActive = (destination: Destination) => trimmed.startsWith(destination.to);
  const available = availableDestinations(capabilities);
  const onRail = pinnedDestinations(pinned, capabilities);
  const pinMotion = collapseMotion(useAppReducedMotion());

  return (
    <nav aria-label="Main" className="flex w-(--sidebar-width-icon) shrink-0 flex-col gap-2 p-2">
      <SidebarMenu>
        <RailToggle />
        <SidebarMenuItem>
          <SidebarMenuButton
            size="icon"
            aria-label="New chat"
            tooltip={tooltip("New chat")}
            render={<Link to="/" />}
          >
            <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
          </SidebarMenuButton>
        </SidebarMenuItem>
        {/* A pin grows in and an unpin closes up, so the rail never jumps. The
          menu's gap moves inside the animated height, or a closed pin would
          still hold it until it unmounts. */}
        <AnimatePresence initial={false}>
          {onRail.map((destination) => (
            <SidebarMenuItem key={destination.id} className="-mt-0.5">
              <m.div {...pinMotion}>
                <div className="pt-0.5">
                  <SidebarMenuButton
                    size="icon"
                    aria-label={destination.label}
                    tooltip={tooltip(destination.label)}
                    isActive={isActive(destination)}
                    render={<Link to={destination.to} />}
                  >
                    <HugeiconsIcon icon={destination.icon} strokeWidth={2} />
                  </SidebarMenuButton>
                </div>
              </m.div>
            </SidebarMenuItem>
          ))}
        </AnimatePresence>
        <MoreDestinations
          destinations={available}
          pinned={pinned}
          isActive={isActive}
          // Where you are shows on "…" when that page is not on the rail.
          holdsActive={available.some(
            (destination) => !pinned.includes(destination.id) && isActive(destination),
          )}
        />
      </SidebarMenu>
      <SidebarMenu className="mt-auto">
        <SidebarMenuItem>{account}</SidebarMenuItem>
      </SidebarMenu>
    </nav>
  );
}

function RailToggle() {
  const { open, isMobile, toggleSidebar } = useSidebar();
  const tooltip = useRailTooltip();
  const closes = isMobile || open;
  const label = closes ? "Close sidebar" : "Open sidebar";
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="icon"
        aria-label={label}
        tooltip={tooltip(label)}
        onClick={toggleSidebar}
      >
        {closes ? (
          <HugeiconsIcon icon={SidebarLeftIcon} strokeWidth={2} />
        ) : (
          // Collapsed, the rail's top is the brand until a pointer or focus
          // reaches it, then says what a click does.
          <>
            <NeemaGlyph
              aria-hidden
              className="group-hover/menu-button:hidden group-focus-visible/menu-button:hidden"
            />
            <HugeiconsIcon
              icon={SidebarLeftIcon}
              strokeWidth={2}
              aria-hidden
              className="hidden group-hover/menu-button:block group-focus-visible/menu-button:block"
            />
          </>
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function MoreDestinations({
  destinations,
  pinned,
  isActive,
  holdsActive,
}: {
  destinations: ReadonlyArray<Destination>;
  pinned: ReadonlyArray<DestinationId>;
  isActive: (destination: Destination) => boolean;
  holdsActive: boolean;
}) {
  const [open, setOpen] = useState(false);
  const tooltip = useRailTooltip();
  const toggle = useTogglePin();
  return (
    <SidebarMenuItem>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <SidebarMenuButton
              size="icon"
              aria-label="More"
              tooltip={tooltip("More")}
              isActive={holdsActive}
            />
          }
        >
          <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
        </PopoverTrigger>
        {/* Pinning moves "…" along the rail; the open list stays where it is. */}
        <PopoverContent
          side="right"
          align="start"
          disableAnchorTracking
          // oxlint-disable-next-line shadcn/no-restyle -- a menu of rows, not a padded form popover
          className="w-56 gap-0 p-1.5"
        >
          {/* A popover rather than a menu: each row holds a link and a pin
            toggle, and a menu item cannot hold a second control. */}
          <SidebarMenu>
            {destinations.map((destination) => {
              const isPinned = pinned.includes(destination.id);
              return (
                <SidebarMenuItem key={destination.id}>
                  <SidebarMenuButton
                    isActive={isActive(destination)}
                    render={<Link to={destination.to} onClick={() => setOpen(false)} />}
                  >
                    <HugeiconsIcon icon={destination.icon} strokeWidth={2} />
                    <span>{destination.label}</span>
                  </SidebarMenuButton>
                  <SidebarMenuAction
                    showOnHover={!isPinned}
                    aria-pressed={isPinned}
                    aria-label={`${isPinned ? "Unpin" : "Pin"} ${destination.label}`}
                    className={cn(!isPinned && "text-muted-foreground")}
                    onClick={() => toggle.mutate(destination.id)}
                  >
                    <HugeiconsIcon icon={PinIcon} strokeWidth={2} />
                  </SidebarMenuAction>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </PopoverContent>
      </Popover>
    </SidebarMenuItem>
  );
}
