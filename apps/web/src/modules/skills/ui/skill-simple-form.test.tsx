import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { NEW_SKILL_FILES, type SkillFile } from "../package.ts";
import { SkillSimpleForm, canEditSimply } from "./skill-simple-form.tsx";

const root = (files: SkillFile[]) => files.find((file) => file.path === "SKILL.md")!.content;

function Harness({ initial, spy }: { initial: SkillFile[]; spy: (files: SkillFile[]) => void }) {
  const [files, setFiles] = useState(initial);
  return (
    <SkillSimpleForm
      files={files}
      findings={[]}
      onChange={(next) => {
        spy(next);
        setFiles(next);
      }}
    />
  );
}

describe("SkillSimpleForm", () => {
  it("edits SKILL.md through plain fields, keeping other files", () => {
    const spy = vi.fn();
    const extra = { path: "notes.md", content: "extra" };
    render(<Harness initial={[...NEW_SKILL_FILES, extra]} spy={spy} />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Contract Review" } });
    expect(screen.getByLabelText("Name")).toHaveValue("contract-review");
    fireEvent.change(screen.getByLabelText("When to use it"), {
      target: { value: "When someone sends a contract." },
    });
    fireEvent.click(screen.getByRole("switch", { name: "Use it automatically" }));
    fireEvent.change(screen.getByLabelText("Instructions"), {
      target: { value: "Check clauses.\n" },
    });

    const files = spy.mock.lastCall![0] as SkillFile[];
    expect(root(files)).toBe(
      "---\nname: contract-review\ndescription: When someone sends a contract.\ndisable-model-invocation: true\n---\n\nCheck clauses.\n",
    );
    expect(files).toContainEqual(extra);
    expect(screen.getByText(/also has 1 other file/)).toBeVisible();
  });

  it("is only offered for a SKILL.md it can read", () => {
    expect(canEditSimply(NEW_SKILL_FILES)).toBe(true);
    expect(canEditSimply([{ path: "SKILL.md", content: "# no frontmatter" }])).toBe(false);
    expect(canEditSimply([{ path: "notes.md", content: "x" }])).toBe(false);
  });
});
