import { describe, expect, it } from "vitest";
import { analyzeExpression, analyzeScript } from "./script.ts";

const codes = (code: string) =>
  analyzeScript(code).issues.map((i) => `${i.code}:${i.detail ?? ""}`);

describe("analyzeScript", () => {
  it("finds runes in order and rewrites them in place", () => {
    const analysis = analyzeScript(`const base = 3;
let count = $state(base * 2), label = "x";
const double = $derived(count * 2);
function bump() { count += 1; }`);
    expect(analysis.issues).toEqual([]);
    expect(analysis.stateNames).toEqual(["count"]);
    expect(analysis.derivedNames).toEqual(["double"]);
    expect(analysis.frozenNames).toEqual(["base", "label", "bump"]);
    expect(analysis.rewritten).toContain(
      '__decl("count", function () { return (base * 2); }); let label = "x";',
    );
    expect(analysis.rewritten).toContain(
      '__derive("double", function () { return (count * 2); });',
    );
    expect(analysis.rewritten).toContain("const base = 3;");
  });

  it("allows writing state, members of state and locals", () => {
    expect(
      codes(`let items = $state([]);
let form = $state({ name: "" });
function add(x) { items.push(x); form.name = x; let n = 0; for (let i = 0; i < 3; i++) n += i; return n; }
const run = () => { let wins = 0; for (const d of [1, 2]) { wins++; } items = [...items, wins]; };`),
    ).toEqual([]);
  });

  it("rejects writes to non-state top-level bindings and globals", () => {
    expect(codes("let counter = 0;\nfunction inc() { counter++; }")).toEqual([
      "assigns_non_state:counter",
    ]);
    expect(codes("const box = { n: 0 };\nfunction inc() { box.n = 1; }")).toEqual([
      "assigns_non_state:box",
    ]);
    expect(codes("function leak() { stray = 1; }")).toEqual(["assigns_global:stray"]);
    expect(codes("function wipe() { delete Math.PI; }")).toEqual(["assigns_global:Math"]);
    expect(codes("let [a, b] = [1, 2];\nfunction swap() { [a, b] = [b, a]; }")).toEqual([
      "assigns_non_state:a",
      "assigns_non_state:b",
    ]);
  });

  it("lets a local shadow a top-level name", () => {
    expect(codes("const x = 1;\nfunction f() { let x = 2; x++; return x; }")).toEqual([]);
  });

  it("rejects escapes and misplaced runes", () => {
    expect(codes('function f() { return eval("1"); }')).toEqual(["forbidden_name:eval"]);
    expect(codes("const __state = 1;")).toEqual(["forbidden_name:__state"]);
    expect(codes("function f() { let x = $state(1); }")).toEqual(["rune_misplaced:$state"]);
    expect(codes("const s = $state(1);")).toEqual(["state_needs_let:s"]);
  });

  it("reports syntax errors with a position", () => {
    const [issue] = analyzeScript("let x = $state(1;\n").issues;
    expect(issue?.code).toBe("syntax_error");
    expect(issue?.line).toBe(1);
  });
});

describe("analyzeExpression", () => {
  const script = analyzeScript("let gear = $state(4);\nconst sprockets = [28, 24];");

  it("accepts handlers that write state and reads of each-bindings", () => {
    expect(analyzeExpression("() => gear = gear + 1", script, [])).toEqual([]);
    expect(analyzeExpression("(v) => { gear = v; }", script, [])).toEqual([]);
    expect(analyzeExpression("part.name + i", script, ["part", "i"])).toEqual([]);
  });

  it("rejects writes to each-bindings, which hold the render's frozen copy", () => {
    const list = analyzeScript("let items = $state([{ done: false }]);");
    expect(
      analyzeExpression("() => item.done = !item.done", list, ["item", "i"]).map((x) => x.code),
    ).toEqual(["assigns_each_item"]);
    expect(analyzeExpression("() => i++", list, ["item", "i"]).map((x) => x.code)).toEqual([
      "assigns_each_item",
    ]);
    // Through the state itself, it is a real write; a handler's own parameter is its own.
    expect(analyzeExpression("() => items[i].done = true", list, ["item", "i"])).toEqual([]);
    expect(analyzeExpression("(item) => { item = 1; }", list, ["item"])).toEqual([]);
  });

  it("rejects writes to constants and trailing code", () => {
    expect(analyzeExpression("() => sprockets[0] = 1", script, []).map((i) => i.code)).toEqual([
      "assigns_non_state",
    ]);
    expect(analyzeExpression("1 + 1; alert(1)", script, []).map((i) => i.code)).toEqual([
      "syntax_error",
    ]);
  });
});
