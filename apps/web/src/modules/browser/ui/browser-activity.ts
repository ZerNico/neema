import {
  ArrowDataTransferVerticalIcon,
  CodeIcon,
  CursorPointer01Icon,
  Download04Icon,
  Globe02Icon,
  KeyboardIcon,
  Layers01Icon,
  ListViewIcon,
  TextIcon,
  Timer01Icon,
  ViewIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { stringArg as text } from "~/modules/desktop/tool-schema.ts";
import { hostOf } from "../client/address.ts";
import { isSensitive, type BrowserToolName } from "../tool-schema.ts";
import { elementPhrase, keyPhrase } from "../wording.ts";

type Args = Readonly<Record<string, unknown>>;

// The element a call acts on, when an approval card knows it (`target`, from
// the tab's last outline). Its bare reference means nothing to a person.
const element = (args: Args) => elementPhrase(text(args.target)) ?? "";
const place = (url: string) => hostOf(url) ?? url;

/**
 * How each browser tool reads in the transcript: its icon, the argument a
 * reader wants to see, the running line, and what an approval card asks. A
 * site approval always reads "Open this site in the browser" instead.
 */
export const BROWSER_ACTIVITY: Record<
  BrowserToolName,
  {
    readonly icon: IconSvgElement;
    readonly arg: (args: Args) => string;
    readonly running: (args: Args) => string;
    readonly ask: string;
  }
> = {
  browser_tabs: {
    icon: Layers01Icon,
    arg: () => "",
    running: () => "Looking at the open tabs",
    ask: "Look at the open tabs",
  },
  browser_open: {
    icon: Globe02Icon,
    arg: (args) => text(args.url),
    running: (args) => (text(args.url) ? `Opening ${place(text(args.url))}` : "Opening a page"),
    ask: "Open this site in the browser",
  },
  browser_navigate: {
    icon: Globe02Icon,
    arg: (args) => text(args.url),
    running: (args) =>
      text(args.url)
        ? `Going to ${place(text(args.url))}`
        : args.action === "back"
          ? "Going back"
          : args.action === "forward"
            ? "Going forward"
            : "Reloading the page",
    ask: "Move this browser tab",
  },
  browser_snapshot: {
    icon: ViewIcon,
    arg: () => "",
    running: (args) =>
      args.share === true
        ? "Taking a screenshot for you"
        : args.save === true
          ? "Saving a screenshot"
          : args.screenshot === true
            ? "Looking at the page"
            : "Reading the page",
    ask: "Read this page",
  },
  browser_wait_for: {
    icon: Timer01Icon,
    arg: (args) => text(args.text),
    running: () => "Waiting for the page",
    ask: "Read this page",
  },
  browser_click: {
    icon: CursorPointer01Icon,
    arg: element,
    running: () => "Clicking",
    ask: "Click on this page",
  },
  browser_type: {
    icon: TextIcon,
    // Only an approval card has the text, from the live call; a secret is
    // never shown, not even there.
    arg: (args) => {
      const typed = isSensitive(args) ? "••••••••" : text(args.text);
      return element(args) ? `${typed}\ninto ${element(args)}` : typed;
    },
    running: () => "Typing",
    ask: "Type on this page",
  },
  browser_press: {
    icon: KeyboardIcon,
    arg: (args) => (text(args.key) ? keyPhrase(text(args.key)) : ""),
    running: (args) =>
      text(args.key) ? `Pressing ${keyPhrase(text(args.key))}` : "Pressing a key",
    ask: "Press a key on this page",
  },
  browser_scroll: {
    icon: ArrowDataTransferVerticalIcon,
    arg: element,
    running: () => "Scrolling",
    ask: "Read this page",
  },
  browser_select: {
    icon: ListViewIcon,
    arg: (args) =>
      text(args.value) && element(args)
        ? `${text(args.value)}\nin ${element(args)}`
        : text(args.value),
    running: () => "Choosing an option",
    ask: "Choose an option on this page",
  },
  browser_save: {
    icon: Download04Icon,
    arg: (args) =>
      Array.isArray(args.urls) ? args.urls.filter((url) => typeof url === "string").join("\n") : "",
    running: (args) =>
      Array.isArray(args.urls) && args.urls.length > 1
        ? `Saving ${args.urls.length} files`
        : "Saving a file",
    ask: "Save files from the web",
  },
  browser_evaluate: {
    icon: CodeIcon,
    arg: (args) => text(args.expression),
    running: () => "Running code on the page",
    ask: "Run this code on the page",
  },
};
