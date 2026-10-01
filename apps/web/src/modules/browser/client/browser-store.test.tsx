import { afterEach, describe, expect, it } from "vitest";
import { browserTabs, type WebviewElement } from "./browser-store.ts";

// jsdom has no webview; placement only touches the element's style.
const element = () => document.createElement("webview") as WebviewElement;
const input = { owner: "c1", partition: "persist:browser-x", url: "https://a.test/" };

afterEach(() => {
  for (const id of browserTabs.all().keys()) browserTabs.remove(id);
});

describe("browserTabs", () => {
  it("opens live pages and restores stored ones as discarded, once", () => {
    const opened = browserTabs.open(input);
    expect(opened).toMatchObject({ live: true, url: "https://a.test/", owner: "c1" });
    browserTabs.restore("kept", { ...input, title: "Kept" });
    browserTabs.restore("kept", { ...input, url: "https://other.test/" });
    expect(browserTabs.get("kept")).toMatchObject({ live: false, title: "Kept", url: input.url });
  });

  it("notifies only for real changes", () => {
    const tab = browserTabs.open(input);
    let calls = 0;
    const unsubscribe = browserTabs.subscribe(() => calls++);
    browserTabs.update(tab.id, { title: "" });
    expect(calls).toBe(0);
    browserTabs.update(tab.id, { title: "Page" });
    expect(calls).toBe(1);
    unsubscribe();
  });

  it("places a page over its slot and keeps its size while hidden", () => {
    const tab = browserTabs.open(input);
    const webview = element();
    browserTabs.attach(tab.id, webview);
    browserTabs.place(tab.id, { left: 10, top: 20, width: 300, height: 400 });
    expect(webview.style).toMatchObject({
      left: "10px",
      top: "20px",
      width: "300px",
      height: "400px",
      visibility: "visible",
      pointerEvents: "auto",
    });
    expect(browserTabs.visible().has(tab.id)).toBe(true);
    browserTabs.place(tab.id, null);
    expect(webview.style).toMatchObject({ width: "300px", visibility: "hidden" });
    expect(browserTabs.visible().has(tab.id)).toBe(false);
  });

  it("applies a placement to an element attached later, as a discarded page reloads", () => {
    browserTabs.restore("later", input);
    browserTabs.place("later", { left: 1, top: 2, width: 3, height: 4 });
    const webview = element();
    browserTabs.attach("later", webview);
    expect(webview.style).toMatchObject({ left: "1px", visibility: "visible" });
  });

  it("counts holds per chat", () => {
    const first = browserTabs.hold("c1");
    const second = browserTabs.hold("c1");
    first();
    first();
    expect(browserTabs.held().has("c1")).toBe(true);
    second();
    expect(browserTabs.held().has("c1")).toBe(false);
  });
});
