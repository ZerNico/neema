import { columnLetters } from "@chat/sheet/a1";
import { sheetLocale } from "@chat/sheet/locales";
import { SheetGrid, type GridOverlay, type SheetSelection } from "@chat/sheet-react/grid";
import { selectionText } from "@chat/sheet-react/copy";
import { cellDisplay } from "@chat/sheet-react/display";
import { cellStyle } from "@chat/sheet/style";
import { conditionalLooks } from "@chat/sheet-react/looks";
import { Comment01Icon, Copy01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Button } from "~/ui/primitives/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "~/ui/primitives/context-menu";
import { FieldError } from "~/ui/primitives/field";
import { Popover, PopoverContent, PopoverTrigger } from "~/ui/primitives/popover";
import { Textarea } from "~/ui/primitives/textarea";
import { Spinner } from "~/ui/primitives/spinner";
import { SegmentedControl, SegmentedControlItem } from "~/ui/segmented-control.tsx";
import { cn } from "~/ui/utils";
import type { SpreadsheetPreview as Preview } from "~/modules/spreadsheets/preview.ts";
import type { OfficeFile } from "./office-preview.ts";
import { previewSheet } from "./spreadsheet-preview-sheet.ts";
import { usePreviewJson } from "./use-preview-json.ts";
import { formatLocale } from "~/i18n/formats.ts";
import { m } from "~/paraglide/messages.js";

const isPreview = (data: unknown): data is Preview =>
  !!data &&
  typeof data === "object" &&
  typeof (data as Preview).sheet === "string" &&
  [
    (data as Preview).sheets,
    (data as Preview).cells,
    (data as Preview).styles,
    (data as Preview).charts,
  ].every(Array.isArray);
const decodePreview = (data: unknown) => (isPreview(data) ? data : null);

/** A comment on some of a sheet's cells, by a quote naming them; false when it could not be sent. */
type OnComment = (quote: string, body: string) => Promise<boolean>;

/**
 * A workbook as Excel shows it, read-only: one sheet at a time, tabs below.
 * In a chat, selected cells can be commented on: the comment goes to the
 * assistant, which changes the file itself.
 */
