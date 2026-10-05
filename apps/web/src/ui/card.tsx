import { cn } from "cn";
import type { ComponentProps } from "react";
import {
  Card as PrimitiveCard,
  CardFooter as PrimitiveCardFooter,
  CardHeader as PrimitiveCardHeader,
} from "~/ui/primitives/card";
import { cardSurfaceClassName } from "./card-surface.ts";

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
