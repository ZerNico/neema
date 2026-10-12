import { EventEmitter } from "node:events";
import type { BrowserWindow, WebContents, Session } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_FAVICON, BROWSER_OPEN_TAB } from "@chat/desktop-rpc";

const electron = vi.hoisted(() => ({
  guests: new Map<number, WebContents>(),
  profile: null as Session | null,
}));
vi.mock("electron", () => ({
  clipboard: {},
  Menu: {},
  nativeImage: {},
  shell: {},
  session: { fromPartition: () => electron.profile },
  webContents: { fromId: (id: number) => electron.guests.get(id) },
}));
vi.mock("./fetch.ts", () => ({
  fetchManual: (profile: Session, url: string, signal: AbortSignal) =>
    profile.fetch(url, { signal, redirect: "manual" }),
}));
import { attachBrowserGuests } from "./guests.ts";

const cleanups: Array<() => void> = [];
const fixture = () => {
  const host = Object.assign(new EventEmitter(), { send: vi.fn(), isDestroyed: () => false });
  const window = Object.assign(new EventEmitter(), { webContents: host });
  const profile = Object.assign(new EventEmitter(), {
    fetch: vi.fn(
      async (_url: string, _options?: RequestInit) => new Response(new Uint8Array([1, 2, 3])),
    ),
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
  });
  // Only the Electron boundary is faked. The adapter and its event handlers are real.
  const sessionBoundary: unknown = profile;
  electron.profile = sessionBoundary as Session;
  const guest = Object.assign(new EventEmitter(), {
    id: 7,
    hostWebContents: host,
    session: profile,
    isDestroyed: () => false,
    getURL: () => "https://a.test/",
    getTitle: () => "A",
    setWindowOpenHandler: vi.fn(),
    executeJavaScriptInIsolatedWorld: vi.fn(async () => true as unknown),
    capturePage: vi.fn(async () => ({ isEmpty: (): boolean => true })),
    loadURL: vi.fn(async () => {}),
    reload: vi.fn(),
    navigationHistory: { goBack: vi.fn(), goForward: vi.fn() },
    debugger: {
      isAttached: () => true,
      attach: vi.fn(),
      sendCommand: vi.fn(
        async (_method: string, _params?: Record<string, unknown>): Promise<unknown> => ({
          nodes: [],
        }),
      ),
    },
  });
  const guestBoundary: unknown = guest;
  electron.guests.set(7, guestBoundary as WebContents);
  const land = vi.fn(
    async (_conversationId: string, _name: string, _bytes: Uint8Array, _signal?: AbortSignal) =>
      "/work/x",
  );
  const windowBoundary: unknown = window;
  const adapter = attachBrowserGuests(
    windowBoundary as BrowserWindow,
    "0123456789abcdef",
    () => true,
    () => false,
    land,
  );
  host.emit(
    "will-attach-webview",
    { preventDefault: vi.fn() },
    {},
    { partition: "persist:browser-0123456789abcdef", src: "about:blank" },
  );
  host.emit("did-attach-webview", {}, guest);
  cleanups.push(() => {
    window.emit("closed");
    electron.guests.clear();
  });
  const begin = async (callId = "call", allow = ["https://a.test/"], budget = 60_000) => {
    adapter.begin(callId, "c1", Date.now() + budget);
    await adapter.drive(7, { conversationId: "c1", allow }, callId);
  };
  const popup = (url: string) => guest.setWindowOpenHandler.mock.calls[0]![0]({ url });
  return { adapter, host, guest, profile, land, begin, popup };
};

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

