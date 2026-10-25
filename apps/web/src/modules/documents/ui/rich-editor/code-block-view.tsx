import { m } from "~/paraglide/messages.js";
import {
  NodeViewContent,
  NodeViewWrapper,
  useEditorState,
  type ReactNodeViewProps,
} from "@tiptap/react";
import { useEffect, useState } from "react";
import { useTheme } from "~/ui/theme.tsx";

// Mermaid is large; it loads with the first diagram, as in the transcript.
let mermaid: Promise<typeof import("@streamdown/mermaid")> | null = null;
let appliedTheme: string | null = null;
let renders = 0;
// Each render gets its own id: mermaid first removes any element with the id
// it is given, which would be the diagram already on show.
const draw = async (source: string, theme: "dark" | "default") => {
  const id = `diagram-${++renders}`;
  const plugin = (await (mermaid ??= import("@streamdown/mermaid"))).mermaid;
  const instance = plugin.getMermaid(appliedTheme === theme ? undefined : { theme });
  appliedTheme = theme;
  try {
    return (await instance.render(id, source)).svg;
  } finally {
    // On failure mermaid can leave its error drawing in the page's body.
    document.getElementById(`d${id}`)?.remove();
  }
};

/** Waits this long after the last keystroke before drawing again. */
const SETTLE_MS = 300;

function Diagram({ source, onEdit }: { source: string; onEdit: () => void }) {
  // Subscribed for the re-render; the page's class says which theme "system" resolved to.
  useTheme();
  const theme = document.documentElement.classList.contains("dark") ? "dark" : "default";
  // Source half typed rarely draws. The last diagram that did stays, so the
  // block keeps its size while someone edits, with a note until it draws again.
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!source.trim()) return;
    let current = true;
    const timer = window.setTimeout(() => {
      draw(source, theme)
        .then((next) => {
          if (!current) return;
          setSvg(next);
          setFailed(false);
        })
        .catch(() => current && setFailed(true));
    }, SETTLE_MS);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [source, theme]);
  if (!svg)
    return (
      <div data-diagram className="code-diagram text-muted-foreground items-center text-sm">
        {failed ? m.documents_diagram_failed() : null}
      </div>
    );
  return (
    <div
      data-diagram={failed ? "stale" : ""}
      className="code-diagram relative"
      contentEditable={false}
      onClick={onEdit}
    >
      {/* Mermaid sanitizes its own output (strict security level). */}
      {/* oxlint-disable-next-line react/no-danger -- the SVG mermaid drew */}
      <div className="contents" dangerouslySetInnerHTML={{ __html: svg }} />
      {failed ? (
        <span className="bg-background text-muted-foreground absolute top-2 right-2 rounded-md px-1.5 text-xs">
          {m.documents_diagram_stale()}
        </span>
      ) : null}
    </div>
  );
}

/**
 * A code block as the browser draws it. A Mermaid block shows its diagram and
 * its source only while the cursor is in it; the document holds the source
 * either way, so the Markdown and the model see a fenced block.
 */
export function CodeBlockView({ node, editor, getPos }: ReactNodeViewProps) {
  const language = typeof node.attrs.language === "string" ? node.attrs.language : null;
  const diagram = language === "mermaid";
  const editing = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      if (!diagram || !current.isEditable) return false;
      const position = getPos();
      if (typeof position !== "number") return false;
      const { from, to } = current.state.selection;
      return from > position && to < position + current.state.doc.nodeAt(position)!.nodeSize;
    },
  });
  const source = node.textContent;
  return (
    <NodeViewWrapper>
      {diagram && source.trim() ? (
        <Diagram
          source={source}
          onEdit={() => {
            const position = getPos();
            if (editor.isEditable && typeof position === "number")
              editor
                .chain()
                .focus()
                .setTextSelection(position + 1)
                .run();
          }}
        />
      ) : null}
      <pre hidden={diagram && Boolean(source.trim()) && !editing}>
        <NodeViewContent<"code">
          as="code"
          className={language ? `language-${language}` : undefined}
        />
      </pre>
    </NodeViewWrapper>
  );
}
