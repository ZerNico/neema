import { ArrowRight01Icon, PlayIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import { FEATURES } from "../features.ts";
import { useReplayTour } from "./feature-tour.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "~/ui/card.tsx";
import { Page } from "~/ui/page-shell.tsx";
import { Button, buttonVariants } from "~/ui/primitives/button";

/**
 * Everything the tours explain, findable any time from the account menu: one
 * card per feature, with its example, the way the tour shows them.
 */
export function HelpPage() {
  const replay = useReplayTour();
  return (
    <Page
      title="Help"
      rootPath="/"
      rootLabel="Chat"
      actions={
        <Button size="sm" variant="outline" onClick={replay}>
          <HugeiconsIcon icon={PlayIcon} strokeWidth={2} data-icon="inline-start" />
          Show the tour
        </Button>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {FEATURES.map((feature) => (
          <Card key={feature.key} size="sm">
            <CardHeader>
              <div className="bg-muted text-foreground mb-2 flex size-10 items-center justify-center rounded-2xl">
                <HugeiconsIcon icon={feature.icon} strokeWidth={2} className="size-5" />
              </div>
              <CardTitle>
                <h2>{feature.title}</h2>
              </CardTitle>
              <CardDescription>{feature.summary}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-3">
              <p className="leading-relaxed">{feature.body}</p>
              <div className="bg-muted rounded-2xl px-4 py-3 leading-relaxed">
                <span className="text-muted-foreground block text-xs">For example</span>
                {feature.example}
              </div>
            </CardContent>
            <CardFooter>
              <Link
                to={feature.href}
                className={buttonVariants({ size: "sm", variant: "secondary" })}
              >
                {feature.open}
                <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} data-icon="inline-end" />
              </Link>
            </CardFooter>
          </Card>
        ))}
      </div>
    </Page>
  );
}
