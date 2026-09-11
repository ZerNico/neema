import { describe, expect, it } from "vitest";
import { compareSkillUpdate, resolveSkillUpdate } from "./update.ts";
const files = (values: Record<string, string>) =>
  Object.entries(values).map(([path, content]) => ({ path, content }));
describe("upstream file review", () => {
  it("takes upstream-only changes and keeps local-only edits", () => {
    const changes = compareSkillUpdate(
      files({ a: "old", b: "old" }),
      files({ a: "local", b: "old" }),
      files({ a: "old", b: "upstream" }),
    );
    expect(resolveSkillUpdate(changes)).toEqual(files({ a: "local", b: "upstream" }));
    expect(changes.every((change) => !change.conflict)).toBe(true);
  });
  it("preserves conflicting local text until explicitly selected", () => {
    const [change] = compareSkillUpdate(
      files({ a: "old" }),
      files({ a: "local" }),
      files({ a: "upstream" }),
    );
    expect(change).toMatchObject({ conflict: true, selected: "local" });
    expect(resolveSkillUpdate([{ ...change!, selected: "upstream" }])).toEqual(
      files({ a: "upstream" }),
    );
  });
  it("handles deletion against an upstream edit without silently restoring it", () => {
    const changes = compareSkillUpdate(files({ a: "old" }), [], files({ a: "new" }));
    expect(changes[0]).toMatchObject({ conflict: true, local: null, selected: "local" });
    expect(resolveSkillUpdate(changes)).toEqual([]);
  });
  it("does not resurrect a kept local file on the next update when the baseline advanced", () => {
    const changes = compareSkillUpdate(
      files({ a: "upstream-v2" }),
      files({ a: "local" }),
      files({ a: "upstream-v3" }),
    );
    expect(changes[0]).toMatchObject({ conflict: true, selected: "local" });
  });
  it("does not call identical edits a conflict and includes new files", () => {
    const changes = compareSkillUpdate(
      files({ a: "old" }),
      files({ a: "same" }),
      files({ a: "same", b: "added" }),
    );
    expect(changes.every((change) => !change.conflict)).toBe(true);
    expect(resolveSkillUpdate(changes)).toEqual(files({ a: "same", b: "added" }));
  });
});
