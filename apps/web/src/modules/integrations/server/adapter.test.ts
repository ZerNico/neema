import { describe, expect, it } from "vitest";
import type { SourceRoot, SourceRule } from "../schema.ts";
import { isSelected } from "./adapter.ts";

const rule = (nodeId: string, mode: SourceRule["mode"]): SourceRule => ({
  nodeId,
  title: nodeId,
  mode,
});
const root = (nodeId: string, mode: SourceRoot["mode"], rules: SourceRule[] = []): SourceRoot => ({
  nodeId,
  title: nodeId,
  mode,
  rules,
});
const doc = (externalId: string, ancestors: string[]) => ({ externalId, ancestors });

describe("source selection", () => {
  it("mirrors nothing outside a root", () => {
    expect(isSelected(doc("d1", ["c2"]), [root("c1", "all")])).toBe(false);
  });

  it("takes everything under an `all` root, pages added later too, minus exclusions", () => {
    const roots = [root("c1", "all", [rule("d1", "exclude")])];
    expect(isSelected(doc("d9", ["c1", "d3", "d4"]), roots)).toBe(true);
    // The excluded page takes its subtree with it.
    expect(isSelected(doc("d1", ["c1"]), roots)).toBe(false);
    expect(isSelected(doc("d2", ["c1", "d1"]), roots)).toBe(false);
  });

  it("takes only what is included under a `selected` root, with exclusions inside", () => {
    const roots = [root("c1", "selected", [rule("d1", "include"), rule("d2", "exclude")])];
    expect(isSelected(doc("d3", ["c1"]), roots)).toBe(false);
    expect(isSelected(doc("d1", ["c1"]), roots)).toBe(true);
    // A page added under an included one comes along.
    expect(isSelected(doc("d7", ["c1", "d1"]), roots)).toBe(true);
    expect(isSelected(doc("d2", ["c1", "d1"]), roots)).toBe(false);
    expect(isSelected(doc("d8", ["c1", "d1", "d2"]), roots)).toBe(false);
  });

  it("keeps each root's rules to itself", () => {
    const roots = [root("c1", "selected", [rule("d1", "include")]), root("c2", "all")];
    expect(isSelected(doc("d5", ["c2"]), roots)).toBe(true);
    expect(isSelected(doc("d6", ["c1"]), roots)).toBe(false);
  });
});
