import { useEffect, useState } from "react";
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
import { ToggleGroup, ToggleGroupItem } from "~/ui/primitives/toggle-group";

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

// Markdown parsing walks the whole document; past this a markdown file is
// shown as source instead.
const RENDER_CHAR_CAP = 100_000;

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
    return <Spinner aria-label="Loading preview" className="text-muted-foreground" />;
  }
  if (state.status === "error") {
    return <p className="text-destructive text-sm">Could not load this file.</p>;
  }

  // A markdown file is the one kind with two genuinely different readings, so
  // it keeps the toggle. Everything else — source, config, logs, plain text —
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
  return (
    <div className="flex justify-end">
      <ToggleGroup
        aria-label="Preview mode"
        value={[rendered ? "rendered" : "plain"]}
        multiple={false}
        onValueChange={(value) => {
          if (value[0]) onChange(value[0] === "rendered");
        }}
        size="sm"
        spacing={0.5}
        className="bg-muted rounded-full p-0.5"
      >
        <ToggleGroupItem value="rendered" className="h-7 rounded-full px-2.5 text-xs">
          Rendered
        </ToggleGroupItem>
        <ToggleGroupItem value="plain" className="h-7 rounded-full px-2.5 text-xs">
          Plain
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}
