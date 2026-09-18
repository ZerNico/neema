import type { ComponentProps } from "react";
import { Button } from "~/ui/primitives/button";
import { Spinner } from "~/ui/primitives/spinner";

/**
 * A button that keeps its label while its action runs: a spinner slides in
 * ahead of the text, so it never reflows. `form.SubmitButton` renders through
 * this component for TanStack Form; see docs/internals/ui.md#buttons-and-pending-state.
 */
export function PendingButton({
  pending,
  disabled,
  children,
  ...props
}: ComponentProps<typeof Button> & { pending: boolean }) {
  return (
    <Button disabled={disabled || pending} aria-busy={pending || undefined} {...props}>
      {pending ? <Spinner data-icon="inline-start" aria-hidden /> : null}
      {children}
    </Button>
  );
}
