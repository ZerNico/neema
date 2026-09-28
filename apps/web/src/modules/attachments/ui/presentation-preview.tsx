import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "~/ui/primitives/button";
import { FieldError } from "~/ui/primitives/field";
import { Spinner } from "~/ui/primitives/spinner";
import { cn } from "~/ui/utils";
import { fileExtension, GENERIC_MEDIA_TYPE, PPTX_MEDIA_TYPE } from "../constants.ts";

/** An authorized, server-rendered PPTX source; never inferred from a download URL. */
export interface PresentationSource {
  readonly kind: "attachment" | "project-version";
  readonly id: string;
}

/**
 * `source` when the file is a PowerPoint deck, else null. A specific media type
 * decides; a generic or missing one falls back to the extension.
 */
export const presentationSource = (
  file: { readonly fileName: string; readonly mediaType?: string | undefined },
  source: PresentationSource,
): PresentationSource | null =>
  (
    file.mediaType && file.mediaType !== GENERIC_MEDIA_TYPE
      ? file.mediaType === PPTX_MEDIA_TYPE
      : fileExtension(file.fileName) === "pptx"
  )
    ? source
    : null;

type PreviewState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; slideIds: number[]; aspectRatio: number };

export function PresentationPreview({ source }: { source: PresentationSource }) {
  const base = `/api/presentations/${source.kind}/${encodeURIComponent(source.id)}`;
  const [state, setState] = useState<PreviewState>({ status: "loading" });
  const [selected, setSelected] = useState(0);
  const [failedSlide, setFailedSlide] = useState<number | null>(null);
  const [loadedSlide, setLoadedSlide] = useState<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(base, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Preview unavailable");
        const data: unknown = await response.json();
        if (
          !data ||
          typeof data !== "object" ||
          !("slideIds" in data) ||
          !Array.isArray(data.slideIds) ||
          data.slideIds.length > 100 ||
          !data.slideIds.every((id) => Number.isSafeInteger(id) && id > 0)
        )
          throw new Error("Invalid slide list");
        const ratio = "aspectRatio" in data ? data.aspectRatio : null;
        return {
          status: "ready" as const,
          slideIds: data.slideIds as number[],
          aspectRatio:
            typeof ratio === "number" && Number.isFinite(ratio) && ratio >= 0.25 && ratio <= 4
              ? ratio
              : 16 / 9,
        };
      })
      .then((ready) => {
        if (!controller.signal.aborted) setState(ready);
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: "error" });
      });
    return () => controller.abort();
  }, [base]);

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
      if (event.key === "ArrowLeft") setSelected((index) => Math.max(0, index - 1));
      if (event.key === "ArrowRight") setSelected((index) => Math.min(count - 1, index + 1));
    };
    // Capture phase: the dialog stops keydown before it bubbles to the window.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [count]);

  if (state.status === "loading")
    return (
      <SlideFrame
        aspectRatio={16 / 9}
        footer={<span className="text-muted-foreground text-xs">Loading slides…</span>}
      >
        <Spinner aria-label="Loading slides" className={centered} />
      </SlideFrame>
    );
  if (state.status === "error")
    return (
      <FieldError>
        Could not load this presentation. Download the original to open it elsewhere.
      </FieldError>
    );
  if (count === 0)
    return <p className="text-muted-foreground text-sm">This presentation has no slides.</p>;
  const slideId = state.slideIds[selected]!;
  return (
    <SlideFrame
      aspectRatio={state.aspectRatio}
      footer={
        <>
          <Button
            size="icon-sm"
            variant="outline"
            aria-label="Previous slide"
            disabled={selected === 0}
            onClick={() => setSelected((index) => index - 1)}
          >
            <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
          </Button>
          <span className="text-muted-foreground text-xs">
            Slide {selected + 1} of {count}
          </span>
          <Button
            size="icon-sm"
            variant="outline"
            aria-label="Next slide"
            disabled={selected === count - 1}
            onClick={() => setSelected((index) => index + 1)}
          >
            <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} />
          </Button>
        </>
      }
    >
      {failedSlide === slideId ? (
        <div className="absolute inset-0 flex items-center justify-center p-4 text-center">
          <FieldError>
            Could not load this slide. Download the original to open it elsewhere.
          </FieldError>
        </div>
      ) : (
        <img
          key={slideId}
          src={`${base}?slide=${slideId}`}
          alt={`Slide ${selected + 1} of ${count}`}
          onLoad={() => setLoadedSlide(slideId)}
          onError={() => setFailedSlide(slideId)}
          className={cn(
            "absolute inset-0 size-full object-contain",
            loadedSlide === slideId ? "opacity-100" : "opacity-0",
          )}
        />
      )}
      {loadedSlide !== slideId && failedSlide !== slideId ? (
        <Spinner aria-label="Loading slide" className={centered} />
      ) : null}
    </SlideFrame>
  );
}

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
