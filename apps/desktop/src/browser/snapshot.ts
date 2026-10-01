/** The parts of a CDP `Accessibility.AXNode` the outline reads. */
export interface AxNode {
  readonly nodeId: string;
  readonly ignored?: boolean;
  readonly role?: { readonly value?: unknown };
  readonly name?: { readonly value?: unknown };
  readonly value?: { readonly value?: unknown };
  readonly properties?: ReadonlyArray<{
    readonly name: string;
    readonly value?: { readonly value?: unknown };
  }>;
  readonly childIds?: ReadonlyArray<string>;
  readonly parentId?: string;
  readonly backendDOMNodeId?: number;
}

export const SNAPSHOT_MAX_CHARS = 20_000;
const NAME_MAX_CHARS = 200;

// What a reader acts on gets a reference, so a later click can name it.
const INTERACTIVE = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "treeitem",
]);
// Structure without meaning of its own: its children are read in its place.
const TRANSPARENT = new Set([
  "generic",
  "none",
  "presentation",
  "RootWebArea",
  "InlineTextBox",
  "LineBreak",
  "group",
  "Section",
]);
const STATES = ["checked", "pressed", "expanded", "selected", "disabled", "required", "focused"];

const text = (value: unknown) =>
  typeof value === "string" || typeof value === "number"
    ? String(value).replace(/\s+/g, " ").trim()
    : "";
const clip = (value: string) =>
  value.length > NAME_MAX_CHARS ? `${value.slice(0, NAME_MAX_CHARS)}…` : value;

/**
 * A page as an outline the model can read: one line per meaningful node,
 * indented by nesting, interactive ones with a reference like `[e12]`. Capped,
 * and says so; the references map back to DOM nodes for later actions.
 */
export function serializeAxTree(
  nodes: ReadonlyArray<AxNode>,
  maxChars = SNAPSHOT_MAX_CHARS,
): { text: string; truncated: boolean; refs: Map<string, number> } {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const refs = new Map<string, number>();
  const lines: string[] = [];
  let length = 0;
  let truncated = false;

  const push = (line: string) => {
    if (truncated) return;
    if (length + line.length + 1 > maxChars) {
      truncated = true;
      return;
    }
    lines.push(line);
    length += line.length + 1;
  };

  const visit = (id: string, depth: number, parentName: string) => {
    if (truncated) return;
    const node = byId.get(id);
    if (!node) return;
    const role = text(node.role?.value);
    const name = clip(text(node.name?.value));
    const children = node.childIds ?? [];
    if (node.ignored || TRANSPARENT.has(role)) {
      for (const child of children) visit(child, depth, parentName);
      return;
    }
    if (role === "StaticText") {
      // A link's or a button's label is already on its own line.
      if (name && name !== parentName) push(`${"  ".repeat(depth)}${name}`);
      return;
    }
    let ref = "";
    if (INTERACTIVE.has(role) && node.backendDOMNodeId !== undefined) {
      ref = `e${refs.size + 1}`;
      refs.set(ref, node.backendDOMNodeId);
    }
    const props = new Map((node.properties ?? []).map((prop) => [prop.name, prop.value?.value]));
    const states = STATES.filter((state) => {
      const value = props.get(state);
      return value === true || value === "true" || value === "mixed";
    });
    const level = role === "heading" ? text(props.get("level")) : "";
    const value = clip(text(node.value?.value));
    push(
      `${"  ".repeat(depth)}- ${ref ? `[${ref}] ` : ""}${role}${level ? ` ${level}` : ""}` +
        `${name ? ` "${name}"` : ""}${value ? `: ${value}` : ""}` +
        `${states.length > 0 ? ` (${states.join(", ")})` : ""}`,
    );
    for (const child of children) visit(child, depth + 1, name);
  };

  for (const node of nodes)
    if (node.parentId === undefined || !byId.has(node.parentId)) visit(node.nodeId, 0, "");
  if (truncated) lines.push("… (the page goes on; this outline was cut short)");
  return { text: lines.join("\n"), truncated, refs };
}
