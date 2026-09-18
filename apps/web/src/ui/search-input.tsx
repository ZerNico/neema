import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentProps } from "react";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/ui/primitives/input-group";

/**
 * The one search field for pages that filter a list in place. The magnifier is
 * an InputGroup addon rather than an absolutely positioned icon, so the focus
 * ring, the input's padding and click-to-focus all come from the primitive
 * instead of being re-derived (differently) at each call site.
 */
export function SearchInput({
  className,
  ...props
}: ComponentProps<typeof InputGroupInput> & { className?: string }) {
  return (
    <InputGroup className={className}>
      <InputGroupAddon>
        <HugeiconsIcon icon={Search01Icon} strokeWidth={2} aria-hidden />
      </InputGroupAddon>
      <InputGroupInput type="search" {...props} />
    </InputGroup>
  );
}
