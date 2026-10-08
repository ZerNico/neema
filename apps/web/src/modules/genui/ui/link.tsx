import { useState, type ReactNode } from "react";
import { LeaveDialog } from "~/ui/leave-dialog.tsx";

/** A link a block drew: it leaves the app only after the reader confirms where to. */
export function UiLink({ href, children }: { href: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <a
        href={href}
        className="text-primary underline underline-offset-4"
        onClick={(event) => {
          event.preventDefault();
          setOpen(true);
        }}
      >
        {children}
      </a>
      <LeaveDialog
        isOpen={open}
        url={href}
        onClose={() => setOpen(false)}
        onConfirm={() => {
          window.open(href, "_blank", "noopener,noreferrer");
          setOpen(false);
        }}
      />
    </>
  );
}
