// Tolerant parser for the body of a ```ui block. Blocks are parsed on every
// streaming render, so a half-written block must never throw: an unfinished
// trailing tag or expression is dropped, open elements close at the end, and
// structural mistakes become diagnostics instead of failures.

export const LIMITS = {
  sourceChars: 32 * 1024,
  depth: 64,
  nodes: 4000,
} as const;

export interface Span {
  readonly start: number;
  readonly end: number;
}

export type AttrValue =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "expr"; readonly code: string }
  | { readonly kind: "flag" };

export interface Attr {
  readonly name: string;
  readonly value: AttrValue;
  readonly span: Span;
}

export interface ElementNode {
  readonly type: "element";
  readonly tag: string;
  readonly attrs: Attr[];
  readonly children: UiNode[];
  readonly span: Span;
}

export interface TextNode {
  readonly type: "text";
  readonly value: string;
  readonly span: Span;
}

export interface ExprNode {
  readonly type: "expr";
  readonly code: string;
  readonly span: Span;
}

export interface EachNode {
  readonly type: "each";
  readonly list: string;
  readonly item: string;
  readonly index: string | null;
  readonly body: UiNode[];
  readonly fallback: UiNode[];
  readonly span: Span;
}

export interface IfNode {
  readonly type: "if";
  readonly branches: { readonly test: string; readonly body: UiNode[] }[];
  fallback: UiNode[] | null;
  readonly span: Span;
}

export type UiNode = ElementNode | TextNode | ExprNode | EachNode | IfNode;

export type DiagnosticAction =
  | "dropped_prop"
  | "dropped_expression"
  | "omitted_node"
  | "recovered_parse"
  | "rejected_script";

export interface Diagnostic {
  readonly action: DiagnosticAction;
  readonly code: string;
  readonly line: number;
  readonly column: number;
  readonly detail?: string;
}

export interface ScriptSource {
  readonly code: string;
  readonly span: Span;
  readonly closed: boolean;
}

export interface UiProgram {
  readonly script: ScriptSource | null;
  readonly nodes: UiNode[];
  readonly diagnostics: Diagnostic[];
  /** False while anything was cut off: an open element, block, tag or script. */
  readonly complete: boolean;
}

type Frame =
  | { readonly kind: "root"; readonly children: UiNode[] }
  | { readonly kind: "element"; readonly node: ElementNode; readonly attached: boolean }
  | { readonly kind: "each"; readonly node: EachNode; inElse: boolean }
  | { readonly kind: "if"; readonly node: IfNode };

const NAME_START = /[A-Za-z]/;
const TAG_NAME = /[A-Za-z][A-Za-z0-9-]*/y;
const ATTR_NAME = /[A-Za-z_:][A-Za-z0-9_:.-]*/y;
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** `stroke-width` → `strokeWidth`; `onClick` → `onclick`. */
function normalizeAttrName(name: string): string {
  if (/^on[A-Za-z]/.test(name)) return name.toLowerCase();
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Index just past the `}` closing an expression that starts at `from` (just
 * after its `{`), or -1 when the source ends first. Tracks nested braces,
 * quoted strings and template literals with their own `${}`.
 */
export function matchBrace(source: string, from: number): number {
  // Each entry is the closer awaited: "}" for braces, "`" for a template.
  const stack: string[] = ["}"];
  let i = from;
  while (i < source.length) {
    const c = source[i]!;
    const top = stack[stack.length - 1];
    if (top === "`") {
      if (c === "\\") i += 2;
      else if (c === "`") {
        stack.pop();
        i++;
      } else if (c === "$" && source[i + 1] === "{") {
        stack.push("}");
        i += 2;
      } else i++;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < source.length && source[i] !== c) i += source[i] === "\\" ? 2 : 1;
      if (i >= source.length) return -1;
      i++;
      continue;
    }
    if (c === "`") stack.push("`");
    else if (c === "{") stack.push("}");
    else if (c === "}") {
      stack.pop();
      if (stack.length === 0) return i + 1;
    }
    i++;
  }
  return -1;
}

class Parser {
  private pos = 0;
  private nodeCount = 0;
  private truncated = false;
  private readonly diagnostics: Diagnostic[] = [];
  private readonly root: UiNode[] = [];
  private readonly stack: Frame[] = [{ kind: "root", children: this.root }];