describe("main browser authority", () => {
  it("cancellation prevents a late empty screenshot from dispatching another capture", async () => {
    vi.useFakeTimers();
    const { begin, adapter, guest } = fixture();
    const started = Promise.withResolvers<void>();
    const image = Promise.withResolvers<{ isEmpty: () => boolean }>();
    guest.capturePage.mockImplementationOnce(() => {
      started.resolve();
      return image.promise;
    });
    await begin();
    const pending = adapter.snapshot(7, { screenshot: true }, "call");
    const rejected = expect(pending).rejects.toThrow();
    await started.promise;
    adapter.cancel("call");
    await rejected;
    image.resolve({ isEmpty: () => true });
    await vi.advanceTimersByTimeAsync(500);
    expect(guest.capturePage).toHaveBeenCalledOnce();
    expect(guest.debugger.sendCommand.mock.calls.map(([method]) => method)).toEqual([
      "Accessibility.getFullAXTree",
    ]);
  });

  it("blocks model popups before replacement forwarding, but preserves approved and human popups", async () => {
    const { begin, popup, adapter, host } = fixture();
    await begin();
    expect(popup("https://b.test/popup")).toEqual({ action: "deny" });
    expect(host.send).not.toHaveBeenCalled();
    popup("https://a.test/popup");
    expect(host.send).toHaveBeenCalledExactlyOnceWith(BROWSER_OPEN_TAB, {
      webContentsId: 7,
      url: "https://a.test/popup",
    });
    expect(await adapter.drive(7, null, "call")).toMatchObject({ blocked: "https://b.test/popup" });
    popup("https://b.test/human");
    expect(host.send).toHaveBeenLastCalledWith(BROWSER_OPEN_TAB, {
      webContentsId: 7,
      url: "https://b.test/human",
    });
  });

  it("uses manual redirects and gates the next save hop before fetching it", async () => {
    const { begin, adapter, profile, land } = fixture();
    await begin();
    profile.fetch.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "https://b.test/x" } }),
    );
    expect(await adapter.save(7, ["https://a.test/x"], "call")).toMatchObject([
      { blocked: true, blockedUrl: "https://b.test/x" },
    ]);
    expect(profile.fetch).toHaveBeenCalledOnce();
    expect(profile.fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
    expect(land).not.toHaveBeenCalled();
  });

  it("drive release aborts a stalled save and prevents late landing before a next call", async () => {
    const { begin, adapter, profile, land } = fixture();
    await begin();
    const response = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<AbortSignal>();
    profile.fetch.mockImplementationOnce((_url, options) => {
      started.resolve(options!.signal!);
      return response.promise;
    });
    const pending = adapter.save(7, ["https://a.test/x"], "call");
    const signal = await started.promise;
    await adapter.drive(7, null, "call");
    expect(signal.aborted).toBe(true);
    response.resolve(new Response(new Uint8Array([1, 2, 3])));
    expect(await pending).toMatchObject([{ error: "The browser call ended." }]);
    expect(land).not.toHaveBeenCalled();
    await begin("next");
    expect(await adapter.save(7, ["https://a.test/next"], "next")).toMatchObject([
      { path: "/work/x" },
    ]);
    expect(land).toHaveBeenCalledOnce();
  });

  it("cancellation before start and expiry reject late navigation and action IPC", async () => {
    vi.useFakeTimers();
    const { begin, adapter, guest } = fixture();
    adapter.cancel("before");
    expect(() => adapter.begin("before", "c1", Date.now() + 1000)).toThrow("ended");
    await begin("short", ["https://a.test/"], 10);
    await vi.advanceTimersByTimeAsync(10);
    await expect(adapter.navigate(7, { url: "https://a.test/x" }, "short")).rejects.toThrow("live");
    expect(() =>
      adapter.act(7, { kind: "press", callId: "action", key: "Enter" }, "short"),
    ).toThrow("live");
    expect(guest.loadURL).not.toHaveBeenCalled();
    expect(guest.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
  });

  it("cancels between resolving a node and dispatching its mutation", async () => {
    const { begin, adapter, guest } = fixture();
    await begin();
    guest.debugger.sendCommand.mockResolvedValueOnce({
      nodes: [
        { nodeId: "1", role: { value: "combobox" }, name: { value: "Size" }, backendDOMNodeId: 42 },
      ],
    });
    expect((await adapter.snapshot(7, { screenshot: false }, "call")).text).toContain("[e1]");
    const node = Promise.withResolvers<unknown>();
    const started = Promise.withResolvers<void>();
    guest.debugger.sendCommand.mockImplementationOnce(() => {
      started.resolve();
      return node.promise;
    });
    const pending = adapter.act(
      7,
      { kind: "select", callId: "action", ref: "e1", value: "x" },
      "call",
    );
    await started.promise;
    adapter.cancel("call");
    node.resolve({ object: { objectId: "resolved" } });
    await pending;
    expect(guest.debugger.sendCommand.mock.calls.map(([method]) => method)).toEqual([
      "Accessibility.getFullAXTree",
      "DOM.resolveNode",
    ]);
  });

  it("replays an action through fresh authority without dispatching it twice", async () => {
    const { adapter, begin, guest } = fixture();
    const action = { kind: "evaluate", callId: "stable-action", expression: "1" } as const;
    await begin("first");
    expect(await adapter.act(7, action, "first")).toMatchObject({ ok: true });
    await adapter.drive(7, null, "first");
    adapter.end("first");
    expect(() => adapter.act(7, action, "first")).toThrow("live");
    await begin("replay");
    expect(await adapter.act(7, action, "replay")).toMatchObject({ ok: true });
    expect(guest.executeJavaScriptInIsolatedWorld).toHaveBeenCalledOnce();
  });

  it("bounds each unresolved wait probe and leaves the next call usable", async () => {
    vi.useFakeTimers();
    const { adapter, guest } = fixture();
    adapter.begin("wait", "c1", Date.now() + 60_000);
    const probe = Promise.withResolvers<unknown>();
    const started = Promise.withResolvers<void>();
    guest.executeJavaScriptInIsolatedWorld.mockImplementationOnce(() => {
      started.resolve();
      return probe.promise;
    });
    const pending = adapter.waitFor(7, { text: "ready", timeoutMs: 10 }, "wait");
    await started.promise;
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toEqual({ met: false, url: "https://a.test/" });
    adapter.begin("next", "c1", Date.now() + 60_000);
    expect(await adapter.waitFor(7, { text: "ready", timeoutMs: 10 }, "next")).toEqual({
      met: true,
      url: "https://a.test/",
    });
    expect(guest.debugger.sendCommand).not.toHaveBeenCalledWith("Runtime.terminateExecution");
  });

  it.each(["destroyed", "host-navigation"])("ends save authority at %s", async (ending) => {
    const { begin, adapter, guest, host, profile, land } = fixture();
    await begin();
    const started = Promise.withResolvers<void>();
    profile.fetch.mockImplementationOnce(() => {
      started.resolve();
      return new Promise(() => {});
    });
    const pending = adapter.save(7, ["https://a.test/x"], "call");
    await started.promise;
    if (ending === "destroyed") guest.emit("destroyed");
    else host.emit("did-start-navigation", {}, "https://server.test/", false, true);
    expect(await pending).toMatchObject([{ error: "The browser call ended." }]);
    expect(land).not.toHaveBeenCalled();
  });

  it("superseding an icon cancels its body, and oversized icons never reach the host", async () => {
    const { guest, profile, host } = fixture();
    const cancel = vi.fn();
    const started = Promise.withResolvers<void>();
    profile.fetch.mockResolvedValueOnce(
      new Response(
        new ReadableStream(
          {
            pull() {
              started.resolve();
            },
            cancel,
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-type": "image/png" } },
      ),
    );
    guest.emit("page-favicon-updated", {}, ["https://a.test/first"]);
    await started.promise;
    guest.emit("page-favicon-updated", {}, ["data:image/png;base64,AQID"]);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
    expect(host.send).toHaveBeenCalledExactlyOnceWith(BROWSER_FAVICON, {
      webContentsId: 7,
      dataUrl: "data:image/png;base64,AQID",
    });
    const overflow = vi.fn();
    profile.fetch.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          pull(c) {
            c.enqueue(new Uint8Array(32 * 1024));
          },
          cancel: overflow,
        }),
        { headers: { "content-type": "image/png" } },
      ),
    );
    guest.emit("page-favicon-updated", {}, ["https://a.test/large"]);
    await vi.waitFor(() => expect(overflow).toHaveBeenCalled());
    expect(host.send).toHaveBeenCalledOnce();
  });

  it.each(["release", "cancel-release", "end-release", "expiry-release"])(
    "keeps a pending model favicon bound to its original lifetime across %s",
    async (ending) => {
      vi.useFakeTimers();
      const { begin, adapter, guest, profile, host } = fixture();
      await begin("icon", ["https://a.test/"], 10);
      const redirect = Promise.withResolvers<Response>();
      const cancelled = vi.fn();
      profile.fetch.mockImplementationOnce(() => redirect.promise);
      guest.emit("page-favicon-updated", {}, ["https://a.test/icon"]);
      const signal = profile.fetch.mock.calls[0]![1]!.signal!;
      if (ending === "cancel-release") adapter.cancel("icon");
      else if (ending === "end-release") adapter.end("icon");
      else if (ending === "expiry-release") await vi.advanceTimersByTimeAsync(10);
      await adapter.drive(7, null, "icon");
      redirect.resolve(
        new Response(new ReadableStream({ cancel: cancelled }), {
          status: 302,
          headers: { location: "https://b.test/icon" },
        }),
      );
      expect(signal.aborted).toBe(true);
      await vi.waitFor(() => expect(cancelled).toHaveBeenCalled());
      expect(profile.fetch).toHaveBeenCalledOnce();
      expect(host.send).not.toHaveBeenCalled();
    },
  );

  it("checks the original favicon deadline before a redirect even before the expiry timer runs", async () => {
    vi.useFakeTimers();
    const { begin, adapter, guest, profile, host } = fixture();
    await begin("icon", ["https://a.test/"], 10);
    const redirect = Promise.withResolvers<Response>();
    profile.fetch.mockImplementationOnce(() => redirect.promise);
    guest.emit("page-favicon-updated", {}, ["https://a.test/icon"]);
    const signal = profile.fetch.mock.calls[0]![1]!.signal!;
    const expired = Promise.withResolvers<void>();
    signal.addEventListener("abort", () => expired.resolve(), { once: true });
    vi.setSystemTime(Date.now() + 10);
    redirect.resolve(
      new Response(null, { status: 302, headers: { location: "https://b.test/icon" } }),
    );
    await expired.promise;
    expect(profile.fetch).toHaveBeenCalledOnce();
    expect(host.send).not.toHaveBeenCalled();
    await adapter.drive(7, null, "icon");
  });

  it("does not start a new favicon request from a cancelled retained drive", async () => {
    const { begin, adapter, guest, profile, host } = fixture();
    await begin();
    adapter.cancel("call");
    guest.emit("page-favicon-updated", {}, ["https://a.test/icon"]);
    expect(profile.fetch).not.toHaveBeenCalled();
    expect(host.send).not.toHaveBeenCalled();
  });

  it("preserves the authority of a genuinely human-origin favicon across a later drive", async () => {
    const { begin, adapter, guest, profile, host } = fixture();
    const redirect = Promise.withResolvers<Response>();
    profile.fetch.mockImplementationOnce(() => redirect.promise);
    profile.fetch.mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png" },
      }),
    );
    guest.emit("page-favicon-updated", {}, ["https://a.test/human-icon"]);
    await begin();
    adapter.cancel("call");
    redirect.resolve(
      new Response(null, { status: 302, headers: { location: "https://b.test/icon" } }),
    );
    await vi.waitFor(() =>
      expect(host.send).toHaveBeenCalledWith(BROWSER_FAVICON, {
        webContentsId: 7,
        dataUrl: "data:image/png;base64,AQID",
      }),
    );
    expect(profile.fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://a.test/human-icon",
      "https://b.test/icon",
    ]);
  });

  it.each(["cancel", "end", "expiry-timer", "expiry-check"])(
    "rejects a download arriving after %s while retaining the navigation gate",
    async (ending) => {
      vi.useFakeTimers();
      const { begin, adapter, profile, guest, land } = fixture();
      await begin("late", ["https://a.test/"], 10);
      if (ending === "cancel") adapter.cancel("late");
      else if (ending === "end") adapter.end("late");
      else if (ending === "expiry-timer") await vi.advanceTimersByTimeAsync(10);
      else vi.setSystemTime(Date.now() + 10);
      const item = Object.assign(new EventEmitter(), {
        cancel: vi.fn(),
        setSavePath: vi.fn(),
        getFilename: () => "late.bin",
        getTotalBytes: () => 3,
        getReceivedBytes: () => 3,
      });
      profile.emit("will-download", {}, item, guest);
      expect(item.cancel).toHaveBeenCalledOnce();
      expect(item.setSavePath).not.toHaveBeenCalled();
      expect(land).not.toHaveBeenCalled();
      const event = { preventDefault: vi.fn() };
      guest.emit("will-navigate", event, "https://b.test/");
      expect(event.preventDefault).toHaveBeenCalledOnce();
      await adapter.drive(7, null, "late");
      const human = Object.assign(new EventEmitter(), { cancel: vi.fn(), setSavePath: vi.fn() });
      profile.emit("will-download", {}, human, guest);
      expect(human.cancel).not.toHaveBeenCalled();
      expect(human.setSavePath).not.toHaveBeenCalled();
    },
  );

  it("admits a delayed download during normal bounded linger after successful release and end", async () => {
    const { begin, adapter, profile, guest } = fixture();
    await begin();
    await adapter.drive(7, null, "call");
    adapter.end("call");
    const item = Object.assign(new EventEmitter(), {
      cancel: vi.fn(),
      setSavePath: vi.fn(),
      getFilename: () => "late.bin",
      getTotalBytes: () => 3,
      getReceivedBytes: () => 3,
    });
    profile.emit("will-download", {}, item, guest);
    expect(item.setSavePath).toHaveBeenCalledOnce();
    expect(item.cancel).not.toHaveBeenCalled();
    adapter.cancel("call");
    expect(item.cancel).toHaveBeenCalledOnce();
  });

  it("main expiry cancels native downloads without renderer cooperation", async () => {
    vi.useFakeTimers();
    const { begin, adapter, profile, guest } = fixture();
    await begin("short", ["https://a.test/"], 10);
    const item = Object.assign(new EventEmitter(), {
      cancel: vi.fn(),
      setSavePath: vi.fn(),
      getFilename: () => "x",
      getTotalBytes: () => 0,
      getReceivedBytes: () => 0,
    });
    profile.emit("will-download", {}, item, guest);
    await vi.advanceTimersByTimeAsync(10);
    expect(item.cancel).toHaveBeenCalledOnce();
    await adapter.drive(7, null, "short");
    await begin("next");
    expect(await adapter.waitFor(7, { text: "ready", timeoutMs: 10 }, "next")).toMatchObject({
      met: true,
    });
  });

  it("caps native download count and leaves ordinary human downloads alone", async () => {
    const { begin, adapter, profile, guest } = fixture();
    const item = () =>
      Object.assign(new EventEmitter(), {
        cancel: vi.fn(),
        setSavePath: vi.fn(),
        getFilename: () => "x",
        getTotalBytes: () => 0,
        getReceivedBytes: () => 0,
      });
    const human = item();
    profile.emit("will-download", {}, human, guest);
    expect(human.setSavePath).not.toHaveBeenCalled();
    await begin();
    const items = Array.from({ length: 5 }, item);
    for (const download of items) profile.emit("will-download", {}, download, guest);
    expect(
      items.slice(0, 4).every((download) => download.setSavePath.mock.calls.length === 1),
    ).toBe(true);
    expect(items[4]!.cancel).toHaveBeenCalledOnce();
    adapter.cancel("call");
    expect(items.slice(0, 4).every((download) => download.cancel.mock.calls.length === 1)).toBe(
      true,
    );
  });
});
