import { Download01Icon, LinkSquare02Icon, PanelRightIcon } from "@hugeicons/core-free-icons";
import { markdownTableComponents } from "~/ui/markdown-components.ts";
import { createContext, use, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
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
import { FieldError } from "~/ui/primitives/field";
import { Spinner } from "~/ui/primitives/spinner";
import { ViewToggle } from "~/ui/view-toggle.tsx";
import type { OfficeFamily } from "~/modules/office/families.ts";
import type { OfficeFile, OfficePreview } from "./office-preview.ts";
import { PresentationPreview } from "./presentation-preview.tsx";
import { PreviewAction } from "./preview-action.tsx";
import { SpreadsheetPreview } from "./spreadsheet-preview.tsx";
import { WordPreview } from "./word-preview.tsx";
import { LINK_SAFETY } from "~/ui/link-safety.tsx";
import { DetailPanelAvailableContext, DetailPanelContext } from "~/ui/detail-panel-context.ts";
import type { DetailPanelRequest } from "~/ui/detail-panel-state.ts";
import { useDesktop } from "~/modules/desktop/client/bridge.ts";
import { commentMessage } from "~/modules/chat/comment-message.ts";
import { FileCommentContext, type SendFileComment } from "./file-comment.ts";
import { getLocale } from "~/paraglide/runtime.js";
import { m } from "~/paraglide/messages.js";

/** Each Office family's preview; the compiler keeps the table complete. */
const OFFICE_PREVIEWS = {
  presentation: PresentationPreview,
  spreadsheet: SpreadsheetPreview,
  word: WordPreview,
} satisfies Record<
  OfficeFamily,
  (props: { source: OfficeFile; onComment?: FileComment | undefined }) => ReactNode
>;

/** A comment on part of a file, by a quote of that part; false when it could not be sent. */
type FileComment = (quote: string, body: string) => Promise<boolean>;

function OfficeFilePreview({
  office,
  onComment,
}: {
  office: OfficePreview;
  onComment: FileComment | undefined;
}) {
  const Preview = OFFICE_PREVIEWS[office.type];
  return <Preview source={office.source} onComment={onComment} />;
}

/** What the preview needs to render an attachment's content. */
export interface AttachmentPreviewTarget {
  readonly fileName: string;
  /** Bytes, shown under the name; unknown for images a ui block found before sizes were kept. */
  readonly size?: number | undefined;
  readonly kind: AttachmentKind;
  /** Authenticated bytes route, or an object URL for a not-yet-stored image. */
  readonly url: string;
  /** Set only for a PowerPoint deck, Excel workbook or Word document; see `officePreview`. */
  readonly office?: OfficePreview | null | undefined;
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

/**
 * Where a body puts its own controls (a markdown file's view toggle): the dialog's header row,
 * beside the actions. Null in a panel tab or a skill, which show them above the body.
 */
const PreviewToolbarContext = createContext<HTMLElement | null>(null);

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
   * Replaces the default action (download a stored file, or open it in a new
   * tab), rendered with `PreviewAction` like it. A caller whose `url` is an
   * object URL must pass this: a `blob:` tab inherits our origin, so following
   * the link to a file the model wrote would run its script as us.
   */
  actions?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const panel = use(DetailPanelContext);
  const comment = use(FileCommentContext);
  const panelAvailable = use(DetailPanelAvailableContext);
  // A file with a preview can open beside the chat, to read alongside it; a
  // settings page has no panel. In the desktop app a new tab is the computer's
  // browser, which may not be signed in, so there the file downloads instead.
  const desktop = useDesktop() !== null;
  const sidebar = panel && panelAvailable && hasPreview(target) ? panel : null;
  const [toolbar, setToolbar] = useState<HTMLElement | null>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader className="min-w-0">
          {/* One row, so actions sit beside the name rather than under it. The
              right padding clears the close button; the title yields first.
              The row takes the actions' height and the close button's 16px
              offset, so the two sets of buttons sit on one line. */}
          <div className="-mt-2 flex min-h-8 min-w-0 items-center gap-2 pr-10">
            <DialogTitle className="min-w-0 flex-1 truncate">{target.fileName}</DialogTitle>
            <div className="flex shrink-0 items-center gap-2">
              <span ref={setToolbar} className="contents" />
              {actions ?? (
                <>
                  {sidebar ? (
                    <PreviewAction
                      icon={PanelRightIcon}
                      label={m.attachments_preview_open_sidebar()}
                      onClick={() => {
                        sidebar.open(filePanelRequest(target, comment));
                        onOpenChange(false);
                      }}
                    />
                  ) : null}
                  {desktop || target.kind === "file" ? (
                    <DownloadAction target={target} />
                  ) : (
                    <PreviewAction
                      icon={LinkSquare02Icon}
                      label={m.attachments_preview_open_original()}
                      href={target.url}
                    />
                  )}
                </>
              )}
            </div>
          </div>
          {target.size === undefined ? null : (
            <DialogDescription>{formatFileSize(target.size, getLocale())}</DialogDescription>
          )}
        </DialogHeader>
        <PreviewToolbarContext value={toolbar}>
          <FilePreviewBody target={target} linkable={!actions} comment={comment} />
        </PreviewToolbarContext>
      </DialogContent>
    </Dialog>
  );
}