  constructor(private readonly source: string) {}

  parse(): UiProgram {
    if (this.source.length > LIMITS.sourceChars) {
      this.report("omitted_node", "source_too_large", 0);
      return { script: null, nodes: [], diagnostics: this.diagnostics, complete: true };
    }
    const script = this.leadingScript();
    if (script && !script.closed) {
      return { script, nodes: [], diagnostics: this.diagnostics, complete: false };
    }
    while (this.pos < this.source.length && !this.truncated) this.step();
    const open = this.stack.length > 1;
    return {
      script,
      nodes: this.root,
      diagnostics: this.diagnostics,
      complete: !open && !this.truncated,
    };
  }

  private leadingScript(): ScriptSource | null {
    const lead = /\s*<script(?:\s[^>]*)?>/iy;
    lead.lastIndex = 0;
    const open = lead.exec(this.source);
    if (!open) return null;
    const bodyStart = lead.lastIndex;
    const close = this.source.toLowerCase().indexOf("</script>", bodyStart);
    if (close === -1) {
      this.pos = this.source.length;
      return {
        code: this.source.slice(bodyStart),
        span: { start: open.index, end: this.source.length },
        closed: false,
      };
    }
    this.pos = close + "</script>".length;
    return {
      code: this.source.slice(bodyStart, close),
      span: { start: open.index, end: this.pos },
      closed: true,
    };
  }

  private step(): void {
    const c = this.source[this.pos]!;
    if (c === "<") {
      const next = this.source[this.pos + 1];
      if (this.source.startsWith("<!--", this.pos)) return this.comment();
      if (next === "/") return this.closeTag();
      if (next !== undefined && NAME_START.test(next)) return this.openTag();
      if (next === undefined) {
        this.truncated = true;
        return;
      }
    }
    if (c === "{") return this.brace();
    this.text();
  }

  private text(): void {
    const start = this.pos;
    let i = this.pos + 1;
    while (i < this.source.length) {
      const c = this.source[i]!;
      if (c === "{") break;
      if (c === "<") {
        const n = this.source[i + 1];
        if (n === undefined || n === "/" || n === "!" || NAME_START.test(n)) break;
      }
      i++;
    }
    this.pos = i;
    this.append({ type: "text", value: this.source.slice(start, i), span: { start, end: i } });
  }

  private comment(): void {
    const end = this.source.indexOf("-->", this.pos + 4);
    if (end === -1) {
      this.truncated = true;
      this.pos = this.source.length;
      return;
    }
    this.pos = end + 3;
  }

  private openTag(): void {
    const start = this.pos;
    TAG_NAME.lastIndex = this.pos + 1;
    const name = TAG_NAME.exec(this.source);
    if (!name) {
      this.text();
      return;
    }
    let i = TAG_NAME.lastIndex;
    const attrs: Attr[] = [];
    for (;;) {
      while (i < this.source.length && /\s/.test(this.source[i]!)) i++;
      if (i >= this.source.length) return this.cutOff();
      const c = this.source[i]!;
      if (c === ">" || (c === "/" && this.source[i + 1] === ">")) {
        const selfClosing = c === "/";
        this.pos = i + (selfClosing ? 2 : 1);
        const tag = name[0].toLowerCase();
        if (tag === "script") return this.strayScript(start);
        const node: ElementNode = {
          type: "element",
          tag,
          attrs,
          children: [],
          span: { start, end: this.pos },
        };
        if (selfClosing) this.append(node);
        else this.pushElement(node);
        return;
      }
      if (c === "/") {
        if (i + 1 >= this.source.length) return this.cutOff();
        i++;
        continue;
      }
      const attr = this.attribute(i);
      if (attr === "cut") return this.cutOff();
      if (attr === null) {
        // Unreadable character inside a tag: skip it rather than lose the tag.
        this.report("dropped_prop", "invalid_attribute", i);
        i++;
        continue;
      }
      attrs.push(attr.attr);
      i = attr.end;
    }
  }

