import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import { FEATURES } from "../features.ts";
import { useReplayTour } from "./feature-tour.tsx";
import { ListCard, ListRow, Page } from "~/ui/page-shell.tsx";
import { Button, buttonVariants } from "~/ui/primitives/button";

/** Everything the tours explain, findable any time from the account menu. */
export function HelpPage() {
  const replay = useReplayTour();
  return (
    <Page
      title="Help"
      rootPath="/"
      rootLabel="Chat"
      actions={
        <Button size="sm" variant="outline" onClick={replay}>
          Show the tour again
        </Button>
      }
    >
      <ListCard>
        {FEATURES.map((feature) => (
          <ListRow key={feature.key} className="items-start">
            <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-2xl">
              <HugeiconsIcon icon={feature.icon} strokeWidth={2} className="size-4" />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <h2 className="text-sm font-medium">{feature.title}</h2>
              <p className="text-muted-foreground text-sm leading-relaxed">{feature.body}</p>
            </div>
            <Link to={feature.href} className={buttonVariants({ size: "sm", variant: "ghost" })}>
              {feature.open}
            </Link>
          </ListRow>
        ))}
      </ListCard>
    </Page>
  );
}
