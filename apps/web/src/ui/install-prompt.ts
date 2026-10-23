import { readDesktopChrome } from "@chat/desktop-rpc";
import { useSyncExternalStore } from "react";

/** Chromium's install offer, which no standard library type declares. */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

/**
 * How this browser can install the app: its own prompt (Chromium), the steps
 * Safari needs, which has no prompt, or nothing (installed, the desktop app,
 * or a browser that cannot).
 */
export type InstallWay = "prompt" | "ios" | "mac-safari" | null;

let offer: InstallPromptEvent | null = null;
let listening = false;
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};

/**
 * Keeps the browser's install offer for Settings to use. It fires once, soon
 * after the service worker is up, long before anyone opens that page.
 */
export function keepInstallOffer() {
  if (listening) return;
  listening = true;
  window.addEventListener("beforeinstallprompt", (event) => {
    // Kept for the button in Settings; the address bar's own install icon stays.
    event.preventDefault();
    offer = event as InstallPromptEvent;
    changed();
  });
  window.addEventListener("appinstalled", () => {
    offer = null;
    changed();
  });
}

const installed = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  (navigator as { standalone?: boolean }).standalone === true;

function currentWay(): InstallWay {
  if (readDesktopChrome() !== null || installed()) return null;
  if (offer) return "prompt";
  const agent = navigator.userAgent;
  // Safari alone names itself only Safari: every other browser adds its own name.
  if (!/Safari\//.test(agent) || /Chrome|Chromium|CriOS|FxiOS|EdgiOS|Android/.test(agent))
    return null;
  // An iPad asks for the desktop site, so it says Macintosh, but has a touch screen.
  const ios =
    /iPhone|iPad|iPod/.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1);
  return ios ? "ios" : "mac-safari";
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const media = window.matchMedia("(display-mode: standalone)");
  media.addEventListener("change", listener);
  return () => {
    listeners.delete(listener);
    media.removeEventListener("change", listener);
  };
}

export const useInstallWay = () => useSyncExternalStore(subscribe, currentWay, () => null);

/** Shows the browser's own install dialog; the offer works once, either way. */
export async function install() {
  const current = offer;
  if (!current) return;
  offer = null;
  changed();
  await current.prompt();
}
