import { cn } from "cn";
import type { ComponentProps } from "react";
import {
  Card as PrimitiveCard,
  CardFooter as PrimitiveCardFooter,
  CardHeader as PrimitiveCardHeader,
} from "~/ui/primitives/card";

/**
 * Shared by padded cards and unpadded ListCards; layout belongs to each composition.
 */
export const cardSurfaceClassName =
  "border-border rounded-3xl border bg-background text-foreground shadow-none ring-0 dark:ring-0";

export function Card({ className, ...props }: ComponentProps<typeof PrimitiveCard>) {
  return (
    <PrimitiveCard
      className={cn(
        cardSurfaceClassName,
        "*:[img:first-child]:rounded-t-3xl *:[img:last-child]:rounded-b-3xl",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<typeof PrimitiveCardHeader>) {
  return <PrimitiveCardHeader className={cn("rounded-t-3xl", className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<typeof PrimitiveCardFooter>) {
  return <PrimitiveCardFooter className={cn("rounded-b-3xl", className)} {...props} />;
}

export { CardContent, CardTitle, CardDescription, CardAction } from "~/ui/primitives/card";
