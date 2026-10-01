import { expect, it } from "vitest";
import { parseKey } from "./keys.ts";

it("reads named keys, characters and modifier combos", () => {
  expect(parseKey("Enter")).toEqual({
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    text: "\r",
    modifiers: 0,
  });
  expect(parseKey("Esc")).toMatchObject({ key: "Escape", modifiers: 0 });
  expect(parseKey("Shift+Tab")).toMatchObject({ key: "Tab", modifiers: 8 });
  expect(parseKey("a")).toEqual({ key: "a", code: "KeyA", keyCode: 65, text: "a", modifiers: 0 });
  expect(parseKey("Shift+a")).toMatchObject({ key: "A", text: "A", modifiers: 8 });
  // A command modifier types nothing.
  expect(parseKey("Control+A")).toEqual({ key: "a", code: "KeyA", keyCode: 65, modifiers: 2 });
  expect(parseKey("Cmd+Enter")).toEqual({ key: "Enter", code: "Enter", keyCode: 13, modifiers: 4 });
});

it("refuses what it does not know rather than guessing", () => {
  expect(parseKey("Hyper+A")).toBeNull();
  expect(parseKey("F13")).toBeNull();
  expect(parseKey("")).toBeNull();
});