export function SpreadsheetPreview({
  source,
  onComment,
}: {
  source: OfficeFile;
  onComment?: OnComment | undefined;
}) {
  const base = `/api/spreadsheets/${source.kind}/${encodeURIComponent(source.id)}`;
  // A picked tab belongs to its workbook; another file starts at its own first sheet.
  const [picked, setPicked] = useState<{ base: string; sheet: string }>();
  const sheet = picked?.base === base ? picked.sheet : null;
  const url = sheet === null ? base : `${base}?sheet=${encodeURIComponent(sheet)}`;
  const state = usePreviewJson(url, decodePreview);
  const preview = state.status === "ready" ? state.preview : null;
  // The tabs stay while another sheet loads or fails, so a person can always go back.
  const [known, setKnown] = useState<{ base: string; sheets: Preview["sheets"] }>();
  if (preview && (known?.base !== base || known.sheets !== preview.sheets))
    setKnown({ base, sheets: preview.sheets });
  const sheets = preview?.sheets ?? (known?.base === base ? known.sheets : []);
  const visible = sheets.filter((each) => !each.hidden);

  if (state.status === "error" && sheets.length === 0)
    return <FieldError>{m.spreadsheets_preview_load_failed()}</FieldError>;
  return (
    <div className="flex min-h-[60vh] min-w-0 flex-1 flex-col gap-2">
      <div className="paper bg-background text-foreground relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border">
        {state.status === "error" ? (
          <div className="p-4">
            <FieldError>{m.spreadsheets_preview_sheet_failed()}</FieldError>
          </div>
        ) : preview ? (
          // Keyed so each sheet starts at its own first cell.
          <SheetView
            key={`${base}:${preview.sheet}`}
            preview={preview}
            base={base}
            onComment={onComment}
          />
        ) : (
          <Spinner
            aria-label={m.spreadsheets_preview_loading()}
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
          />
        )}
      </div>
      {visible.length > 1 ? (
        <div className="overflow-x-auto">
          <SegmentedControl
            aria-label={m.spreadsheets_preview_sheets()}
            value={[preview?.sheet ?? sheet ?? ""]}
            multiple={false}
            onValueChange={(value) => {
              if (value[0]) setPicked({ base, sheet: value[0] });
            }}
          >
            {visible.map((each) => (
              <SegmentedControlItem key={each.name} value={each.name}>
                {each.name}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </div>
      ) : null}
      {preview && (preview.truncated || preview.otherCharts) ? (
        <p className="text-muted-foreground text-xs">
          {[
            preview.truncated ? m.spreadsheets_preview_truncated() : null,
            preview.otherCharts
              ? m.spreadsheets_preview_charts_hidden({ count: preview.otherCharts })
              : null,
            m.spreadsheets_preview_download_hint(),
          ]
            .filter(Boolean)
            .join(" ")}
        </p>
      ) : null}
    </div>
  );
}

const tooMany = () =>
  toast.error(m.spreadsheets_copy_too_many(), { description: m.spreadsheets_copy_too_many_hint() });
const locale = sheetLocale(formatLocale());

/** One sheet's cells in the grid, with the active cell's formula or value above them. */
function SheetView({
  preview,
  base,
  onComment,
}: {
  preview: Preview;
  base: string;
  onComment: OnComment | undefined;
}) {
  const shown = useMemo(() => previewSheet(preview), [preview]);
  const { sheet, value } = shown;
  const looks = useMemo(() => conditionalLooks(sheet, value, locale), [sheet, value]);
  const first = { r: sheet.rows[0]!, c: sheet.cols[0]! };
  const [selection, setSelection] = useState<SheetSelection>({ anchor: first, head: first });
  const { anchor, head } = selection;
  const rowOf = (key: string) => sheet.rows.indexOf(key) + 1;
  const colOf = (key: string) => sheet.cols.indexOf(key) + 1;
  const address = `${columnLetters(colOf(head.c))}${rowOf(head.r)}`;
  const [top, bottom] = [rowOf(anchor.r), rowOf(head.r)].toSorted((a, b) => a - b);
  const [left, right] = [colOf(anchor.c), colOf(head.c)].toSorted((a, b) => a - b);
  // Whole columns and rows are named the way Excel names them, C:E and 2:4.
  const range =
    top === 1 && bottom === sheet.rows.length
      ? `${columnLetters(left!)}:${columnLetters(right!)}`
      : left === 1 && right === sheet.cols.length
        ? `${top}:${bottom}`
        : top === bottom && left === right
          ? address
          : `${columnLetters(left!)}${top}:${columnLetters(right!)}${bottom}`;
  const [commenting, setCommenting] = useState(false);
  // Closing the menu returns focus to the grid, unless it closed to open the comment box.
  const area = useRef<HTMLDivElement>(null);
  const toComment = useRef(false);
  const copy = () => {
    const copied = selectionText(sheet, value, locale, selection);
    if (copied === null) return tooMany();
    navigator.clipboard.writeText(copied).catch(() => {
      toast.error(m.spreadsheets_copy_failed());
    });
  };
  const held = value(head.r, head.c);
  const text =
    shown.formula(head.r, head.c) ??
    (held === null
      ? ""
      : cellDisplay(held, cellStyle(sheet.cells[head.r]?.[head.c]?.s), locale).text);
  const overlays: GridOverlay[] = [
    ...preview.images.flatMap((image, index) => {
      const at = shown.cellAt(image.row, image.col);
      return at
        ? [
            {
              key: `image:${index}`,
              at,
              offset: { x: image.x, y: image.y },
              width: image.width,
              height: image.height,
              label: image.alt
                ? m.spreadsheets_preview_picture_named({ alt: image.alt })
                : m.spreadsheets_preview_picture(),
              content: (
                <img
                  src={image.src}
                  alt={image.alt ?? ""}
                  draggable={false}
                  className="pointer-events-none h-full w-full object-fill select-none"
                />
              ),
            },
          ]
        : [];
    }),
    ...preview.charts.flatMap((chart) => {
      const at = shown.cellAt(chart.row, chart.col);
      const label = m.spreadsheets_preview_chart({ number: chart.index + 1, sheet: preview.sheet });
      return at
        ? [
            {
              key: `chart:${chart.index}`,
              at,
              offset: { x: chart.x, y: chart.y },
              width: chart.width,
              height: chart.height,
              label,
              content: (
                <ChartImage
                  src={`${base}?sheet=${encodeURIComponent(preview.sheet)}&chart=${chart.index}`}
                  label={label}
                />
              ),
            },
          ]
        : [];
    }),
  ];
  return (
    <>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <span className="text-muted-foreground w-14 shrink-0 font-mono text-xs">{address}</span>
        {/* Read-only but selectable, so a long formula can be read and copied in full. */}
        <input
          readOnly
          aria-label={m.spreadsheets_preview_formula_bar()}
          value={text}
          className="min-w-0 flex-1 truncate bg-transparent font-mono text-xs outline-none"
        />
        {onComment ? (
          <CommentButton
            open={commenting}
            onOpenChange={setCommenting}
            range={range}
            // One cell is quoted with what it shows, so the comment reads on its own.
            quote={`${preview.sheet}!${range}${range === address && text ? ` · ${text}` : ""}`}
            onComment={onComment}
          />
        ) : null}
      </div>
      <ContextMenu
        onOpenChange={(open) => {
          if (open) toComment.current = false;
        }}
      >
        <ContextMenuTrigger ref={area} className="relative min-h-0 flex-1">
          <div className="absolute inset-0">
            <SheetGrid
              sheet={sheet}
              value={value}
              locale={locale}
              selection={selection}
              onSelectionChange={setSelection}
              label={preview.sheet}
              looks={looks}
              overlays={overlays}
              onCopyRefused={tooMany}
            />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent
          finalFocus={() =>
            toComment.current ? false : area.current?.querySelector<HTMLElement>('[role="grid"]')
          }
        >
          <ContextMenuItem onClick={copy}>
            <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} />
            {m.common_copy()}
          </ContextMenuItem>
          {onComment ? (
            <ContextMenuItem
              onClick={() => {
                toComment.current = true;
                setCommenting(true);
              }}
            >
              <HugeiconsIcon icon={Comment01Icon} strokeWidth={2} />
              {m.spreadsheets_comment_on_range({ range })}
            </ContextMenuItem>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>
    </>
  );
}

/** One chart, drawn by the server as the file declares it, where it sits on the sheet. */
function ChartImage({ src, label }: { src: string; label: string }) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  if (state === "error")
    return (
      <div className="bg-background flex h-full items-center justify-center border p-2">
        <FieldError>{m.spreadsheets_preview_chart_failed()}</FieldError>
      </div>
    );
  return (
    <div className="bg-background relative h-full overflow-hidden">
      <img
        src={src}
        alt={label}
        loading="lazy"
        draggable={false}
        onLoad={() => setState("ready")}
        onError={() => setState("error")}
        className={cn(
          "pointer-events-none block h-full w-full object-contain select-none",
          state === "ready" ? "opacity-100" : "opacity-0",
        )}
      />
      {state === "loading" ? (
        <Spinner
          aria-label={m.spreadsheets_preview_chart_loading()}
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
        />
      ) : null}
    </div>
  );
}

/** Comments on the selected cells, sent to the assistant as a chat message. */
function CommentButton({
  open,
  onOpenChange: setOpen,
  range,
  quote,
  onComment,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  range: string;
  quote: string;
  onComment: OnComment;
}) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const send = async () => {
    const text = body.trim();
    if (!text || sending) return;
    setSending(true);
    // A refused send has already said why; only one the chat could not take says this.
    const sent = await onComment(quote, text).catch(() => null);
    setSending(false);
    if (sent === null) return;
    if (!sent) {
      toast.error(m.spreadsheets_comment_failed(), {
        description: m.spreadsheets_comment_failed_hint(),
      });
      return;
    }
    setBody("");
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button size="sm" variant="ghost" />}>
        <HugeiconsIcon icon={Comment01Icon} strokeWidth={2} />
        {m.spreadsheets_comment()}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <Textarea
            aria-label={m.spreadsheets_comment_on_range({ range })}
            placeholder={m.spreadsheets_comment_placeholder({ range })}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              void send();
            }}
          />
          <PendingButton type="submit" size="sm" pending={sending} disabled={!body.trim()}>
            {m.spreadsheets_comment_send()}
          </PendingButton>
        </form>
      </PopoverContent>
    </Popover>
  );
}
