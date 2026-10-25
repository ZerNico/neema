import { Loading03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "cn";
import { m } from "~/paraglide/messages.js";

// Standalone the spinner announces itself as a status region. Inside a
// control that already carries `aria-busy` (or a label), pass `aria-hidden`
// so assistive tech doesn't get a second, nested "Loading" announcement.
function Spinner({
  className,
  "aria-hidden": hidden,
  ...props
}: Omit<React.ComponentProps<typeof HugeiconsIcon>, "icon">) {
  return (
    <HugeiconsIcon
      icon={Loading03Icon}
      strokeWidth={2}
      data-slot="spinner"
      role={hidden ? undefined : "status"}
      aria-label={hidden ? undefined : m.common_loading()}
      aria-hidden={hidden}
      className={cn("size-4 animate-spin motion-reduce:animate-none", className)}
      {...props}
    />
  );
}

export { Spinner };
