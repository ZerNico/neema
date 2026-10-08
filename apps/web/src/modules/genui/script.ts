// Static checks for a block's JavaScript. Nothing here is evaluated on the
// host: acorn only reads the code so the compiler knows which bindings are
// state and can refuse code that would mutate anything else. That mutation
// contract is what makes rebuilding a block from source plus saved state
// reproduce it exactly (docs/internals/generative-ui.md).

import { parse, parseExpressionAt, type AnyNode, type Options, type Pattern, type Program } from "acorn";

const OPTIONS: Options = { ecmaVersion: "latest", sourceType: "script", locations: true };

/** Names the runtime reserves or that would let code escape the contract. */
const FORBIDDEN = new Set(["eval", "Function", "globalThis", "window", "self"]);

export interface ScriptIssue {
  readonly code: string;
  readonly line: number;
  readonly column: number;
  readonly detail?: string;
}

export interface ScriptAnalysis {
  /** `let x = $state(…)` names, in declaration order. */
  readonly stateNames: string[];
  readonly derivedNames: string[];
  /** Other top-level bindings; deep-frozen once the script has run. */
  readonly frozenNames: string[];
  /** The script with rune declarations replaced by runtime calls. */
  readonly rewritten: string;
  readonly issues: ScriptIssue[];
}

interface Scope {
  readonly names: Set<string>;
  readonly parent: Scope | null;
  /** The script's top level, where only state may be assigned. */
  readonly topLevel: boolean;
}