const hasPreview = (target: AttachmentPreviewTarget) =>
  target.kind !== "file" || (!!target.office && !target.unsupported);

function DownloadAction({ target }: { target: AttachmentPreviewTarget }) {
  return (
    <PreviewAction
      icon={Download01Icon}
      label={m.common_download()}
      href={target.url}
      download={target.fileName}
    />
  );
}

/**
 * A stored file as a panel tab, keyed by its address so the dialog and a
 * delivered document open the same one.
 */
export const filePanelRequest = (
  target: AttachmentPreviewTarget,
  comment: SendFileComment | null = null,
): DetailPanelRequest => ({
  id: `file:${target.url}`,
  title: target.fileName,
  actions: (
    <div className="flex justify-end">
      <DownloadAction target={target} />
    </div>
  ),
  body: <FilePreviewBody target={target} linkable={false} comment={comment} />,
});

/**
 * A file's content as every preview shows it: the one place a kind of file
 * gets its renderer, so a new one appears wherever files are previewed.
 * `linkable`: the original is one link away, so a shortened text can say so.
 */
export function FilePreviewBody({
  target,
  linkable,
  comment = null,
}: {
  target: AttachmentPreviewTarget;
  linkable: boolean;
  /** Where a comment on the file goes, as a message to the chat it is in; none outside one. */
  comment?: SendFileComment | null;
}) {
  const source = target.office?.source;
  // Only a chat's own attachment: the model reads it by that reference.
  const onComment =
    comment && source?.kind === "attachment"
      ? (quote: string, body: string) =>
          comment(
            commentMessage(quote, body, { name: target.fileName, ref: `attachment:${source.id}` }),
          )
      : undefined;
  return target.kind === "file" && target.office && !target.unsupported ? (
    <OfficeFilePreview
      key={`${target.office.source.kind}:${target.office.source.id}`}
      office={target.office}
      onComment={onComment}
    />
  ) : target.unsupported || target.kind === "file" ? (
    <p className="text-muted-foreground text-sm">{m.attachments_preview_unavailable()}</p>
  ) : target.kind === "image" ? (
    <img
      src={target.url}
      alt={target.fileName}
      className="max-h-[70vh] w-full rounded-2xl object-contain"
    />
  ) : target.kind === "pdf" ? (
    // oxlint-disable-next-line react/iframe-missing-sandbox -- Chrome's PDF viewer does not run in a sandboxed frame
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
      linkable={linkable}
    />
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
  const toolbar = use(PreviewToolbarContext);

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
    return (
      <Spinner aria-label={m.attachments_preview_loading()} className="text-muted-foreground" />
    );
  }
  if (state.status === "error") {
    return <FieldError>{m.attachments_preview_load_failed()}</FieldError>;
  }

  // A markdown file is the one kind with two genuinely different readings, so
  // it keeps the toggle. Everything else (source, config, logs, plain text)
  // is a file, and goes to the file viewer.
  const markdown = language === "markdown" && state.text.length <= RENDER_CHAR_CAP;

  const toggle = markdown ? (
    <ViewToggle
      preview={rendered}
      sourceLabel={m.attachments_preview_source()}
      onChange={setRendered}
    />
  ) : null;

  return (
    <div className="min-w-0 space-y-2">
      {toggle && toolbar ? (
        createPortal(toggle, toolbar)
      ) : toggle ? (
        <div className="flex justify-end">{toggle}</div>
      ) : null}
      {markdown && rendered ? (
        // Streamdown's pipeline ignores raw HTML (no rehype-raw), so an
        // uploaded file cannot inject markup here.
        <div className="max-h-[65vh] overflow-auto">
          <Streamdown
            linkSafety={LINK_SAFETY}
            mode="static"
            plugins={markdownPlugins}
            components={markdownTableComponents}
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
          {linkable ? m.attachments_preview_truncated_linked() : m.attachments_preview_shortened()}
        </p>
      ) : null}
    </div>
  );
}
