import type { ComponentProps } from "react";
import { Button } from "~/ui/primitives/button";
import { Spinner } from "~/ui/primitives/spinner";
import { cn } from "~/ui/utils";

/**
 * A button whose size never changes while its action runs: the label fades
 * out in place and a spinner sits over it, so neither the button nor its
 * neighbours move. The label only goes transparent, so it still names the
 * button. `form.SubmitButton` renders through this component for TanStack Form;
 * see docs/internals/ui.md#buttons-and-pending-state.
 */
export function PendingButton({
  pending,
  disabled,
  children,
  className,
  ...props
}: ComponentProps<typeof Button> & { pending: boolean }) {
  return (
    <Button
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      className={cn("relative", className)}
      {...props}
    >
      <span
        className={cn(
          "inline-flex items-center gap-[inherit] transition-opacity",
          pending && "opacity-0",
        )}
      >
        {children}
      </span>
      {pending ? <Spinner aria-hidden className="absolute inset-0 m-auto" /> : null}
    </Button>
  );
}
