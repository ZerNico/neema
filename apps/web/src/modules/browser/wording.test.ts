import { expect, it } from "vitest";
import { elementPhrase, keyPhrase, scrollPhrase } from "./wording.ts";

it("names an element as a person would, from the outline's line", () => {
  expect(elementPhrase('link "Learn more"')).toBe("the “Learn more” link");
  expect(elementPhrase('textbox "Email": ana@example.com (focused)')).toBe("the “Email” field");
  expect(elementPhrase('heading 2 "Pricing"')).toBe("the “Pricing” heading");
  expect(elementPhrase("button")).toBe("a button");
  expect(elementPhrase("image")).toBe("an image");
  expect(elementPhrase(null)).toBeNull();
});

it("writes keys and scrolls in plain words", () => {
  expect(keyPhrase("Control+a")).toBe("Ctrl+A");
  expect(keyPhrase("Meta+Shift+ArrowDown")).toBe("Cmd+Shift+Down arrow");
  expect(scrollPhrase(0, 600, "600 of 978")).toBe("down");
  expect(scrollPhrase(0, 600, "978 of 978")).toBe("to the bottom");
  expect(scrollPhrase(0, -600, "0 of 978")).toBe("to the top");
  expect(scrollPhrase(-300, 0)).toBe("left");
});
