import type { DesktopBrowser, DesktopBrowserAgent } from "@chat/desktop-rpc";
import {
  desktopFailure,
  type BrowserToolName,
  type DesktopToolResult,
} from "~/modules/desktop/tool-schema.ts";
import type { ExternalOperation } from "~/modules/tools/server/external-completion.ts";
import { hostOf } from "./address.ts";
import { browserTabs, type BrowserTab } from "./browser-store.ts";

type BrowserCall = Pick<ExternalOperation, "callId" | "conversationId" | "args" | "meta"> & {
  readonly name: BrowserToolName;
};

const WAKE_MS = 15_000;
const LOAD_MS = 30_000;
const WAIT_DEFAULT_MS = 10_000;
const WAIT_MAX_MS = 30_000;

// One per call in flight, so Stop or an expired call ends its waits at once.
const running = new Map<string, AbortController>();

/** Ends a browser call's waits; the page stops loading and the tab is released. */
export const cancelBrowserCall = (callId: string) => running.get(callId)?.abort();

const str = (value: unknown) => (typeof value === "string" ? value : "");

const done = (summary: string, detail: string, extra: Partial<DesktopToolResult> = {}) =>
  ({ v: 1, ok: true, summary, detail, truncated: false, ...extra }) satisfies DesktopToolResult;