function isNode(value: unknown): value is AnyNode {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

function children(node: AnyNode): AnyNode[] {
  const out: AnyNode[] = [];
  for (const value of Object.values(node)) {
    if (isNode(value)) out.push(value);
    else if (Array.isArray(value)) for (const item of value) if (isNode(item)) out.push(item);
  }
  return out;
}

function patternNames(pattern: Pattern | AnyNode | null | undefined, into: string[] = []): string[] {
  if (!pattern) return into;
  switch (pattern.type) {
    case "Identifier":
      into.push(pattern.name);
      break;
    case "ObjectPattern":
      for (const prop of pattern.properties) {
        if (prop.type === "RestElement") patternNames(prop.argument, into);
        else patternNames(prop.value, into);
      }
      break;
    case "ArrayPattern":
      for (const element of pattern.elements) patternNames(element, into);
      break;
    case "AssignmentPattern":
      patternNames(pattern.left, into);
      break;
    case "RestElement":
      patternNames(pattern.argument, into);
      break;
    default:
      break;
  }
  return into;
}

/** `var` declarations anywhere in a function body, not inside nested functions. */
function hoistedVars(node: AnyNode, into: Set<string>): void {
  for (const child of children(node)) {
    if (
      child.type === "FunctionDeclaration" ||
      child.type === "FunctionExpression" ||
      child.type === "ArrowFunctionExpression"
    ) {
      continue;
    }
    if (child.type === "VariableDeclaration" && child.kind === "var") {
      for (const d of child.declarations) for (const n of patternNames(d.id)) into.add(n);
    }
    hoistedVars(child, into);
  }
}

/** Block-level declarations made directly in a statement list. */
function blockDeclarations(statements: readonly AnyNode[], into: Set<string>): void {
  for (const s of statements) {
    if (s.type === "VariableDeclaration" && s.kind !== "var") {
      for (const d of s.declarations) for (const n of patternNames(d.id)) into.add(n);
    } else if ((s.type === "FunctionDeclaration" || s.type === "ClassDeclaration") && s.id) {
      into.add(s.id.name);
    }
  }
}

function runeCall(node: AnyNode | null | undefined): "$state" | "$derived" | null {
  if (node?.type !== "CallExpression" || node.callee.type !== "Identifier") return null;
  const name = node.callee.name;
  return name === "$state" || name === "$derived" ? name : null;
}

class Checker {
  readonly issues: ScriptIssue[] = [];

  constructor(private readonly stateNames: ReadonlySet<string>) {}

  report(node: AnyNode, code: string, detail?: string): void {
    const loc = node.loc?.start;
    const issue = { code, line: loc?.line ?? 1, column: (loc?.column ?? 0) + 1 };
    this.issues.push(detail === undefined ? issue : { ...issue, detail });
  }

  private resolve(name: string, scope: Scope): Scope | null {
    for (let s: Scope | null = scope; s; s = s.parent) if (s.names.has(name)) return s;
    return null;
  }

  /** An assignment target must be state, a member of state, or a local. */
  private checkTarget(target: AnyNode, scope: Scope): void {
    if (target.type === "MemberExpression") {
      let root: AnyNode = target;
      while (root.type === "MemberExpression") root = root.object;
      this.walk(target, scope);
      // Roots that are not names (`f().x = 1`) reach only values the
      // runtime has frozen, so they cannot change anything that persists.
      if (root.type === "Identifier") this.checkName(root, root.name, scope);
      return;
    }
    if (target.type === "Identifier") {
      this.checkName(target, target.name, scope);
      return;
    }
    // Destructuring assignment: every bound name is a target.
    for (const name of patternNames(target)) this.checkName(target, name, scope);
    this.walkPatternDefaults(target, scope);
  }

  private checkName(node: AnyNode, name: string, scope: Scope): void {
    // Locals (including ones shadowing a state name) are free to change.
    const owner = this.resolve(name, scope);
    if (owner && (!owner.topLevel || this.stateNames.has(name))) return;
    this.report(node, owner ? "assigns_non_state" : "assigns_global", name);
  }

  private walkPatternDefaults(pattern: AnyNode, scope: Scope): void {
    if (pattern.type === "AssignmentPattern") this.walk(pattern.right, scope);
    for (const child of children(pattern)) if (child.type !== "Identifier") this.walkPatternDefaults(child, scope);
  }

  private functionScope(fn: AnyNode & { params: Pattern[]; body: AnyNode }, scope: Scope): Scope {
    const names = new Set<string>();
    for (const p of fn.params) for (const n of patternNames(p)) names.add(n);
    if (fn.type === "FunctionExpression" && fn.id) names.add(fn.id.name);
    names.add("arguments");
    hoistedVars(fn.body, names);
    if (fn.body.type === "BlockStatement") blockDeclarations(fn.body.body, names);
    return { names, parent: scope, topLevel: false };
  }

  walk(node: AnyNode, scope: Scope): void {
    switch (node.type) {
      case "Identifier":
        if (FORBIDDEN.has(node.name) || node.name.startsWith("__")) {
          this.report(node, "forbidden_name", node.name);
        }
        if (node.name === "$state" || node.name === "$derived") this.report(node, "rune_misplaced", node.name);
        return;
      case "AssignmentExpression":
        this.checkTarget(node.left, scope);
        this.walk(node.right, scope);
        return;
      case "UpdateExpression":
        this.checkTarget(node.argument, scope);
        return;
      case "UnaryExpression":
        if (node.operator === "delete") this.checkTarget(node.argument, scope);
        else this.walk(node.argument, scope);
        return;
      case "MemberExpression":
        this.walk(node.object, scope);
        if (node.computed) this.walk(node.property, scope);
        return;
      case "Property":
      case "PropertyDefinition":
      case "MethodDefinition":
        if (node.computed) this.walk(node.key, scope);
        if (node.value) this.walk(node.value, scope);
        return;
      case "LabeledStatement":
        this.walk(node.body, scope);
        return;
      case "BreakStatement":
      case "ContinueStatement":
      case "MetaProperty":
        return;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression": {
        const inner = this.functionScope(node, scope);
        for (const p of node.params) this.walkPatternDefaults(p, inner);
        if (node.body.type === "BlockStatement") for (const s of node.body.body) this.walk(s, inner);
        else this.walk(node.body, inner);
        return;
      }
      case "BlockStatement":
      case "StaticBlock": {
        const names = new Set<string>();
        blockDeclarations(node.body, names);
        const inner = { names, parent: scope, topLevel: false };
        for (const s of node.body) this.walk(s, inner);
        return;
      }
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement": {
        const names = new Set<string>();
        const head = node.type === "ForStatement" ? node.init : node.left;
        if (head?.type === "VariableDeclaration") {
          for (const d of head.declarations) for (const n of patternNames(d.id)) names.add(n);
        }
        const inner = { names, parent: scope, topLevel: false };
        // `for (x of xs)` assigns x on every iteration.
        const assignsHead = node.type !== "ForStatement" && head && head.type !== "VariableDeclaration";
        if (assignsHead) this.checkTarget(head, inner);
        for (const child of children(node)) if (!assignsHead || child !== head) this.walk(child, inner);
        return;
      }
      case "CatchClause": {
        const names = new Set(patternNames(node.param));
        const inner = { names, parent: scope, topLevel: false };
        this.walk(node.body, inner);
        return;
      }
      case "VariableDeclarator":
        this.walkPatternDefaults(node.id, scope);
        if (node.init) this.walk(node.init, scope);
        return;
      case "ClassDeclaration":
      case "ClassExpression":
        if (node.superClass) this.walk(node.superClass, scope);
        this.walk(node.body, scope);
        return;
      default:
        for (const child of children(node)) this.walk(child, scope);
    }
  }
}

function topLevelScope(stateNames: readonly string[], derivedNames: readonly string[], others: readonly string[]): Scope {
  return { names: new Set([...stateNames, ...derivedNames, ...others]), parent: null, topLevel: true };
}