  private attribute(at: number): { attr: Attr; end: number } | "cut" | null {
    if (this.source[at] === "{") {
      // Svelte shorthand: {gear} means gear={gear}.
      const end = matchBrace(this.source, at + 1);
      if (end === -1) return "cut";
      const code = this.source.slice(at + 1, end - 1).trim();
      if (!IDENT.test(code)) return null;
      return {
        attr: { name: code, value: { kind: "expr", code }, span: { start: at, end } },
        end,
      };
    }
    ATTR_NAME.lastIndex = at;
    const name = ATTR_NAME.exec(this.source);
    if (!name) return null;
    let i = ATTR_NAME.lastIndex;
    const attrName = normalizeAttrName(name[0]);
    while (i < this.source.length && /\s/.test(this.source[i]!)) i++;
    if (i >= this.source.length) return "cut";
    if (this.source[i] !== "=") {
      return {
        attr: { name: attrName, value: { kind: "flag" }, span: { start: at, end: i } },
        end: i,
      };
    }
    i++;
    while (i < this.source.length && /\s/.test(this.source[i]!)) i++;
    if (i >= this.source.length) return "cut";
    const q = this.source[i]!;
    if (q === '"' || q === "'") {
      const close = this.source.indexOf(q, i + 1);
      if (close === -1) return "cut";
      return {
        attr: {
          name: attrName,
          value: { kind: "literal", value: this.source.slice(i + 1, close) },
          span: { start: at, end: close + 1 },
        },
        end: close + 1,
      };
    }
    if (q === "{") {
      const end = matchBrace(this.source, i + 1);
      if (end === -1) return "cut";
      return {
        attr: {
          name: attrName,
          value: { kind: "expr", code: this.source.slice(i + 1, end - 1) },
          span: { start: at, end },
        },
        end,
      };
    }
    // Unquoted value: up to whitespace or the tag's end.
    const unquoted = /[^\s>"'=`<]+/y;
    unquoted.lastIndex = i;
    const value = unquoted.exec(this.source);
    if (!value) return null;
    return {
      attr: {
        name: attrName,
        value: { kind: "literal", value: value[0] },
        span: { start: at, end: unquoted.lastIndex },
      },
      end: unquoted.lastIndex,
    };
  }

  /** `<script>` anywhere but the start is not run; skip its body. */
  private strayScript(start: number): void {
    this.report("omitted_node", "script_not_leading", start);
    const close = this.source.toLowerCase().indexOf("</script>", this.pos);
    if (close === -1) {
      this.truncated = true;
      this.pos = this.source.length;
      return;
    }
    this.pos = close + "</script>".length;
  }

  private closeTag(): void {
    const start = this.pos;
    const end = this.source.indexOf(">", this.pos);
    if (end === -1) return this.cutOff();
    const tag = this.source
      .slice(this.pos + 2, end)
      .trim()
      .toLowerCase();
    this.pos = end + 1;
    // Close the nearest matching element, never across an open block: a
    // closing tag cannot end an {#if} it was opened outside of.
    for (let i = this.stack.length - 1; i > 0; i--) {
      const frame = this.stack[i]!;
      if (frame.kind !== "element") break;
      if (frame.node.tag === tag) {
        if (i !== this.stack.length - 1) this.report("recovered_parse", "unclosed_element", start);
        this.stack.length = i;
        return;
      }
    }
    this.report("recovered_parse", "stray_closing_tag", start, tag);
  }

  private brace(): void {
    const start = this.pos;
    const end = matchBrace(this.source, this.pos + 1);
    if (end === -1) return this.cutOff();
    this.pos = end;
    const inner = this.source.slice(start + 1, end - 1);
    const span = { start, end };
    const head = inner.trimStart();
    if (head.startsWith("#if ") || head === "#if") return this.openIf(head.slice(3).trim(), span);
    if (head.startsWith("#each")) return this.openEach(head.slice(5).trim(), span);
    if (head.startsWith(":else")) return this.elseBranch(head.slice(5).trim(), span);
    if (head.startsWith("/if")) return this.closeBlock("if", span);
    if (head.startsWith("/each")) return this.closeBlock("each", span);
    if (/^[#:/@]/.test(head)) {
      this.report("dropped_expression", "unknown_directive", start, head.split(/\s/)[0]);
      return;
    }
    if (inner.trim() === "") return;
    this.append({ type: "expr", code: inner, span });
  }

  private openIf(test: string, span: Span): void {
    if (test === "") {
      this.report("dropped_expression", "empty_if", span.start);
      return;
    }
    const node: IfNode = { type: "if", branches: [{ test, body: [] }], fallback: null, span };
    if (this.append(node)) this.stack.push({ kind: "if", node });
  }

  private openEach(head: string, span: Span): void {
    // `list as item, i (key)`: split on the last top-level ` as `.
    const at = head.lastIndexOf(" as ");
    const list = at === -1 ? "" : head.slice(0, at).trim();
    const binding = (at === -1 ? "" : head.slice(at + 4))
      .replace(/\(.*\)\s*$/, "")
      .trim()
      .split(",")
      .map((s) => s.trim());
    const [item, index = null] = binding;
    if (!list || !item || !IDENT.test(item) || (index !== null && !IDENT.test(index))) {
      this.report("dropped_expression", "invalid_each", span.start, head);
      // Still open a frame so the body and {/each} stay balanced.
      const node: EachNode = {
        type: "each",
        list: "[]",
        item: "__item",
        index: null,
        body: [],
        fallback: [],
        span,
      };
      this.stack.push({ kind: "each", node, inElse: false });
      return;
    }
    const node: EachNode = { type: "each", list, item, index, body: [], fallback: [], span };
    if (this.append(node)) this.stack.push({ kind: "each", node, inElse: false });
  }

  private elseBranch(rest: string, span: Span): void {
    const frame = this.stack[this.stack.length - 1]!;
    if (frame.kind === "if") {
      if (frame.node.fallback !== null) {
        this.report("recovered_parse", "else_after_else", span.start);
        return;
      }
      if (rest.startsWith("if ")) frame.node.branches.push({ test: rest.slice(3).trim(), body: [] });
      else frame.node.fallback = [];
      return;
    }
    if (frame.kind === "each" && rest === "") {
      frame.inElse = true;
      return;
    }
    this.report("recovered_parse", "stray_else", span.start);
  }

  private closeBlock(kind: "if" | "each", span: Span): void {
    for (let i = this.stack.length - 1; i > 0; i--) {
      const frame = this.stack[i]!;
      if (frame.kind === kind) {
        if (i !== this.stack.length - 1) this.report("recovered_parse", "unclosed_element", span.start);
        this.stack.length = i;
        return;
      }
    }
    this.report("recovered_parse", `stray_close_${kind}`, span.start);
  }

  private pushElement(node: ElementNode): void {
    const depth = this.stack.filter((f) => f.kind === "element").length;
    if (depth >= LIMITS.depth) {
      this.report("omitted_node", "too_deep", node.span.start);
      // Keep parsing its children so the structure stays balanced, detached.
      this.stack.push({ kind: "element", node, attached: false });
      return;
    }
    const attached = this.append(node);
    this.stack.push({ kind: "element", node, attached });
  }

  /** Adds a node to the innermost open container; false once over the cap. */
  private append(node: UiNode): boolean {
    if (this.nodeCount >= LIMITS.nodes) {
      if (this.nodeCount === LIMITS.nodes) this.report("omitted_node", "too_many_nodes", node.span.start);
      this.nodeCount++;
      this.truncated = true;
      return false;
    }
    this.nodeCount++;
    this.children().push(node);
    return true;
  }

  private children(): UiNode[] {
    const frame = this.stack[this.stack.length - 1]!;
    switch (frame.kind) {
      case "root":
        return frame.children;
      case "element":
        return frame.node.children;
      case "each":
        return frame.inElse ? frame.node.fallback : frame.node.body;
      case "if":
        return frame.node.fallback ?? frame.node.branches[frame.node.branches.length - 1]!.body;
    }
  }

  /** The source ended inside a construct: drop it, the rest is still coming. */
  private cutOff(): void {
    this.truncated = true;
    this.pos = this.source.length;
  }

  private report(action: DiagnosticAction, code: string, offset: number, detail?: string): void {
    const before = this.source.slice(0, offset);
    const line = before.split("\n").length;
    const column = offset - before.lastIndexOf("\n");
    this.diagnostics.push(detail === undefined ? { action, code, line, column } : { action, code, line, column, detail });
  }
}

export function parseUi(source: string): UiProgram {
  return new Parser(source).parse();
}
