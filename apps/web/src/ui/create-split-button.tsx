import { ArrowDown01Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRender } from "@base-ui/react/use-render";
import { cn } from "cn";
import type { ComponentProps, ReactElement } from "react";
import { Button, buttonVariants } from "~/ui/primitives/button";
import { ButtonGroup, ButtonGroupSeparator } from "~/ui/primitives/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";

// Buttons clip their fill inside a transparent border. ButtonGroup drops the
// second half's left border; dropping the first half's right one too leaves
// only the divider at the seam, with both halves at the standard size.
const SEAMLESS = "border-r-0";

export interface CreateOption {
  label: string;
  icon: ComponentProps<typeof HugeiconsIcon>["icon"];
  /** A link element, so each page keeps its typed route and state. */
  link: ReactElement;
}

/**
 * One way to create a thing, with its alternatives beside it: the button does
 * the first option, the menu lists them all. Agents and schedules lead with
 * chat; skills lead with writing one and offer importing.
 */
export function CreateSplitButton({
  label,
  options,
  disabled = false,
}: {
  label: string;
  options: readonly [CreateOption, ...CreateOption[]];
  disabled?: boolean;
}) {
  const icon = <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />;
  // Base UI's Button would give the anchor role="button"; it navigates, so it
  // stays a link. The slot lets ButtonGroup square its edge.
  const primary = useRender({
    render: options[0].link,
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
        primary
      )}
      {/* The stock bg-input line suits outline buttons; on the filled halves it
          reads as a gap, so the divider takes the button's own ink. */}
      <ButtonGroupSeparator className="bg-primary-foreground/20" />
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={disabled}
          render={<Button size="icon-sm" aria-label={`More ways to create: ${label}`} />}
        >
          <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {options.map((option) => (
            <DropdownMenuItem key={option.label} render={option.link}>
              <HugeiconsIcon icon={option.icon} strokeWidth={2} />
              {option.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );
}
