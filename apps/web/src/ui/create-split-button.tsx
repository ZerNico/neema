import {
  ArrowDown01Icon,
  BubbleChatIcon,
  PencilEdit02Icon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "cn";
import { useRender } from "@base-ui/react/use-render";
import type { ReactElement } from "react";
import { Button, buttonVariants } from "~/ui/primitives/button";
import { ButtonGroup, ButtonGroupSeparator } from "~/ui/primitives/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";

// Buttons clip their fill inside a transparent border, which between two
// joined halves leaves a strip of page showing; filling under it closes that.
const SEAMLESS = "bg-clip-border";

/**
 * Chat-first creation: the button opens a chat that drafts the thing, the
 * menu beside it also offers the manual form. Both targets are links, passed
 * as elements so each page keeps its typed route and prefill state.
 */
export function CreateSplitButton({
  label,
  chat,
  manual,
  disabled = false,
}: {
  label: string;
  chat: ReactElement;
  manual: ReactElement;
  disabled?: boolean;
}) {
  const icon = <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />;
  // Base UI's Button would give the anchor role="button"; it navigates, so it
  // stays a link. The slot lets ButtonGroup square its edge.
  const chatLink = useRender({
    render: chat,
    props: {
      className: cn(buttonVariants({ size: "sm" }), SEAMLESS),
      "data-slot": "button",
      children: (
        <>
          {icon}
          {label}
        </>
      ),
    },
  });
  return (
    <ButtonGroup>
      {/* A link cannot be disabled, so the unavailable state is a plain button. */}
      {disabled ? (
        <Button size="sm" className={SEAMLESS} disabled>
          {icon}
          {label}
        </Button>
      ) : (
        chatLink
      )}
      {/* The stock bg-input line suits outline buttons; on the filled halves it
          reads as a gap, so the divider takes the button's own ink. */}
      <ButtonGroupSeparator className="bg-primary-foreground/20" />
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={disabled}
          render={
            <Button
              size="icon-sm"
              className={SEAMLESS}
              aria-label={`More ways to create: ${label}`}
            />
          }
        >
          <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem render={chat}>
            <HugeiconsIcon icon={BubbleChatIcon} strokeWidth={2} />
            Create with chat
          </DropdownMenuItem>
          <DropdownMenuItem render={manual}>
            <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
            Set up manually
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );
}
