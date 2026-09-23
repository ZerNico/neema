import type { ReactNode } from "react";
import { useSidebar } from "~/ui/primitives/sidebar";

/**
 * Closes the mobile sidebar sheet when any link inside it is followed, or it
 * stays over the page it just opened. shadcn's sidebar leaves this to the app.
 * React events bubble through portals, so links in menus opened from the
 * sidebar count too. The docked desktop sidebar is untouched.
 */
export function ClosesOnLink({ children }: { children: ReactNode }) {
  const { setOpenMobile } = useSidebar();
  return (
    // Keyboard activation of a link dispatches a click, so this needs no key handler.
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div
      className="contents"
      onClick={(event) => {
        // A modified click opens a new tab and leaves this one where it was.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (event.target instanceof Element && event.target.closest("a[href]")) {
          setOpenMobile(false);
        }
      }}
    >
      {children}
    </div>
  );
}
