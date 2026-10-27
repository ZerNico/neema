import { describe, expect, test } from "vitest";
import { floats, parseChatKey } from "./view-state.ts";

describe("the floating window", () => {
  const chat = {
    placement: "panel" as const,
    dismissed: false,
    live: true,
    hasFrame: true,
    mainVisible: true,
  };

  test("stays in the chat's panel while neema's window is in sight", () => {
    expect(floats(chat)).toBe(false);
  });

  test("comes up by itself while the chat acts and neema's window is out of sight", () => {
    expect(floats({ ...chat, mainVisible: false })).toBe(true);
    // Once the chat is done, out of sight is out of mind.
    expect(floats({ ...chat, mainVisible: false, live: false })).toBe(false);
  });

  test("shows where the person put it, until they close it, and never empty", () => {
    expect(floats({ ...chat, placement: "floating", live: false })).toBe(true);
    expect(floats({ ...chat, placement: "floating", dismissed: true })).toBe(false);
    expect(floats({ ...chat, placement: "floating", hasFrame: false })).toBe(false);
  });
});

test("a chat key names its server and conversation", () => {
  expect(parseChatKey("https://chat.example\u0000c1")).toEqual({
    scope: "https://chat.example",
    conversationId: "c1",
  });
  expect(parseChatKey("no separator")).toBeNull();
});
