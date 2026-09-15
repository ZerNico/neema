import { useEffect, useMemo, useState } from "react";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { LanguageDescription, LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";

const theme = EditorView.theme({
  // A bounded pane that scrolls its own content, rather than a block that grows
  // until the page scrolls, which is the shape an editor has. A host that is
  // itself a scroller overrides these, or the two nest.
  "&": {
    color: "var(--foreground)",
    backgroundColor: "transparent",
    fontSize: "0.875rem",
    maxHeight: "var(--editor-max-height, min(70vh, 40rem))",
  },
  ".cm-content": {
    fontFamily: "var(--font-mono, monospace)",
    padding: "1rem",
    minHeight: "var(--editor-min-height, 24rem)",
    caretColor: "var(--foreground)",
    // CodeMirror leaves this to the host stylesheet, and ours resets it, so the
    // one surface in the app you type into showed an arrow.
    cursor: "text",
  },
  ".cm-scroller": { overflow: "auto", fontFamily: "inherit" },
  ".cm-gutters": {
    backgroundColor: "var(--muted)",
    color: "var(--muted-foreground)",
    border: "none",
  },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--muted)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--accent)",
  },
  "&.cm-focused": { outline: "none" },
});
// A package is not only Markdown — `scripts/*.py` and other code files travel
// with it — so the grammar follows the file name. `language-data` loads each
// one on demand, which also highlights fenced code inside SKILL.md.
const markdownExtensions = [markdown({ codeLanguages: languages })];
const plainText: never[] = [];
const isMarkdown = (path: string) => /\.md$/iu.test(path);
export default function SkillTextEditor({
  value,
  onChange,
  path,
  label,
  autoFocus = false,
  readOnly = false,
  focusRequest,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Relative path in the package; picks the grammar. */
  path: string;
  label: string;
  autoFocus?: boolean;
  readOnly?: boolean;
  focusRequest?: { line: number; sequence: number } | undefined;
}) {
  const [view, setView] = useState<EditorView | null>(null);
  // Keyed by path, so a grammar that arrives after a file switch is ignored
  // rather than applied to whatever is open now.
  const [loaded, setLoaded] = useState<{ path: string; support: LanguageSupport } | null>(null);
  useEffect(() => {
    if (isMarkdown(path)) return;
    let current = true;
    const description = LanguageDescription.matchFilename(languages, path);
    // An unknown extension stays plain text rather than guessing a grammar.
    void description?.load().then((support: LanguageSupport) => {
      if (current) setLoaded({ path, support });
    });
    return () => {
      current = false;
    };
  }, [path]);
  const extensions = useMemo(
    () =>
      isMarkdown(path) ? markdownExtensions : loaded?.path === path ? [loaded.support] : plainText,
    [path, loaded],
  );
  useEffect(() => {
    if (!view || !focusRequest) return;
    const line = view.state.doc.line(
      Math.min(Math.max(1, focusRequest.line), view.state.doc.lines),
    );
    view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
    view.focus();
  }, [view, focusRequest]);
  return (
    <CodeMirror
      onCreateEditor={setView}
      value={value}
      onChange={onChange}
      aria-label={label}
      theme={theme}
      extensions={extensions}
      autoFocus={autoFocus}
      readOnly={readOnly}
      indentWithTab={false}
      basicSetup={{
        lineNumbers: false,
        foldGutter: false,
        highlightActiveLine: false,
        highlightActiveLineGutter: false,
      }}
    />
  );
}