const isWebAddress = (url: string) => {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

const describeTab = (tab: BrowserTab) =>
  `${tab.label}: ${tab.title || hostOf(tab.url) || "New tab"}\n${tab.url}`;

const ownTabs = (owner: string) =>
  [...browserTabs.all().values()].filter((tab) => tab.owner === owner);

/**
 * The tab a call means: the one it names, else the chat's only tab, else the
 * one on screen. Anything else is a question the model has to answer.
 */
const resolveTab = (owner: string, label: string): BrowserTab | string => {
  const mine = ownTabs(owner);
  if (label) {
    const named = mine.find((tab) => tab.label === label);
    if (named) return named;
    return `There is no tab ${label} in this chat. ${mine.length === 0 ? "Open one with browser_open." : `Its tabs are ${mine.map((tab) => tab.label).join(", ")}.`}`;
  }
  if (mine.length === 1) return mine[0]!;
  const shown = mine.find((tab) => browserTabs.visible().has(tab.id));
  if (shown) return shown;
  return mine.length === 0
    ? "This chat has no browser tabs. Open one with browser_open."
    : `Name a tab: ${mine.map((tab) => tab.label).join(", ")}.`;
};

/**
 * A page the model is about to use must be running: a discarded one loads
 * again from its address, a frozen one is woken by the hold the running answer
 * puts on its chat. Resolves with the page's guest id, or null in time.
 */
const wake = async (id: string, signal: AbortSignal): Promise<number | null> => {
  const tab = browserTabs.get(id);
  if (tab && !tab.live) browserTabs.update(id, { live: true });
  const ready = await browserTabs.until(
    (all) => all.get(id)?.webContentsId != null,
    WAKE_MS,
    signal,
  );
  return ready ? (browserTabs.get(id)?.webContentsId ?? null) : null;
};

/** Waits for a load that has started (or is about to) to finish. */
const settle = async (id: string, signal: AbortSignal) => {
  await browserTabs.until((all) => all.get(id)?.loading === true, 1_000, signal);
  await browserTabs.until((all) => all.get(id)?.loading === false, LOAD_MS, signal);
};

const blockedResult = (site: string) =>
  desktopFailure(
    `Stopped before ${site}`,
    `The page tried to go to ${site}, which is not allowed in this chat. To go there, call browser_navigate with that address; the user will be asked.`,
  );

const unreachable = desktopFailure(
  "The tab did not respond",
  "The page could not be woken in time. Try again, or open it anew with browser_open.",
);

/**
 * Runs one browser call in this app's own tabs. Everything here is the page's
 * to do; only reading a page, waiting on it and gating where it may go cross
 * into Electron's main process through `agent`.
 */
export async function executeBrowserTool(
  call: BrowserCall,
  remainingMs: number,
  browser: DesktopBrowser,
  agent: DesktopBrowserAgent,
): Promise<DesktopToolResult> {
  const controller = new AbortController();
  running.set(call.callId, controller);
  const deadline = setTimeout(() => controller.abort(), Math.max(0, remainingMs - 1_000));
  const { signal } = controller;
  const owner = call.conversationId;
  const args = call.args;
  const partition = call.meta?.temporary ? browser.temporaryPartition(owner) : browser.partition;

  const ended = new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

  // Every navigation runs driven: the page may only reach sites the chat
  // allows, plus the one this call was allowed to open. It ends with the load,
  // the load deadline, or the call; an ended call leaves the page stopped.
  const driven = async (
    tabId: string,
    webContentsId: number,
    allow: string[],
    work: () => Promise<void>,
  ): Promise<string | null> => {
    await agent.drive(webContentsId, { conversationId: owner, allow });
    let loadTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        work(),
        ended,
        new Promise<void>((resolve) => {
          loadTimer = setTimeout(resolve, LOAD_MS);
        }),
      ]);
    } finally {
      clearTimeout(loadTimer);
      if (signal.aborted) browserTabs.webview(tabId)?.stop();
    }
    return (await agent.drive(webContentsId, null)).blocked;
  };

  try {
    switch (call.name) {
      case "browser_tabs": {
        const mine = ownTabs(owner);
        if (mine.length === 0) return done("No browser tabs", "This chat has no browser tabs.");
        return done(
          `${mine.length} browser ${mine.length === 1 ? "tab" : "tabs"}`,
          mine
            .map(
              (tab) => `${describeTab(tab)}${browserTabs.visible().has(tab.id) ? "\n(shown)" : ""}`,
            )
            .join("\n\n"),
        );
      }

      case "browser_open": {
        const url = str(args.url);
        if (!isWebAddress(url))
          return desktopFailure("No address to open", "Give an absolute http(s) address as url.");
        // A replayed call finds the tab it already opened rather than opening another.
        const tab =
          ownTabs(owner).find((candidate) => candidate.openedBy === call.callId) ??
          browserTabs.open({ owner, partition, url: "about:blank", openedBy: call.callId });
        browserTabs.reveal(tab.id);
        const guest = await wake(tab.id, signal);
        if (guest === null) return unreachable;
        const blocked = await driven(tab.id, guest, [url], async () => {
          await browserTabs
            .webview(tab.id)
            ?.loadURL(url)
            .catch(() => {});
        });
        if (blocked) return blockedResult(blocked);
        const opened = browserTabs.get(tab.id) ?? tab;
        return done(
          `Opened ${hostOf(opened.url) ?? url} in ${opened.label}`,
          `${describeTab(opened)}\n\nRead it with browser_snapshot.`,
        );
      }

      case "browser_navigate": {
        const target = resolveTab(owner, str(args.tab));
        if (typeof target === "string") return desktopFailure("Which tab?", target);
        const url = str(args.url);
        const action = str(args.action);
        if (!url && !["back", "forward", "reload"].includes(action))
          return desktopFailure(
            "Nowhere to go",
            'Give an absolute http(s) address as url, or action "back", "forward" or "reload".',
          );
        if (url && !isWebAddress(url))
          return desktopFailure("Not a web address", "Give an absolute http(s) address as url.");
        browserTabs.reveal(target.id);
        const guest = await wake(target.id, signal);
        if (guest === null) return unreachable;
        const webview = () => browserTabs.webview(target.id);
        const blocked = await driven(target.id, guest, url ? [url] : [], async () => {
          if (url) {
            await webview()
              ?.loadURL(url)
              .catch(() => {});
            return;
          }
          if (action === "back") webview()?.goBack();
          else if (action === "forward") webview()?.goForward();
          else webview()?.reload();
          await settle(target.id, signal);
        });
        if (blocked) return blockedResult(blocked);
        const moved = browserTabs.get(target.id) ?? target;
        return done(
          `${url ? "Went to" : action === "reload" ? "Reloaded" : action === "back" ? "Went back to" : "Went forward to"} ${hostOf(moved.url) ?? moved.url} in ${moved.label}`,
          describeTab(moved),
        );
      }

      case "browser_snapshot": {
        const target = resolveTab(owner, str(args.tab));
        if (typeof target === "string") return desktopFailure("Which tab?", target);
        const guest = await wake(target.id, signal);
        if (guest === null) return unreachable;
        await browserTabs.until((all) => all.get(target.id)?.loading === false, LOAD_MS, signal);
        const wanted = args.screenshot === true;
        const snapshot = await agent.snapshot(guest, { screenshot: wanted });
        const note =
          wanted && !snapshot.screenshot
            ? "\n\n(No screenshot: the page could not be captured, likely because it is not on screen.)"
            : "";
        return done(
          `Read ${snapshot.title || hostOf(snapshot.url) || "the page"}`,
          `${target.label}: ${snapshot.title}\n${snapshot.url}\n\n${snapshot.text || "(The page shows nothing readable.)"}${note}`,
          {
            truncated: snapshot.truncated,
            ...(snapshot.screenshot
              ? {
                  file: {
                    mediaType: snapshot.screenshot.mediaType,
                    base64: snapshot.screenshot.base64,
                    name: `${target.label}.jpg`,
                  },
                }
              : {}),
          },
        );
      }

      case "browser_wait_for": {
        const target = resolveTab(owner, str(args.tab));
        if (typeof target === "string") return desktopFailure("Which tab?", target);
        const text = str(args.text);
        const urlIncludes = str(args.urlIncludes);
        if (!text && !urlIncludes)
          return desktopFailure("Nothing to wait for", "Give text, urlIncludes, or both.");
        const guest = await wake(target.id, signal);
        if (guest === null) return unreachable;
        const asked = typeof args.timeoutMs === "number" ? args.timeoutMs : WAIT_DEFAULT_MS;
        const timeoutMs = Math.min(Math.max(asked, 0), WAIT_MAX_MS, remainingMs - 2_000);
        const result = await agent.waitFor(guest, {
          ...(text ? { text } : {}),
          ...(urlIncludes ? { urlIncludes } : {}),
          timeoutMs,
        });
        return result.met
          ? done(`The page is ready in ${target.label}`, `Condition met.\n${result.url}`)
          : desktopFailure(
              "Still waiting",
              `The condition was not met within ${Math.round(timeoutMs / 1000)} seconds.\n${result.url}`,
            );
      }
    }
  } catch (error) {
    return desktopFailure(
      "The browser could not do that",
      error instanceof Error ? error.message : "The desktop app reported an error.",
    );
  } finally {
    clearTimeout(deadline);
    running.delete(call.callId);
  }
}