function issueFromSyntax(error: unknown, offsetLine = 0): ScriptIssue {
  const loc = typeof error === "object" && error && "loc" in error ? error.loc : null;
  const line = typeof loc === "object" && loc && "line" in loc && typeof loc.line === "number" ? loc.line : 1;
  const column =
    typeof loc === "object" && loc && "column" in loc && typeof loc.column === "number" ? loc.column + 1 : 1;
  const message = error instanceof Error ? error.message : String(error);
  return { code: "syntax_error", line: line + offsetLine, column, detail: message };
}

/** Analyses a block's leading `<script>`. An empty analysis when there is none. */
export function analyzeScript(code: string | null): ScriptAnalysis {
  if (code === null || code.trim() === "") {
    return { stateNames: [], derivedNames: [], frozenNames: [], rewritten: "", issues: [] };
  }
  let program: Program;
  try {
    program = parse(code, OPTIONS);
  } catch (error) {
    return { stateNames: [], derivedNames: [], frozenNames: [], rewritten: "", issues: [issueFromSyntax(error)] };
  }

  const stateNames: string[] = [];
  const derivedNames: string[] = [];
  const frozenNames: string[] = [];
  const pre: ScriptIssue[] = [];
  let rewritten = "";
  let at = 0;

  for (const statement of program.body) {
    if (statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") {
      if (statement.id) frozenNames.push(statement.id.name);
      continue;
    }
    if (statement.type !== "VariableDeclaration") continue;
    const hasRune = statement.declarations.some((d) => runeCall(d.init) !== null);
    if (!hasRune) {
      for (const d of statement.declarations) frozenNames.push(...patternNames(d.id));
      continue;
    }
    const parts: string[] = [];
    for (const d of statement.declarations) {
      const rune = runeCall(d.init);
      if (d.id.type !== "Identifier" || rune === null || d.init?.type !== "CallExpression") {
        if (rune !== null) pre.push({ code: "rune_pattern", line: d.loc?.start.line ?? 1, column: 1 });
        parts.push(`${statement.kind} ${code.slice(d.start, d.end)};`);
        frozenNames.push(...patternNames(d.id));
        continue;
      }
      const name = d.id.name;
      const arg = d.init.arguments[0];
      const init = arg ? code.slice(arg.start, arg.end) : "undefined";
      if (rune === "$state") {
        if (statement.kind !== "let") pre.push({ code: "state_needs_let", line: d.loc?.start.line ?? 1, column: 1, detail: name });
        stateNames.push(name);
        parts.push(`__decl(${JSON.stringify(name)}, function () { return (${init}); });`);
      } else {
        derivedNames.push(name);
        parts.push(`__derive(${JSON.stringify(name)}, function () { return (${init}); });`);
      }
    }
    rewritten += code.slice(at, statement.start) + parts.join(" ");
    at = statement.end;
  }
  rewritten += code.slice(at);

  for (const name of [...stateNames, ...derivedNames, ...frozenNames]) {
    if (name.startsWith("__")) pre.push({ code: "forbidden_name", line: 1, column: 1, detail: name });
  }
  const checker = new Checker(new Set(stateNames));
  checker.issues.push(...pre);
  const top = topLevelScope(stateNames, derivedNames, frozenNames);
  for (const statement of program.body) {
    if (statement.type === "VariableDeclaration") {
      for (const d of statement.declarations) {
        const rune = runeCall(d.init);
        // A rune's own call is legal here; check only its argument.
        if (rune !== null && d.init?.type === "CallExpression") {
          for (const arg of d.init.arguments) checker.walk(arg, top);
        } else checker.walk(d, top);
      }
    } else checker.walk(statement, top);
  }
  return { stateNames, derivedNames, frozenNames, rewritten, issues: checker.issues };
}

/**
 * Checks one markup expression (`{…}` or an attribute) against the same
 * contract. `locals` are names bound by enclosing `{#each}` blocks.
 */
export function analyzeExpression(
  code: string,
  script: Pick<ScriptAnalysis, "stateNames" | "derivedNames" | "frozenNames">,
  locals: readonly string[],
): ScriptIssue[] {
  let expression: AnyNode;
  try {
    expression = parseExpressionAt(code, 0, OPTIONS);
  } catch (error) {
    return [issueFromSyntax(error)];
  }
  if (code.slice(expression.end).trim() !== "") {
    return [{ code: "syntax_error", line: 1, column: expression.end + 1, detail: "Unexpected trailing code" }];
  }
  const checker = new Checker(new Set(script.stateNames));
  const top = topLevelScope(script.stateNames, script.derivedNames, script.frozenNames);
  const scope: Scope = { names: new Set(locals), parent: top, topLevel: false };
  checker.walk(expression, scope);
  return checker.issues;
}
