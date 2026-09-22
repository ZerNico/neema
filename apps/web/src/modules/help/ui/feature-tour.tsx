import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { seenFeaturesQuery } from "../client/queries.ts";
import { FEATURES, unseenFeatures, type Feature } from "../features.ts";
import { markFeaturesSeen } from "../server/functions.ts";
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

const ReplayContext = createContext<(() => void) | null>(null);

/** Reopens the full tour, for the Help page; seen state is left as it is. */
export function useReplayTour() {
  const replay = useContext(ReplayContext);
  if (!replay) throw new Error("useReplayTour must be used within FeatureTourProvider");
  return replay;
}

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
  const [replaying, setReplaying] = useState(false);
  const [step, setStep] = useState(0);
  const mark = useMutation({
    mutationFn: (keys: string[]) => markFeaturesSeen({ data: { keys } }),
  });
  const unseen = seen.data ? unseenFeatures(seen.data) : [];
  const steps = replaying ? FEATURES : unseen;
  const open = replaying || (enabled && unseen.length > 0);
  const welcome = replaying || seen.data?.length === 0;

  const replay = useCallback(() => {
    setStep(0);
    setReplaying(true);
  }, []);

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
            feature={steps[Math.min(step, steps.length - 1)]!}
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

function TourStep({
  feature,
  index,
  count,
  heading,
  onBack,
  onNext,
  onClose,
}: {
  feature: Feature;
  index: number;
  count: number;
  heading: string;
  onBack: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const last = index === count - 1;
  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <p className="text-muted-foreground text-xs">
          {heading}
          {count > 1 ? ` · ${index + 1} of ${count}` : null}
        </p>
        <div className="bg-muted text-foreground mt-2 flex size-10 items-center justify-center rounded-2xl">
          <HugeiconsIcon icon={feature.icon} strokeWidth={2} className="size-5" />
        </div>
        <DialogTitle>{feature.title}</DialogTitle>
        <DialogDescription>{feature.summary}</DialogDescription>
      </DialogHeader>
      <p className="text-sm leading-relaxed">{feature.body}</p>
      <Link
        to={feature.href}
        onClick={onClose}
        className={cn(buttonVariants({ variant: "link" }), "h-auto self-start p-0")}
      >
        {feature.open}
      </Link>
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
            <Button variant="outline" onClick={onBack}>
              Back
            </Button>
          ) : count > 1 ? (
            <Button variant="ghost" onClick={onClose}>
              Skip
            </Button>
          ) : null}
          <Button onClick={last ? onClose : onNext}>{last ? "Done" : "Next"}</Button>
        </div>
      </DialogFooter>
    </DialogContent>
  );
}
