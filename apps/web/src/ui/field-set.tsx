import { cn } from "cn";
import type { ComponentProps } from "react";
import { FieldSet as PrimitiveFieldSet } from "~/ui/primitives/field";

export function FieldSet({
  className,
  compact = false,
  ...props
}: ComponentProps<typeof PrimitiveFieldSet> & { compact?: boolean }) {
  return <PrimitiveFieldSet className={cn(compact && "gap-4", className)} {...props} />;
}
