import { code } from "@streamdown/code";
import { useMemo, useState, type CSSProperties } from "react";
import { cn } from "~/ui/utils";

// A file viewer, not a chat code fence: Streamdown's fence adds its own
// bordered card, sidebar and header, which inside this dialog would double up
// with the dialog's own frame. Renders shiki's tokens directly into a
// gutter+code grid instead, reusing the `code` plugin's shared highlighter and
// grammar cache.

type Highlighted = NonNullable<ReturnType<typeof code.highlight>>;
type Tokens = Highlighted["tokens"];

// Highlighting walks every token of the file; past this the gutter and plain
// text are still worth having, the colours are not.
const HIGHLIGHT_CHAR_CAP = 100_000;

// Shiki splits on newlines, so a file ending in one yields a final empty line
// that is an artifact of the terminator rather than a line of the file.
const dropTrailingBlank = (tokens: Tokens, text: string): Tokens => {
  if (!text.endsWith("\n")) return tokens;
  const last = tokens.at(-1);
  return last !== undefined && last.every((token) => token.content === "")
    ? tokens.slice(0, -1)
    : tokens;
};

const THEMES = ["github-light", "github-dark"] as const;

const useHighlighted = (text: string, language: string): Tokens | null => {
  // Shiki's own id for the language, or nothing when it has no grammar for it
  // (csv and tsv are on our extension list but not in the bundle).
  const supported = useMemo(
    () => (language !== "" && code.supportsLanguage(language as never) ? language : null),
    [language],
  );
  const eligible = supported !== null && text.length <= HIGHLIGHT_CHAR_CAP;
  // What highlighting gave once its grammar loaded, for the text and language it was asked.
  const [arrived, setArrived] = useState<{
    text: string;
    language: string;
    result: Highlighted;
  } | null>(null);

  // This one call both reads the cache and subscribes: tokens if already highlighted, else
  // null after registering a callback with the result. It runs during render, not in an
  // effect, since an already-loaded grammar can resolve before an effect subscribes.
  const cached = useMemo(
    () =>
      eligible
        ? code.highlight(
            { code: text, language: supported as never, themes: [...THEMES] },
            (result) => setArrived({ text, language: supported, result }),
          )
        : null,
    [text, supported, eligible],
  );
  const result =
    cached ??
    (arrived && arrived.text === text && arrived.language === supported ? arrived.result : null);
  return useMemo(() => (result ? dropTrailingBlank(result.tokens, text) : null), [result, text]);
};

/**
 * Renders `text` as a scrollable, line-numbered file. Highlights when shiki
 * knows the language and the file is small enough; otherwise shows the same
 * layout unhighlighted rather than falling back to different chrome.
 */
export function CodeViewer({
  text,
  language,
  className,
}: {
  text: string;
  language: string;
  className?: string;
}) {
  const tokens = useHighlighted(text, language);
  // Trailing newline would otherwise show as a phantom final line.
  const plainLines = useMemo(() => text.replace(/\n$/, "").split("\n"), [text]);
  const lineCount = tokens?.length ?? plainLines.length;
  // Enough room for the widest number, so the code column never shifts.
  const gutter = `${String(lineCount).length + 1}ch`;

  return (
    <div className={cn("bg-muted overflow-auto rounded-2xl font-mono text-xs", className)}>
      <div className="min-w-max py-3">
        {(tokens ?? plainLines).map((line, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- a line's number is its identity
          <div key={index} className="group flex leading-[1.6]">
            <span
              aria-hidden
              // Sticky so the numbers survive horizontal scrolling. Its fill
              // must be the container's exact colour, since a translucent one
              // would stack over that and show as a strip, and opaque, so long
              // lines pass behind the numbers rather than through them.
              className="bg-muted text-muted-foreground/50 group-hover:text-muted-foreground/80 sticky left-0 shrink-0 pr-3 pl-4 text-right tabular-nums select-none"
              style={{ width: `calc(${gutter} + 1.75rem)` }}
            >
              {index + 1}
            </span>
            <span className="whitespace-pre pr-4">
              {typeof line === "string"
                ? line
                : line.map((token, tokenIndex) => (
                    <span
                      // oxlint-disable-next-line react/no-array-index-key -- tokens are a fixed split of one line
                      key={tokenIndex}
                      data-shiki-token
                      // htmlStyle carries the light colour plus a --shiki-dark
                      // custom property; app.css swaps to it under .dark.
                      style={token.htmlStyle as CSSProperties}
                    >
                      {token.content}
                    </span>
                  ))}
              {/* A blank line has no content to give it height. */}
              {line.length === 0 ? "\u200B" : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
