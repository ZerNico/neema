import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PANEL_SCOPE_LIMIT, readPanelScope, writePanelScope } from "./detail-panel-tabs.ts";

const scope = (title: string) => ({
  tabs: [{ id: `doc:${title}`, title }],
  activeId: null,
  visible: true,
});

// The unit project runs in Node, which has no Web Storage of its own.
const memoryStorage = (): Storage => {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    key: (index) => [...items.keys()][index] ?? null,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, String(value)),
    removeItem: (key) => void items.delete(key),
    clear: () => items.clear(),
  };
};

beforeEach(() => vi.stubGlobal("localStorage", memoryStorage()));
afterEach(() => vi.unstubAllGlobals());

it("keeps each account's pages apart and forgets a page written as null", () => {
  writePanelScope("u1", "/chat/a", scope("A"));
  expect(readPanelScope("u1", "/chat/a")).toEqual(scope("A"));
  expect(readPanelScope("u2", "/chat/a")).toBeNull();
  writePanelScope("u1", "/chat/a", null);
  expect(readPanelScope("u1", "/chat/a")).toBeNull();
  expect(localStorage.length).toBe(0);
});

it("forgets the least recently written pages beyond the limit", () => {
  for (let index = 0; index <= PANEL_SCOPE_LIMIT; index++)
    writePanelScope("u1", `/chat/${index}`, scope(String(index)));
  expect(readPanelScope("u1", "/chat/0")).toBeNull();
  expect(readPanelScope("u1", "/chat/1")).toEqual(scope("1"));
  // Writing a page again makes it the most recent, so it outlives older ones.
  writePanelScope("u1", "/chat/1", scope("1"));
  writePanelScope("u1", "/chat/extra", scope("extra"));
  expect(readPanelScope("u1", "/chat/1")).toEqual(scope("1"));
  expect(readPanelScope("u1", "/chat/2")).toBeNull();
});

it("ignores storage it cannot read instead of failing the page", () => {
  localStorage.setItem("chat.panel-tabs.u1", "{not json");
  expect(readPanelScope("u1", "/chat/a")).toBeNull();
  localStorage.setItem(
    "chat.panel-tabs.u1",
    JSON.stringify([
      ["/chat/a", { tabs: [{ id: 1 }], activeId: null, visible: true }],
      ["/chat/b", scope("B")],
    ]),
  );
  expect(readPanelScope("u1", "/chat/a")).toBeNull();
  expect(readPanelScope("u1", "/chat/b")).toEqual(scope("B"));
});
