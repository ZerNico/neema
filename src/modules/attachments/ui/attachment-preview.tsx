import { useEffect, useState } from "react";
import { Streamdown } from "streamdown";
import { type AttachmentKind, formatFileSize, textLanguage } from "../constants.ts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import { cn } from "~/ui/utils";

/** What the preview needs to render an attachment's content. */
export interface AttachmentPreviewTarget {
  readonly fileName: string;
  readonly size: number;
  readonly kind: AttachmentKind;
  /** Authenticated bytes route, or an object URL for a not-yet-stored image. */
  readonly url: string;
}

// Text files can be as large as any other attachment; the dialog is a peek,
// not an editor, so cap what lands in the DOM.
const TEXT_PREVIEW_CHAR_CAP = 200_000;

export function AttachmentPreviewDialog({
  target,
  open,
  onOpenChange,
}: {
  target: AttachmentPreviewTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader className="min-w-0">
          <DialogTitle className="truncate pr-10">{target.fileName}</DialogTitle>
          <DialogDescription>
            {formatFileSize(target.size)} ·{" "}
            <a
              href={target.url}
              target="_blank"
              rel="noreferrer"
              className="hover:text-foreground underline underline-offset-2"
            >
              Open original
            </a>
          </DialogDescription>
        </DialogHeader>
        {target.kind === "image" ? (
          <img
            src={target.url}
            alt={target.fileName}
            className="max-h-[70vh] w-full rounded-2xl object-contain"
          />
        ) : target.kind === "pdf" ? (
          <iframe
            src={target.url}
            title={target.fileName}
            className="border-border h-[70vh] w-full rounded-2xl border"
          />
        ) : (
          // Keyed so a different file starts back at the loading state.
          <TextPreview key={target.url} url={target.url} language={textLanguage(target.fileName)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

type TextPreviewState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; text: string; truncated: boolean };

// Markdown parsing and shiki highlighting both walk the whole document; past
// this the plain view is the only one on offer.
const RENDER_CHAR_CAP = 100_000;

/** Fence that no backtick run inside the file can break out of. */
const fenceCode = (text: string, language: string): string => {
  const longestRun = [...text.matchAll(/`+/g)].reduce(
    (max, match) => Math.max(max, match[0].length),
    0,
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${text}\n${fence}`;
};

function TextPreview({ url, language }: { url: string; language: string }) {
  const [state, setState] = useState<TextPreviewState>({ status: "loading" });
  const [rendered, setRendered] = useState(true);

  useEffect(() => {
    let stale = false;
    fetch(url)
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error("not ok"))))
      .then((text) => {
        if (stale) return;
        setState({
          status: "ready",
          text: text.slice(0, TEXT_PREVIEW_CHAR_CAP),
          truncated: text.length > TEXT_PREVIEW_CHAR_CAP,
        });
      })
      .catch(() => {
        if (!stale) setState({ status: "error" });
      });
    return () => {
      stale = true;
    };
  }, [url]);

  if (state.status === "loading") {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }
  if (state.status === "error") {
    return <p className="text-destructive text-sm">Could not load this file.</p>;
  }

  // Markdown renders as itself; a recognised source file renders as the code
  // block streamdown already gives model output, highlighting included.
  const markdown = language === "markdown";
  const renderable = language !== "" && state.text.length <= RENDER_CHAR_CAP;

  return (
    <div className="min-w-0 space-y-2">
      {renderable ? <ViewToggle rendered={rendered} onChange={setRendered} /> : null}
      {renderable && rendered ? (
        // Streamdown's pipeline ignores raw HTML (no rehype-raw), so an
        // uploaded file cannot inject markup here.
        <div className="max-h-[65vh] overflow-auto">
          <Streamdown mode="static" className="space-y-3 text-sm [&_pre]:overflow-x-auto">
            {markdown ? state.text : fenceCode(state.text, language)}
          </Streamdown>
        </div>
      ) : (
        <div className="bg-muted/50 max-h-[65vh] overflow-auto rounded-xl p-4">
          <pre className="font-mono text-xs whitespace-pre-wrap">{state.text}</pre>
        </div>
      )}
      {state.truncated ? (
        <p className="text-muted-foreground text-xs">
          Truncated preview — use “Open original” for the whole file.
        </p>
      ) : null}
    </div>
  );
}

function ViewToggle({
  rendered,
  onChange,
}: {
  rendered: boolean;
  onChange: (rendered: boolean) => void;
}) {
  const option = (value: boolean, label: string) => (
    <button
      type="button"
      onClick={() => onChange(value)}
      aria-pressed={rendered === value}
      className={cn(
        "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
        rendered === value
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="flex justify-end">
      <div className="bg-muted inline-flex rounded-lg p-0.5">
        {option(true, "Rendered")}
        {option(false, "Plain")}
      </div>
    </div>
  );
}
