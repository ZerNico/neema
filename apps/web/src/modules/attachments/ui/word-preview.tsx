import { FieldError } from "~/ui/primitives/field";
import { Spinner } from "~/ui/primitives/spinner";
import { cn } from "~/ui/utils";
import type { OfficeFile } from "./office-preview.ts";
import { usePreviewJson } from "./use-preview-json.ts";
import { m } from "~/paraglide/messages.js";

interface Run {
  readonly text: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly color?: string;
}
/** How a title or heading style looks in the document. */
interface Look {
  readonly color?: string;
  /** Points. */
  readonly size?: number;
  readonly font?: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
}
// The server sends plain values; anything else is dropped rather than styled.
const hex = (value: unknown) =>
  typeof value === "string" && /^#[0-9A-F]{6}$/i.test(value) ? value : undefined;
/** Word's body text is 11pt where the preview's is 14px; sizes scale by that, within bounds. */
const fontSize = (points: unknown) =>
  typeof points === "number" && points > 0
    ? `${Math.round(Math.min(40, Math.max(11, (points * 14) / 11)))}px`
    : undefined;
const fontFamily = (font: unknown) =>
  typeof font === "string" && /^[\w .-]{1,60}$/.test(font) ? `"${font}", sans-serif` : undefined;
const lookStyle = (look: Look | undefined) =>
  look
    ? {
        color: hex(look.color),
        fontSize: fontSize(look.size),
        fontFamily: fontFamily(look.font),
        ...(look.bold === false ? { fontWeight: 400 } : {}),
        ...(look.italic ? { fontStyle: "italic" as const } : {}),
      }
    : undefined;
type Block =
  | {
      readonly type: "paragraph";
      readonly role: "title" | "heading" | "list" | "quote" | "body";
      readonly level?: number;
      readonly align?: "center" | "right" | "both";
      readonly runs: ReadonlyArray<Run>;
      readonly pictures?: ReadonlyArray<Picture>;
      /** A list item's number or bullet, as Word writes it. */
      readonly marker?: string;
      readonly look?: Look;
    }
  | { readonly type: "table"; readonly rows: ReadonlyArray<ReadonlyArray<string>> }
  | {
      readonly type: "tableOfContents";
      readonly entries: ReadonlyArray<{ readonly level: number; readonly text: string }>;
    }
  | { readonly type: "pageBreak" };
interface Picture {
  readonly width: number;
  readonly height: number;
  readonly alt: string;
  /** Present when the server sent the picture; only PNG and JPEG data is ever drawn. */
  readonly src?: string;
}
const drawable = (src: string | undefined): src is string =>
  !!src && /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(src);

function Pictures({ pictures }: { pictures: ReadonlyArray<Picture> }) {
  return pictures.map((picture, index) =>
    drawable(picture.src) ? (
      <img
        // oxlint-disable-next-line react/no-array-index-key -- pictures have no identity beyond their order
        key={index}
        src={picture.src}
        alt={picture.alt}
        width={picture.width}
        height={picture.height}
        className="inline-block h-auto max-w-full rounded-sm"
      />
    ) : (
      <span
        // oxlint-disable-next-line react/no-array-index-key -- pictures have no identity beyond their order
        key={index}
        role="img"
        aria-label={picture.alt || m.attachments_word_picture()}
        className="bg-paper-foreground/5 text-paper-foreground/60 inline-flex max-w-full items-center justify-center rounded-sm text-xs"
        style={{ width: Math.min(picture.width, 600), height: Math.min(picture.height, 400) }}
      >
        {m.attachments_word_picture()}
      </span>
    ),
  );
}
interface Preview {
  readonly blocks: ReadonlyArray<Block>;
  readonly truncated: boolean;
}

const isPreview = (data: unknown): data is Preview =>
  !!data &&
  typeof data === "object" &&
  Array.isArray((data as Preview).blocks) &&
  typeof (data as Preview).truncated === "boolean";
const decodePreview = (data: unknown) => (isPreview(data) ? data : null);

const HEADING_SIZES = ["text-xl", "text-lg", "text-base", "text-sm", "text-sm", "text-sm"];

function Runs({ runs }: { runs: ReadonlyArray<Run> }) {
  if (!runs.length) return <br />;
  return runs.map((run, index) => (
    <span
      // oxlint-disable-next-line react/no-array-index-key -- runs have no identity beyond their order
      key={index}
      className={cn(
        "whitespace-pre-wrap",
        run.bold && "font-semibold",
        run.italic && "italic",
        run.underline && "underline",
      )}
      style={{ color: hex(run.color) }}
    >
      {run.text}
    </span>
  ));
}

