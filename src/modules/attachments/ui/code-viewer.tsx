import { code } from "@streamdown/code";
import { useMemo, useReducer, type CSSProperties } from "react";
import { cn } from "~/ui/utils";

// A file viewer, not a chat code fence. Streamdown's fence is message
// furniture — its own bordered card, sidebar fill and header bar — which
// inside the preview dialog reads as a box in a box, with two headers naming
// the same file. This renders shiki's tokens directly into a gutter+code grid
// so the dialog frame is the only frame.
//
// It borrows the `code` plugin the markdown pipeline already loads, so the
// highlighter, its grammar cache and its bundle cost are shared rather than
// duplicated.

type Tokens = NonNullable<ReturnType<typeof code.highlight>>["tokens"];

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
  const [version, retry] = useReducer((n: number) => n + 1, 0);

  // Both the cache read and the subscription are this one call: it returns the
  // tokens outright when the plugin has already highlighted this exact input,
  // and otherwise returns null after registering the callback. Registering has
  // to happen here rather than in an effect — the plugin adds the callback in
  // the same synchronous block that starts the load, so an already-loaded
  // grammar resolves before any effect could subscribe, and the file would
  // stay grey forever. The callback only re-renders; the retried call is the
  // one that reads the now-populated cache.
  return useMemo(() => {
    if (!eligible) return null;
    void version;
    const result = code.highlight(
      { code: text, language: supported as never, themes: [...THEMES] },
      retry,
    );
    return result === null ? null : dropTrailingBlank(result.tokens, text);
  }, [text, supported, eligible, version, retry]);
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
          <div key={index} className="group flex leading-[1.6]">
            <span
              aria-hidden
              // Sticky so the numbers survive horizontal scrolling. Its fill
              // must be the container's exact colour — a translucent one would
              // stack over that and show as a strip — and opaque, so long lines
              // pass behind the numbers rather than through them.
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
