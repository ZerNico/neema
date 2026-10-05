import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useCallback, useState, type ReactNode } from "react";
import { seenFeaturesQuery } from "../client/queries.ts";
import { availableFeatures, unseenFeatures, type Feature } from "../features.ts";
import { capabilitiesQuery } from "~/modules/groups/client/queries.ts";
import { markFeaturesSeen } from "../server/functions.ts";
import { NeemaGlyph } from "~/ui/brand.tsx";
import { Button, buttonVariants } from "~/ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import { cn } from "~/ui/utils";
import { ReplayContext } from "./replay-tour-context.ts";

/**
 * Shows what someone hasn't been told about yet, once. Nothing seen means a
 * welcome through every feature; some seen means only the new ones. Closing in
 * any way counts as seen, so a skipped tour never comes back on its own.
 */
export function FeatureTourProvider({
  enabled,
  children,
}: {
  /** Off while impersonating, so an admin's look around marks nothing for the user. */
  enabled: boolean;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const seen = useQuery({ ...seenFeaturesQuery, enabled });
  const { data: capabilities } = useQuery({ ...capabilitiesQuery, enabled });
  const features = capabilities ? availableFeatures(capabilities) : [];
  const [replaying, setReplaying] = useState(false);
  const [step, setStep] = useState(0);
  const mark = useMutation({
    mutationFn: (keys: string[]) => markFeaturesSeen({ data: { keys } }),
  });
  const unseen = seen.data ? unseenFeatures(seen.data, features) : [];
  const welcome = replaying || seen.data?.length === 0;
  // A first tour opens on a general welcome; a later one goes straight to what's new.
  const steps: Step[] = [
    ...(welcome ? [{ kind: "welcome" } as const] : []),
    ...(replaying ? features : unseen).map((feature) => ({ kind: "feature" as const, feature })),
  ];
  const open = replaying || (enabled && unseen.length > 0);
  const replay = useCallback(() => {
    setStep(0);
    setReplaying(true);
  }, [setStep, setReplaying]);

  const close = () => {
    if (!replaying && unseen.length > 0) {
      const keys = unseen.map((feature) => feature.key);
      // Closed now, whatever the request does; a failed write shows it again
      // on the next visit rather than interrupting this one with an error.
      queryClient.setQueryData(seenFeaturesQuery.queryKey, [...(seen.data ?? []), ...keys]);
      mark.mutate(keys);
    }
    setReplaying(false);
    setStep(0);
  };

  return (
    <ReplayContext.Provider value={replay}>
      {children}
      {open && steps.length > 0 ? (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) close();
          }}
        >
          <TourStep
            step={steps[Math.min(step, steps.length - 1)]!}
            index={Math.min(step, steps.length - 1)}
            count={steps.length}
            heading={welcome ? "Welcome to neema" : "New in neema"}
            onBack={() => setStep((current) => current - 1)}
            onNext={() => setStep((current) => current + 1)}
            onClose={close}
          />
        </Dialog>
      ) : null}
    </ReplayContext.Provider>
  );
}

type Step = { kind: "welcome" } | { kind: "feature"; feature: Feature };

function TourStep({
  step,
  index,
  count,
  heading,
  onBack,
  onNext,
  onClose,
}: {
  step: Step;
  index: number;
  count: number;
  heading: string;
  onBack: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const last = index === count - 1;
  return (
    <DialogContent className="sm:max-w-lg">
      {step.kind === "welcome" ? (
        <DialogHeader>
          <div className="bg-primary text-primary-foreground flex size-12 items-center justify-center rounded-2xl">
            <NeemaGlyph className="size-7" />
          </div>
          <DialogTitle>Welcome to neema</DialogTitle>
          <DialogDescription>
            Chat with an assistant that can write, look things up and work through tasks with you.
          </DialogDescription>
          <p className="text-sm leading-relaxed">
            Besides chatting, you can set it up to work the way you do. This takes about a minute:
            here are the {count - 1} things worth knowing about.
          </p>
        </DialogHeader>
      ) : (
        <>
          <DialogHeader>
            <p className="text-muted-foreground text-xs">
              {heading}
              {count > 1 ? ` · ${index + 1} of ${count}` : null}
            </p>
            <div className="bg-muted text-foreground flex size-12 items-center justify-center rounded-2xl">
              <HugeiconsIcon icon={step.feature.icon} strokeWidth={2} className="size-6" />
            </div>
            <DialogTitle>{step.feature.title}</DialogTitle>
            <DialogDescription>{step.feature.summary}</DialogDescription>
          </DialogHeader>
          <p className="text-sm leading-relaxed">{step.feature.body}</p>
          <div className="bg-muted rounded-2xl px-4 py-3 text-sm leading-relaxed">
            <span className="text-muted-foreground block text-xs">For example</span>
            {step.feature.example}
          </div>
          <Link
            to={step.feature.href}
            onClick={onClose}
            className={cn(buttonVariants({ size: "sm", variant: "secondary" }), "self-start")}
          >
            {step.feature.open}
            <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} data-icon="inline-end" />
          </Link>
        </>
      )}
      <DialogFooter className="items-center sm:justify-between">
        {count > 1 ? (
          <div className="flex gap-1.5" aria-hidden>
            {Array.from({ length: count }, (_, dot) => (
              <span
                key={dot}
                className={cn(
                  "size-1.5 rounded-full",
                  dot === index ? "bg-foreground" : "bg-muted-foreground/30",
                )}
              />
            ))}
          </div>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          {index > 0 ? (
            <Button variant="secondary" onClick={onBack}>
              Back
            </Button>
          ) : count > 1 ? (
            <Button variant="ghost" onClick={onClose}>
              Skip
            </Button>
          ) : null}
          <Button onClick={last ? onClose : onNext}>
            {last ? "Done" : step.kind === "welcome" ? "Show me" : "Next"}
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  );
}
