// Turns a parsed block into one JavaScript function for QuickJS. The output is
// sloppy-mode on purpose: `with (__state)` is what lets a handler write
// `gear = v` and have it land in persisted state, and `with` is illegal in
// strict code and modules, so the runtime evaluates it as a global script.

import { parseUi, type Attr, type Diagnostic, type UiNode, type UiProgram } from "./parse.ts";
import { analyzeExpression, analyzeScript, type ScriptAnalysis } from "./script.ts";

export interface CompiledBlock {
  /** A function expression `(function (__rt) { … })` returning the tree builder. */
  readonly source: string;
  readonly stateNames: string[];
  readonly diagnostics: Diagnostic[];
  readonly complete: boolean;
}

export type CompileResult =
  | { readonly ok: true; readonly block: CompiledBlock }
  /** The script broke the contract or did not parse: show the source instead. */
  | { readonly ok: false; readonly diagnostics: Diagnostic[]; readonly incomplete: boolean };

/** Whitespace between tags that spans a line is layout, not content. */
function normalizeText(value: string): string | null {
  if (value.trim() === "") return /\n/.test(value) ? null : " ";
  return value.replace(/\s+/g, " ");
}

class Emitter {
  readonly diagnostics: Diagnostic[] = [];

  constructor(private readonly script: ScriptAnalysis) {}

  /** A guarded expression, or `fallback` when it breaks the contract. */
  private expr(code: string, locals: readonly string[], fallback: string, at: string): string {
    const issues = analyzeExpression(code, this.script, locals);
    if (issues.length > 0) {
      const issue = issues[0]!;
      this.diagnostics.push({
        action: "dropped_expression",
        code: issue.code,
        line: issue.line,
        column: issue.column,
        detail: `${at}${issue.detail ? `: ${issue.detail}` : ""}`,
      });
      return fallback;
    }
    return `__safe(function () { return (${code}); }, ${fallback})`;
  }

  private attr(attr: Attr, locals: readonly string[]): string {
    switch (attr.value.kind) {
      case "literal":
        return JSON.stringify(attr.value.value);
      case "flag":
        return "true";
      case "expr":
        return `__prop(${this.expr(attr.value.code, locals, "undefined", attr.name)})`;
    }
  }

  nodes(nodes: readonly UiNode[], locals: readonly string[]): string {
    const parts: string[] = [];
    for (const node of nodes) {
      const part = this.node(node, locals);
      if (part !== null) parts.push(part);
    }
    return `[${parts.join(", ")}]`;
  }

  private node(node: UiNode, locals: readonly string[]): string | null {
    switch (node.type) {
      case "text": {
        const text = normalizeText(node.value);
        return text === null ? null : JSON.stringify(text);
      }
      case "expr":
        return this.expr(node.code, locals, "null", "expression");
      case "element": {
        const props = node.attrs
          .map((a) => `${JSON.stringify(a.name)}: ${this.attr(a, locals)}`)
          .join(", ");
        return `__el(${JSON.stringify(node.tag)}, {${props}}, ${this.nodes(node.children, locals)})`;
      }
      case "each": {
        const inner = node.index ? [...locals, node.item, node.index] : [...locals, node.item];
        const params = node.index ? `${node.item}, ${node.index}` : node.item;
        const list = this.expr(node.list, locals, "[]", "each");
        return `__each(${list}, function (${params}) { return ${this.nodes(node.body, inner)}; }, function () { return ${this.nodes(node.fallback, locals)}; })`;
      }
      case "if": {
        let out = node.fallback ? this.nodes(node.fallback, locals) : "[]";
        for (let i = node.branches.length - 1; i >= 0; i--) {
          const branch = node.branches[i]!;
          out = `(${this.expr(branch.test, locals, "false", "if")} ? ${this.nodes(branch.body, locals)} : ${out})`;
        }
        return out;
      }
    }
  }
}

function scriptDiagnostics(script: ScriptAnalysis): Diagnostic[] {
  return script.issues.map((issue) => ({
    action: "rejected_script" as const,
    code: issue.code,
    line: issue.line,
    column: issue.column,
    ...(issue.detail === undefined ? {} : { detail: issue.detail }),
  }));
}

export function compileProgram(program: UiProgram): CompileResult {
  if (program.script && !program.script.closed) {
    return { ok: false, diagnostics: program.diagnostics, incomplete: true };
  }
  const script = analyzeScript(program.script?.code ?? null);
  if (script.issues.length > 0) {
    return {
      ok: false,
      diagnostics: [...program.diagnostics, ...scriptDiagnostics(script)],
      incomplete: false,
    };
  }
  const emitter = new Emitter(script);
  const tree = emitter.nodes(program.nodes, []);
  const freeze =
    script.frozenNames.length > 0 ? `__freeze([${script.frozenNames.join(", ")}]);` : "";
  // The script's own declarations sit inside both `with` blocks, so they
  // shadow state and derived names only where the script declares them.
  const source = `(function (__rt) {
  var __state = __rt.state, __derived = Object.create(null);
  var __decl = __rt.decl, __safe = __rt.safe, __prop = __rt.prop, __el = __rt.el, __each = __rt.each, __freeze = __rt.freeze;
  var __derive = function (name, get) { Object.defineProperty(__derived, name, { get: get, enumerable: true }); };
  var __tree;
  with (__derived) { with (__state) {
${script.rewritten}
;${freeze}
__tree = function () { return ${tree}; };
  } }
  return __tree;
})`;
  return {
    ok: true,
    block: {
      source,
      stateNames: script.stateNames,
      diagnostics: [...program.diagnostics, ...emitter.diagnostics],
      complete: program.complete,
    },
  };
}

export function compileUi(source: string): CompileResult {
  return compileProgram(parseUi(source));
}
