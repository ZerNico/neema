import {
  AppStoreIcon,
  CursorPointer01Icon,
  DragDropIcon,
  KeyboardIcon,
  Layers01Icon,
  ArrowDataTransferVerticalIcon,
  TextIcon,
  ViewIcon,
  ZoomInAreaIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { stringArg as text } from "~/modules/desktop/tool-schema.ts";
import { m } from "~/paraglide/messages.js";
import { appOfArgs, type AppToolName } from "../tool-schema.ts";

type Args = Readonly<Record<string, unknown>>;

/**
 * An app as a reader knows it. The model names apps by bundle id, whose last part is the app
 * ("com.microsoft.Excel"), or by the name it read in app_list, kept as it is.
 */
export const appName = (args: Args | undefined) => {
  const app = appOfArgs(args);
  return /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(app) ? app.split(".").at(-1)! : app;
};

/**
 * How each app tool reads in the transcript. Never a reference or a coordinate: those mean
 * nothing to a person. A result's detail is written for the model, so the row keeps to this.
 */
export const APP_ACTIVITY: Record<
  AppToolName,
  { readonly icon: IconSvgElement; readonly running: (args: Args) => string }
> = {
  app_list: { icon: Layers01Icon, running: () => m.app_running_list() },
  app_open: { icon: AppStoreIcon, running: (args) => m.app_running_open({ app: appName(args) }) },
  app_look: { icon: ViewIcon, running: (args) => m.app_running_look({ app: appName(args) }) },
  app_click: {
    icon: CursorPointer01Icon,
    running: (args) => m.app_running_click({ app: appName(args) }),
  },
  app_type: { icon: TextIcon, running: (args) => m.app_running_type({ app: appName(args) }) },
  app_key: {
    icon: KeyboardIcon,
    running: (args) => m.app_running_key({ key: text(args.keys), app: appName(args) }),
  },
  app_scroll: {
    icon: ArrowDataTransferVerticalIcon,
    running: (args) => m.app_running_scroll({ app: appName(args) }),
  },
  app_drag: { icon: DragDropIcon, running: (args) => m.app_running_drag({ app: appName(args) }) },
  app_zoom: {
    icon: ZoomInAreaIcon,
    running: (args) => m.app_running_zoom({ app: appName(args) }),
  },
};

/** The row's line: what it did while running and after, or what it could not do. */
export const appActivityLabel = (name: AppToolName, args: Args, failed: boolean) => {
  if (!failed) return APP_ACTIVITY[name].running(args);
  return name === "app_list" ? m.app_failed_list() : m.app_failed({ app: appName(args) });
};