function Paragraph({ block }: { block: Extract<Block, { type: "paragraph" }> }) {
  const align = cn(
    block.align === "center" && "text-center",
    block.align === "right" && "text-right",
    block.align === "both" && "text-justify",
  );
  if (block.role === "title")
    return (
      <p className={cn("text-2xl font-semibold", align)} style={lookStyle(block.look)}>
        <Runs runs={block.runs} />
      </p>
    );
  if (block.role === "heading")
    return (
      <p
        role="heading"
        aria-level={Math.min(6, Math.max(1, block.level ?? 1))}
        className={cn(
          "pt-2 font-semibold",
          HEADING_SIZES[Math.min(5, Math.max(0, (block.level ?? 1) - 1))],
          align,
        )}
        style={lookStyle(block.look)}
      >
        <Runs runs={block.runs} />
      </p>
    );
  if (block.role === "list")
    return (
      <p
        className={cn("flex gap-2", align)}
        style={{ paddingInlineStart: `${1 + (block.level ?? 0) * 1.25}rem` }}
      >
        <span aria-hidden className="text-paper-foreground/60 min-w-4 shrink-0 tabular-nums">
          {block.marker?.slice(0, 12) || "•"}
        </span>
        <span>
          <Runs runs={block.runs} />
        </span>
      </p>
    );
  if (block.role === "quote")
    return (
      <blockquote className={cn("italic", align)}>
        <Runs runs={block.runs} />
      </blockquote>
    );
  return (
    <p className={align}>
      {block.pictures ? <Pictures pictures={block.pictures} /> : null}
      {block.runs.length || !block.pictures ? <Runs runs={block.runs} /> : null}
    </p>
  );
}

function Contents({ block }: { block: Extract<Block, { type: "tableOfContents" }> }) {
  return (
    <nav aria-label={m.attachments_word_toc()} className="bg-paper-foreground/5 space-y-1 rounded-md p-3">
      <p className="text-paper-foreground/60 text-xs">
        {m.attachments_word_toc_note()}
      </p>
      {block.entries.length ? (
        block.entries.map((entry, index) => (
          <p
            // oxlint-disable-next-line react/no-array-index-key -- entries are an ordered snapshot
            key={index}
            style={{ paddingInlineStart: `${(entry.level - 1) * 1}rem` }}
          >
            {entry.text}
          </p>
        ))
      ) : (
        <p className="text-paper-foreground/60">{m.attachments_word_toc_empty()}</p>
      )}
    </nav>
  );
}

/** A Word document's text and structure, read-only; the server decides what is shown. */
export function WordPreview({ source }: { source: OfficeFile }) {
  const url = `/api/word/${source.kind}/${encodeURIComponent(source.id)}`;
  const state = usePreviewJson(url, decodePreview);

  if (state.status === "error")
    return (
      <FieldError>{m.attachments_word_load_failed()}</FieldError>
    );
  const preview = state.status === "ready" ? state.preview : null;
  const hidden =
    preview?.blocks.reduce(
      (count, block) =>
        count +
        (block.type === "paragraph"
          ? (block.pictures ?? []).filter((picture) => !drawable(picture.src)).length
          : 0),
      0,
    ) ?? 0;
  return (
    <div className="min-w-0 space-y-2">
      <div className="bg-paper text-paper-foreground relative max-h-[60vh] min-h-40 overflow-auto rounded-xl border p-6">
        {!preview ? (
          <Spinner
            aria-label={m.attachments_word_loading()}
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
          />
        ) : preview.blocks.length === 0 ? (
          <p className="text-paper-foreground/60 text-sm">{m.attachments_word_empty()}</p>
        ) : (
          <article aria-label={m.attachments_word_preview()} className="space-y-2 text-sm leading-relaxed">
            {preview.blocks.map((block, index) =>
              block.type === "tableOfContents" ? (
                // oxlint-disable-next-line react/no-array-index-key -- blocks are a fixed, ordered snapshot
                <Contents key={index} block={block} />
              ) : block.type === "pageBreak" ? (
                // oxlint-disable-next-line react/no-array-index-key -- blocks are a fixed, ordered snapshot
                <hr key={index} className="border-border my-4 border-dashed" />
              ) : block.type === "table" ? (
                // oxlint-disable-next-line react/no-array-index-key -- blocks are a fixed, ordered snapshot
                <div key={index} className="overflow-x-auto">
                  <table className="border-collapse text-xs">
                    <tbody>
                      {block.rows.map((row, rowIndex) => (
                        // oxlint-disable-next-line react/no-array-index-key -- a table row is its position
                        <tr key={rowIndex}>
                          {row.map((cell, column) => (
                            <td
                              // oxlint-disable-next-line react/no-array-index-key -- a cell is its column
                              key={column}
                              className={cn(
                                "border px-2 py-1 align-top whitespace-pre-wrap",
                                rowIndex === 0 && "bg-paper-foreground/5 font-semibold",
                              )}
                            >
                              {cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                // oxlint-disable-next-line react/no-array-index-key -- blocks are a fixed, ordered snapshot
                <Paragraph key={index} block={block} />
              ),
            )}
          </article>
        )}
      </div>
      {preview && (preview.truncated || hidden > 0) ? (
        <p className="text-muted-foreground text-xs">
          {[
            preview.truncated ? m.attachments_word_truncated() : null,
            hidden > 0 ? m.attachments_word_pictures_hidden({ count: hidden }) : null,
            m.attachments_word_download_hint(),
          ]
            .filter(Boolean)
            .join(" ")}
        </p>
      ) : null}
    </div>
  );
}
