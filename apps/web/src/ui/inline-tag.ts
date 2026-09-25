import { cn } from "~/ui/utils";

/**
 * An inline tag in message text: an @integration, a /skill, a #collection. One
 * shape for all of them, in the composer and the sent message alike; `tone`
 * only picks the tint that reads on each surface (the sent bubble is filled
 * with the primary colour).
 */
export const inlineTagClassName = (tone: "message" | "field") =>
  cn(
    "mx-px inline-flex items-center gap-1 rounded-md px-1.5 align-bottom font-medium",
    tone === "message" ? "bg-primary-foreground/15" : "bg-muted text-foreground",
  );
