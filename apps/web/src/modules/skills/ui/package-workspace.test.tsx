import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PackageWorkspace, SkillPreview } from "./package-workspace.tsx";
import type { SkillFile } from "../package.ts";
vi.mock("~/ui/confirm.tsx", () => ({ useConfirm: () => async () => true }));
vi.mock("./text-editor.tsx", () => ({
  default: function MockTextEditor({
    value,
    onChange,
    label,
    path,
    focusRequest,
  }: {
    value: string;
    onChange: (value: string) => void;
    label: string;
    path: string;
    focusRequest?: { line: number };
  }) {
    const [original] = useState(value);
    return (
      <div>
        <textarea
          aria-label={label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          data-focus-line={focusRequest?.line}
          data-path={path}
        />
        <button onClick={() => onChange(original)}>Undo fixture edit</button>
      </div>
    );
  },
}));
const initial = [
  { path: "SKILL.md", content: "Root" },
  { path: "references/example.md", content: "Original" },
];
function Harness() {
  const [files, setFiles] = useState<SkillFile[]>(initial);
  return (
    <PackageWorkspace
      files={files}
      onChange={setFiles}
      findings={[
        { path: "references/example.md", line: 3, severity: "warning", message: "Check this line" },
      ]}
    />
  );
}
describe("package workspace", () => {
  it("keeps editor identity and local history while switching and renaming files", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "example.md" }));
    const editor = await screen.findByRole("textbox", { name: "Edit references/example.md" });
    fireEvent.change(editor, { target: { value: "Changed" } });
    fireEvent.click(screen.getByRole("button", { name: "SKILL.md" }));
    fireEvent.click(screen.getByRole("button", { name: "example.md" }));
    expect(screen.getByRole("textbox", { name: "Edit references/example.md" })).toBe(editor);
    fireEvent.click(screen.getByRole("button", { name: "Rename references/example.md" }));
    const field = screen.getByRole("textbox", { name: "New name" });
    fireEvent.change(field, { target: { value: "renamed.md" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Edit references/renamed.md" })).toBe(editor),
    );
    expect(editor).toHaveValue("Changed");
    fireEvent.click(screen.getByRole("button", { name: "Undo fixture edit" }));
    expect(editor).toHaveValue("Original");
  });
  it("protects the root and links a validation finding to its exact line", async () => {
    render(<Harness />);
    expect(screen.queryByRole("button", { name: /^Delete / })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "references/example.md:3" }));
    expect(
      await screen.findByRole("textbox", { name: "Edit references/example.md" }),
    ).toHaveAttribute("data-focus-line", "3");
  });
  it("names new files inline in the tree, like a file explorer", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "references" }));
    fireEvent.click(screen.getByRole("button", { name: "New file" }));
    const field = screen.getByRole("textbox", { name: "New file name" });
    fireEvent.change(field, { target: { value: "example.md" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent("already uses this name");
    fireEvent.change(field, { target: { value: "added.md" } });
    fireEvent.keyDown(field, { key: "Enter" });
    // Created inside the selected folder, with the editor focused on it.
    expect(await screen.findByRole("textbox", { name: "Edit references/added.md" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "New file" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "New file name" }), {
      key: "Escape",
    });
    expect(screen.queryByRole("textbox", { name: "New file name" })).toBeNull();
  });
  it("wraps an invalid unbroken path inside the file rail", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "New file" }));
    const field = screen.getByRole("textbox", { name: "New file name" });
    fireEvent.change(field, { target: { value: "x".repeat(240) + ".txt" } });
    fireEvent.keyDown(field, { key: "Enter" });
    const error = await screen.findByRole("alert");
    expect(error).toHaveClass("wrap-anywhere");
    expect(error.parentElement).toHaveClass("max-w-full");
  });

  it("renames a folder in place, keeping its contents and its folder icon", async () => {
    const { container } = render(<Harness />);
    fireEvent.doubleClick(screen.getByRole("button", { name: "references" }));
    const field = screen.getByRole("textbox", { name: "New name" });
    // The row is replaced, not the subtree: what is inside stays on screen.
    expect(screen.getByRole("button", { name: "example.md" })).toBeVisible();
    expect(container.querySelector('[data-entry="folder"]')).toContainElement(field);
    fireEvent.change(field, { target: { value: "guides" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(await screen.findByRole("button", { name: "guides" })).toBeVisible();
    expect(screen.getByRole("button", { name: "example.md" })).toBeVisible();
  });
  it("keeps a new folder from being a dead end", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    const named = screen.getByRole("textbox", { name: "New folder name" });
    fireEvent.change(named, { target: { value: "guides" } });
    fireEvent.keyDown(named, { key: "Enter" });
    // A folder cannot be saved on its own, so naming its first file follows.
    const next = await screen.findByRole("textbox", { name: "New file name" });
    fireEvent.change(next, { target: { value: "notes.md" } });
    fireEvent.keyDown(next, { key: "Enter" });
    expect(await screen.findByRole("textbox", { name: "Edit guides/notes.md" })).toBeVisible();
  });
  it("keeps code files in the package and edits them by their own path", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "New file" }));
    const named = screen.getByRole("textbox", { name: "New file name" });
    fireEvent.change(named, { target: { value: "scripts/convert.py" } });
    fireEvent.keyDown(named, { key: "Enter" });
    // The grammar follows the file name, so a script is not treated as Markdown.
    const editor = await screen.findByRole("textbox", { name: "Edit scripts/convert.py" });
    expect(editor).toHaveAttribute("data-path", "scripts/convert.py");
    fireEvent.change(editor, { target: { value: "print('kept as text')" } });
    expect(editor).toHaveValue("print('kept as text')");
  });
  it("indents nested files once, so a deep path keeps room for its name", () => {
    render(<Harness />);
    // Nesting containers carry the indentation; rows must not add their own on
    // top of it, or a deep tree spends the rail twice as fast.
    for (const name of ["references", "example.md", "SKILL.md"])
      expect(screen.getByRole("button", { name }).getAttribute("style")).toBeNull();
  });
  it("makes reviews read-only by default and never loads remote images or raw HTML", async () => {
    render(<PackageWorkspace files={initial} />);
    expect(screen.queryByRole("button", { name: "New file" })).toBeNull();
    const { container } = render(
      <SkillPreview
        content={"![tracker](https://example.invalid/tracker.png)\n<script>alert(1)</script>"}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(await screen.findByText(/Image: tracker/)).toBeInTheDocument();
  });
});
