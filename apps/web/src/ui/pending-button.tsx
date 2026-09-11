import type { ComponentProps } from "react";
import { Button } from "~/ui/primitives/button";
import { Spinner } from "~/ui/primitives/spinner";

// A button that keeps its label while its action runs: a spinner slides in
// ahead of the text rather than replacing it, so the button never reflows.
//
// `form.SubmitButton` (~/ui/form/app-form.tsx) is this same button wired to a
// TanStack form's canSubmit/isSubmitting; this one takes the pending flag
// directly, for the mutations that aren't behind a form. Both render through
// here so the two can't drift apart.
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
