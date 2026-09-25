import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { describe, expect, it } from "vitest";
import { tagMarkup } from "../tags.ts";
import { ChatTextarea, type ComposerFieldHandle } from "./chat-textarea.tsx";
import {
  composerText,
  focusComposer,
  setComposerCaret,
  setComposerText,
  typeInComposer,
} from "./composer-test-utils.ts";
import { useTagSync } from "./use-tag-sync.ts";

const SKILLS = [
  { id: "review", label: "review" },
  { id: "rewrite", label: "rewrite" },
];
const REVIEW = tagMarkup({ kind: "skill", id: "review", name: "review" });

let selected: string[] = [];
let setSelectedOutside: (ids: string[]) => void = () => undefined;

/** The composer's shape in small: a field, a skill selection, the sync between them. */
function Harness({ initial, initialSelected }: { initial: string; initialSelected: string[] }) {
  const [value, setValue] = useState(initial);
  const [ids, setIds] = useState(initialSelected);
  // Captured after commit, as the other harnesses do: assigning while rendering is a side effect.
  useEffect(() => {
    selected = ids;
    setSelectedOutside = setIds;
  }, [ids]);
  const field = useRef<ComposerFieldHandle>(null);
  useTagSync(value, field, [
    {
      kind: "skill",
      selected: ids,
      nameOf: (id) => SKILLS.find((skill) => skill.id === id)?.label,
      canSelect: (id) => SKILLS.some((skill) => skill.id === id),
      select: (add) => setIds((current) => [...new Set([...current, ...add])]),
      deselect: (drop) => setIds((current) => current.filter((id) => !drop.includes(id))),
    },
  ]);
  return (
    <ChatTextarea
      ref={field}
      value={value}
      onValueChange={setValue}
      onSubmit={() => undefined}
      ariaLabel="Message"
      skills={{
        items: SKILLS,
        onSelect: (id) => setIds((current) => [...new Set([...current, id])]),
      }}
    />
  );
}

const field = () => screen.getByRole("textbox", { name: "Message" });

describe("tags and selection in step", () => {
  it("picks a skill as a tag, and deleting the tag deselects it", async () => {
    render(<Harness initial="" initialSelected={[]} />);
    focusComposer(field());
    typeInComposer(field(), "use /rev");
    await screen.findByRole("listbox", { name: "Local skills" });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(composerText(field())).toBe(`use ${REVIEW} `);
    expect(selected).toEqual(["review"]);

    // Right after the tag (jsdom performs no default deletion, only the tag's own key).
    setComposerCaret(field(), "use ".length + 1);
    fireEvent.keyDown(field(), { key: "Backspace" });
    expect(composerText(field())).toBe("use  ");
    expect(selected).toEqual([]);
  });

  it("keeps the skill while another tag for it is still in the text", () => {
    render(<Harness initial={`${REVIEW} and ${REVIEW}`} initialSelected={["review"]} />);
    setComposerCaret(field(), 1);
    fireEvent.keyDown(field(), { key: "Backspace" });
    expect(selected).toEqual(["review"]);
  });

  it("puts a skill selected elsewhere at the caret, and takes it out when deselected", () => {
    render(<Harness initial="summarise this" initialSelected={[]} />);
    setComposerCaret(field(), "summarise".length);
    act(() => setSelectedOutside(["rewrite"]));
    const rewrite = tagMarkup({ kind: "skill", id: "rewrite", name: "rewrite" });
    expect(composerText(field())).toBe(`summarise ${rewrite}  this`);

    act(() => setSelectedOutside([]));
    // The space the tag brought goes with it.
    expect(composerText(field())).toBe("summarise  this");
  });

  it("gives an older message's skill its tag, and a pasted tag its skill", () => {
    render(<Harness initial="notes" initialSelected={["review"]} />);
    expect(composerText(field())).toBe(`${REVIEW} notes`);

    setComposerText(
      field(),
      `${REVIEW} notes ${tagMarkup({ kind: "skill", id: "rewrite", name: "rewrite" })}`,
    );
    expect(selected).toEqual(["review", "rewrite"]);
  });

  it("leaves a tag for a skill this person cannot use as words only", () => {
    render(<Harness initial="" initialSelected={[]} />);
    setComposerText(field(), tagMarkup({ kind: "skill", id: "someone-elses", name: "private" }));
    expect(selected).toEqual([]);
  });
});
