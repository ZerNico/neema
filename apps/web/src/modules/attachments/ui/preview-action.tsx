import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { PendingButton } from "~/ui/pending-button.tsx";
import { buttonVariants } from "~/ui/primitives/button";

type PreviewActionProps = { readonly icon: IconSvgElement; readonly label: string } & (
  | { readonly onClick: () => void; readonly pending?: boolean }
  /** A link: `download` names the saved file; without it the link opens in a new tab. */
  | { readonly href: string; readonly download?: string }
);

/**
 * One action in a file preview's header: an icon with a label that narrow
 * screens drop, the same whether it runs something (reveal a local file) or
 * leads somewhere (download a stored one).
 */
export function PreviewAction(props: PreviewActionProps) {
  const content = (
    <>
      <HugeiconsIcon icon={props.icon} strokeWidth={2} data-icon="inline-start" aria-hidden />
      <span className="hidden sm:inline">{props.label}</span>
    </>
  );
  if ("href" in props)
    return (
      <a
        href={props.href}
        aria-label={props.label}
        className={buttonVariants({ size: "sm", variant: "outline" })}
        {...(props.download === undefined
          ? { target: "_blank", rel: "noreferrer" }
          : { download: props.download })}
      >
        {content}
      </a>
    );
  return (
    <PendingButton
      size="sm"
      variant="outline"
      aria-label={props.label}
      pending={props.pending ?? false}
      onClick={props.onClick}
    >
      {content}
    </PendingButton>
  );
}
