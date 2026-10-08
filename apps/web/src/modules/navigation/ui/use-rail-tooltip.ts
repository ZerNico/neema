import { useSidebar } from "~/ui/primitives/sidebar";

/** The rail is icon-only even when expanded, so its labels live in tooltips. */
export function useRailTooltip() {
  const { isMobile } = useSidebar();
  return (label: string) => ({ children: label, hidden: isMobile });
}
