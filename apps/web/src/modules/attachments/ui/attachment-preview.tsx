import { useEffect, useState, type ReactNode } from "react";
import { Streamdown } from "streamdown";
import { markdownPlugins } from "~/ui/markdown-plugins.ts";
import { CodeViewer } from "./code-viewer.tsx";
import { type AttachmentKind, formatFileSize, textLanguage } from "../constants.ts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import { Spinner } from "~/ui/primitives/spinner";
import { SegmentedControl, SegmentedControlItem } from "~/ui/segmented-control.tsx";
import { cn } from "~/ui/utils";

/** What the preview needs to render an attachment's content. */
export interface AttachmentPreviewTarget {
  readonly fileName: string;
  readonly size: number;
  readonly kind: AttachmentKind;
  /** Authenticated bytes route, or an object URL for a not-yet-stored image. */
  readonly url: string;
  /**
   * True when `url` already holds less than the whole file. A local file is
   * read through a capped bridge call, so the dialog cannot tell by measuring
   * what it fetched.
   */
  readonly truncated?: boolean;
  /**
   * No content to show (a binary file the bridge will not decode). The dialog
   * still opens, so its actions remain: the file manager is the preview there.
   */
  readonly unsupported?: boolean;
}

// Text files can be as large as any other attachment; the dialog is a peek,
// not an editor, so cap what lands in the DOM.
const TEXT_PREVIEW_CHAR_CAP = 200_000;

export function AttachmentPreviewDialog({
  target,
  actions,
  open,
  onOpenChange,
}: {
  target: AttachmentPreviewTarget;
  /**
   * Replaces the “Open original” link. A caller whose `url` is an object URL
   * must pass this: a `blob:` tab inherits our origin, so following the link
   * to a file the model wrote would run its script as us.
   */
  actions?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader className="min-w-0">
          {/* One row, so actions sit beside the name rather than under it. The
              right padding clears the close button; the title yields first.
              With actions the row takes that button's height and its 16px
              offset, so the two sets of buttons sit on one line. */}
          <div
            className={cn("flex min-w-0 items-center gap-2 pr-10", actions ? "-mt-2 min-h-8" : "")}
          >
            <DialogTitle className="min-w-0 flex-1 truncate">{target.fileName}</DialogTitle>
            {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
          </div>
          <DialogDescription>
            {formatFileSize(target.size)}
            {actions ? null : (
              <>
                {" · "}
                <a
                  href={target.url}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-foreground underline underline-offset-2"
                >
                  Open original
                </a>
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        {target.unsupported ? (
          <p className="text-muted-foreground text-sm">
            There’s no preview for this kind of file.
          </p>
        ) : target.kind === "image" ? (
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
          <TextPreview
            key={target.url}
            url={target.url}
            language={textLanguage(target.fileName)}
            shortened={target.truncated ?? false}
            linkable={!actions}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

type TextPreviewState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; text: string; truncated: boolean };

// Markdown parsing walks the whole document; past this a markdown file is
// shown as source instead.
const RENDER_CHAR_CAP = 100_000;

function TextPreview({
  url,
  language,
  shortened,
  linkable,
}: {
  url: string;
  language: string;
  /** The fetched bytes are already short of the file, before this one caps it. */
  shortened: boolean;
  linkable: boolean;
}) {
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
    return <Spinner aria-label="Loading preview" className="text-muted-foreground" />;
  }
  if (state.status === "error") {
    return <p className="text-destructive text-sm">Could not load this file.</p>;
  }

  // A markdown file is the one kind with two genuinely different readings, so
  // it keeps the toggle. Everything else (source, config, logs, plain text)
  // is a file, and goes to the file viewer.
  const markdown = language === "markdown" && state.text.length <= RENDER_CHAR_CAP;

  return (
    <div className="min-w-0 space-y-2">
      {markdown ? <ViewToggle rendered={rendered} onChange={setRendered} /> : null}
      {markdown && rendered ? (
        // Streamdown's pipeline ignores raw HTML (no rehype-raw), so an
        // uploaded file cannot inject markup here.
        <div className="max-h-[65vh] overflow-auto">
          <Streamdown
            mode="static"
            plugins={markdownPlugins}
            className="space-y-3 text-sm [&_pre]:overflow-x-auto"
          >
            {state.text}
          </Streamdown>
        </div>
      ) : (
        <CodeViewer text={state.text} language={language} className="max-h-[65vh]" />
      )}
      {state.truncated || shortened ? (
        <p className="text-muted-foreground text-xs">
          {linkable
            ? "Truncated preview. “Open original” has the whole file."
            : "Shortened to fit."}
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
  return (
    <div className="flex justify-end">
      <SegmentedControl
        aria-label="Preview mode"
        value={[rendered ? "rendered" : "plain"]}
        multiple={false}
        onValueChange={(value) => {
          if (value[0]) onChange(value[0] === "rendered");
        }}
        size="sm"
        spacing={0.5}
      >
        <SegmentedControlItem value="rendered">Rendered</SegmentedControlItem>
        <SegmentedControlItem value="plain">Plain</SegmentedControlItem>
      </SegmentedControl>
    </div>
  );
}
