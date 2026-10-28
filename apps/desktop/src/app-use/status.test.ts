import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { chatKey } from "./chat-key.ts";
import { LiveView } from "./live.ts";
import { appUseStatus } from "./status.ts";

const SERVER = "https://chat.example";
const A = chatKey(SERVER, "a");
const B = chatKey(SERVER, "b");
const ELSEWHERE = chatKey("https://other.example", "c");

const call = (app: string) => ({ name: "app_click", args: { app }, app });

let live: LiveView;
beforeEach(() => {
  vi.useFakeTimers();
  live = new LiveView({
    driver: { holder: null, running: false, call: async () => ({ data: "", width: 1, height: 1 }) },
    locale: async () => "en",
  });
});
afterEach(() => {
  live.close();
  vi.useRealTimers();
});

const labels = () =>
  appUseStatus(live, SERVER).items.flatMap((item) => (item.label ? [item.label] : []));

describe("app use in the menu bar", () => {
  test("names the apps in use beside the icon, this server's only", () => {
    live.begin(A, call("Calculator"));
    live.begin(B, call("TextEdit"));
    live.begin(ELSEWHERE, call("Notes"));
    expect(appUseStatus(live, SERVER).title).toBe("Calculator, TextEdit");
    expect(labels()).toEqual(["Clicking in Calculator", "Pause", "Clicking in TextEdit", "Pause"]);
    expect(appUseStatus(live, null).items).toEqual([]);
  });

  test("pauses from the menu, and keeps a paused chat there to resume", async () => {
    live.begin(A, call("Calculator"));
    const pause = appUseStatus(live, SERVER).items.find((item) => item.label === "Pause");
    // Electron passes the item, window and event, which the menu's own click never reads.
    const click = pause?.click as (() => void) | undefined;
    click?.();
    expect(live.update(A)?.paused).toBe(true);
    live.finished(A);
    await vi.advanceTimersByTimeAsync(20_000);
    // The spell is over: nothing beside the icon, but Resume stays in reach.
    const status = appUseStatus(live, SERVER);
    expect(status.title).toBe("");
    expect(labels()).toEqual(["Paused", "Resume"]);
    expect(status.items[0]).toMatchObject({ sublabel: "Calculator", enabled: false });
  });

  test("leaves the menu once a chat is neither in use nor paused", async () => {
    live.begin(A, call("Calculator"));
    live.finished(A);
    const during = appUseStatus(live, SERVER).signature;
    await vi.advanceTimersByTimeAsync(20_000);
    const after = appUseStatus(live, SERVER);
    expect(after.items).toEqual([]);
    expect(after.signature).not.toBe(during);
  });

  test("keeps its signature while only the picture and ring change", async () => {
    const pictured = new LiveView({
      driver: { holder: A, running: true, call: async () => ({ data: "p", width: 1, height: 1 }) },
      locale: async () => "en",
    });
    pictured.begin(A, call("Calculator"));
    const before = appUseStatus(pictured, SERVER).signature;
    await vi.advanceTimersByTimeAsync(0);
    expect(pictured.update(A)?.frame?.data).toBe("p");
    pictured.clicked(A, { x: 0.2, y: 0.3 });
    expect(appUseStatus(pictured, SERVER).signature).toBe(before);
    pictured.close();
  });

  test("changes its signature with the server, whose chats its clicks name", () => {
    expect(appUseStatus(live, SERVER).signature).not.toBe(
      appUseStatus(live, "https://other.example").signature,
    );
  });
});
