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
import { m } from "~/paraglide/messages.js";
import { getLocale } from "~/paraglide/runtime.js";
import { hostOf } from "../client/address.ts";
import { isSensitive, type BrowserToolName } from "../tool-schema.ts";
import { elementLabel, keyPhrase } from "../wording.ts";

type Args = Readonly<Record<string, unknown>>;

// The element a call acts on, when an approval card knows it (`target`, from
// the tab's last outline). Its bare reference means nothing to a person.
const element = (args: Args) => elementLabel(text(args.target)) ?? "";
const place = (url: string) => hostOf(url) ?? url;
const key = (args: Args) => keyPhrase(text(args.key), getLocale());

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
    readonly ask: () => string;
  }
> = {
  browser_tabs: {
    icon: Layers01Icon,
    arg: () => "",
    running: () => m.browser_running_tabs(),
    ask: m.browser_ask_tabs,
  },
  browser_open: {
    icon: Globe02Icon,
    arg: (args) => text(args.url),
    running: (args) =>
      text(args.url)
        ? m.browser_running_open_host({ host: place(text(args.url)) })
        : m.browser_running_open_page(),
    ask: m.browser_ask_open,
  },
  browser_navigate: {
    icon: Globe02Icon,
    arg: (args) => text(args.url),
    running: (args) =>
      text(args.url)
        ? m.browser_running_go_to({ host: place(text(args.url)) })
        : args.action === "back"
          ? m.browser_running_back()
          : args.action === "forward"
            ? m.browser_running_forward()
            : m.browser_running_reload(),
    ask: m.browser_ask_navigate,
  },
  browser_snapshot: {
    icon: ViewIcon,
    arg: () => "",
    running: (args) =>
      args.share === true
        ? m.browser_running_share_screenshot()
        : args.save === true
          ? m.browser_running_save_screenshot()
          : args.screenshot === true
            ? m.browser_running_look()
            : m.browser_running_read(),
    ask: m.browser_ask_read,
  },
  browser_wait_for: {
    icon: Timer01Icon,
    arg: (args) => text(args.text),
    running: () => m.browser_running_wait(),
    ask: m.browser_ask_read,
  },
  browser_click: {
    icon: CursorPointer01Icon,
    arg: element,
    running: () => m.browser_running_click(),
    ask: m.browser_ask_click,
  },
  browser_type: {
    icon: TextIcon,
    // Only an approval card has the text, from the live call; a secret is
    // never shown, not even there.
    arg: (args) => {
      const typed = isSensitive(args) ? "••••••••" : text(args.text);
      return element(args)
        ? m.browser_activity_typed_into({ text: typed, element: element(args) })
        : typed;
    },
    running: () => m.browser_running_type(),
    ask: m.browser_ask_type,
  },
  browser_press: {
    icon: KeyboardIcon,
    arg: (args) => (text(args.key) ? key(args) : ""),
    running: (args) =>
      text(args.key) ? m.browser_running_press_key({ key: key(args) }) : m.browser_running_press(),
    ask: m.browser_ask_press,
  },
  browser_scroll: {
    icon: ArrowDataTransferVerticalIcon,
    arg: element,
    running: () => m.browser_running_scroll(),
    ask: m.browser_ask_read,
  },
  browser_select: {
    icon: ListViewIcon,
    arg: (args) =>
      text(args.value) && element(args)
        ? m.browser_activity_chosen_in({ value: text(args.value), element: element(args) })
        : text(args.value),
    running: () => m.browser_running_select(),
    ask: m.browser_ask_select,
  },
  browser_save: {
    icon: Download04Icon,
    arg: (args) =>
      Array.isArray(args.urls) ? args.urls.filter((url) => typeof url === "string").join("\n") : "",
    running: (args) =>
      m.browser_running_save({
        count: Array.isArray(args.urls) && args.urls.length > 1 ? args.urls.length : 1,
      }),
    ask: m.browser_ask_save,
  },
  browser_evaluate: {
    icon: CodeIcon,
    arg: (args) => text(args.expression),
    running: () => m.browser_running_evaluate(),
    ask: m.browser_ask_evaluate,
  },
};
