import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "~/ui/primitives/button";
import { FieldError } from "~/ui/primitives/field";
import { Spinner } from "~/ui/primitives/spinner";
import { cn } from "~/ui/utils";
import type { OfficeFile } from "./office-preview.ts";
import { usePreviewJson } from "./use-preview-json.ts";
import { m } from "~/paraglide/messages.js";

/** An authorized, server-rendered PPTX source; never inferred from a download URL. */
export type PresentationSource = OfficeFile;

interface SlideList {
  readonly slideIds: number[];
  readonly aspectRatio: number;
}
const decodeSlides = (data: unknown): SlideList | null => {
  if (
    !data ||
    typeof data !== "object" ||
    !("slideIds" in data) ||
    !Array.isArray(data.slideIds) ||
    data.slideIds.length > 100 ||
    !data.slideIds.every((id) => Number.isSafeInteger(id) && id > 0)
  )
    return null;
  const ratio = "aspectRatio" in data ? data.aspectRatio : null;
  return {
    slideIds: data.slideIds as number[],
    aspectRatio:
      typeof ratio === "number" && Number.isFinite(ratio) && ratio >= 0.25 && ratio <= 4
        ? ratio
        : 16 / 9,
  };
};

export function PresentationPreview({ source }: { source: PresentationSource }) {
  const base = `/api/presentations/${source.kind}/${encodeURIComponent(source.id)}`;
  const loaded = usePreviewJson(base, decodeSlides);
  const state =
    loaded.status === "ready" ? { status: "ready" as const, ...loaded.preview } : loaded;
  // The position and each image's outcome belong to one deck: slide IDs repeat
  // across decks, so another file starts afresh, remounted or not.
  const [position, setPosition] = useState({ base, index: 0 });
  const selected = position.base === base ? position.index : 0;
  const setSelected = (next: (index: number) => number) => setPosition(step(base, next));
  const [failedSlide, setFailedSlide] = useState<string | null>(null);
  const [loadedSlide, setLoadedSlide] = useState<string | null>(null);

  const count = state.status === "ready" ? state.slideIds.length : 0;
  useEffect(() => {
    if (!count) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      )
        return;
      if (event.key === "ArrowLeft") setPosition(step(base, (index) => Math.max(0, index - 1)));
      if (event.key === "ArrowRight")
        setPosition(step(base, (index) => Math.min(count - 1, index + 1)));
    };
    // Capture phase: the dialog stops keydown before it bubbles to the window.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [count, base]);

  if (state.status === "loading")
    return (
      <SlideFrame
        aspectRatio={16 / 9}
        footer={<span className="text-muted-foreground text-xs">{m.attachments_slides_loading()}</span>}
      >
        <Spinner aria-label={m.attachments_slides_loading_label()} className={centered} />
      </SlideFrame>
    );
  if (state.status === "error")
    return (
      <FieldError>{m.attachments_slides_load_failed()}</FieldError>
    );
  if (count === 0)
    return <p className="text-muted-foreground text-sm">{m.attachments_slides_empty()}</p>;
  const image = `${base}?slide=${state.slideIds[selected]!}`;
  return (
    <SlideFrame
      aspectRatio={state.aspectRatio}
      footer={
        <>
          <Button
            size="icon-sm"
            variant="outline"
            aria-label={m.attachments_slides_previous()}
            disabled={selected === 0}
            onClick={() => setSelected((index) => index - 1)}
          >
            <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
          </Button>
          <span className="text-muted-foreground text-xs">
            {m.attachments_slides_position({ current: selected + 1, count })}
          </span>
          <Button
            size="icon-sm"
            variant="outline"
            aria-label={m.attachments_slides_next()}
            disabled={selected === count - 1}
            onClick={() => setSelected((index) => index + 1)}
          >
            <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} />
          </Button>
        </>
      }
    >
      {failedSlide === image ? (
        <div className="absolute inset-0 flex items-center justify-center p-4 text-center">
          <FieldError>{m.attachments_slides_slide_failed()}</FieldError>
        </div>
      ) : (
        <img
          key={image}
          src={image}
          alt={m.attachments_slides_position({ current: selected + 1, count })}
          onLoad={() => setLoadedSlide(image)}
          onError={() => setFailedSlide(image)}
          className={cn(
            "absolute inset-0 size-full object-contain",
            loadedSlide === image ? "opacity-100" : "opacity-0",
          )}
        />
      )}
      {loadedSlide !== image && failedSlide !== image ? (
        <Spinner aria-label={m.attachments_slides_slide_loading()} className={centered} />
      ) : null}
    </SlideFrame>
  );
}

/** The next position in deck `base`; a position kept from another deck starts at 0. */
const step =
  (base: string, next: (index: number) => number) =>
  (current: { base: string; index: number }) => ({
    base,
    index: next(current.base === base ? current.index : 0),
  });

const centered = "absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2";

/** Loading and ready share one frame, so the dialog keeps its size as slides arrive. */
function SlideFrame({
  aspectRatio,
  footer,
  children,
}: {
  aspectRatio: number;
  footer: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-2">
      <div
        className="bg-muted relative max-h-[60vh] w-full overflow-hidden rounded-xl"
        style={{ aspectRatio }}
      >
        {children}
      </div>
      <div className="flex h-8 items-center justify-center gap-3">{footer}</div>
    </div>
  );
}
