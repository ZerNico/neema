import type { ToolResult } from "@chat/desktop-rpc";
import { type AppDriver, AppDriverError, startAppDriver } from "./driver.ts";
import type { AppGrants } from "./grants.ts";
import { buildOutline, type Outline } from "./outline.ts";

/** An `app_*` call as the machine received it. */
export interface AppCall {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly conversationId: string;
  /** The message came from this machine, so its person may be asked. */
  readonly local: boolean;
  readonly signal: AbortSignal;
}

/**
 * The one app driver of this desktop app, shared by every server's host. replayd, which every
 * capture path goes through, mixes up processes of one identity: two drivers capturing at once
 * stalled every capture until both were gone, while two differently named copies did not
 * (measured). So there is one process, its calls one at a time, as Codex has one service.
 */
export class SharedAppDriver {
  private driver: AppDriver | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  /** Accessibility and Screen Recording were seen granted; they hold until the app restarts. */
  permitted = false;
  /**
   * Whose look the driver holds, as `AppUse.key` names chats across servers: node ids and the
   * target window are that look's.
   */
  holder: string | null = null;

  /** `executable` is null where there is no driver for the platform. */
  constructor(readonly executable: string | null) {}

  /** Runs work one at a time, so an action never lands between another chat's look and act. */
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work);
    this.tail = next.catch(() => {});
    return next;
  }

  /** A driver that exited, crashed or was replaced is started again here, not failed on. */
  call: AppDriver["call"] = (method, params) => {
    if (!this.driver?.alive) {
      this.driver = startAppDriver(this.executable!);
      this.holder = null;
    }
    return this.driver.call(method, params);
  };

  /** A driver that exited is started again by the next call. */
  exited() {
    this.driver = null;
    this.holder = null;
  }

  close() {
    this.driver?.close();
    this.driver = null;
  }
}

export interface AppUseOptions {
  readonly driver: SharedAppDriver;
  /** Tells this server's chats apart from another's in the shared driver: its origin. */
  readonly scope: string;
  readonly grants: AppGrants;
  /** Asks the person at this machine, in a native dialog, whether the chat may use the app. */
  readonly ask: (
    app: { name: string; appId: string },
    signal: AbortSignal,
  ) => Promise<"chat" | "always" | "deny">;
  /** Leads the person at this machine through the grants in System Settings. */
  readonly explainPermissions: (signal: AbortSignal) => Promise<void>;
  readonly log: (message: string) => void;
}

/** A chat's latest look: what its references and picture pixels mean. */
interface ChatLook {
  readonly appId: string;
  readonly app: string;
  readonly outline: Outline;
  /** Window points per picture pixel. */
  readonly scale: number;
  /** The window's size in points. */
  readonly window: { readonly width: number; readonly height: number };
}

/** Where pointer input lands, as the driver takes it: a node, or a point in window points. */
type Place = { readonly node: string } | { readonly x: number; readonly y: number };

/** An app redraws after the input that changed it; the look after an action waits this long. */
const SETTLE_MS = 250;

const ok = (summary: string, detail: string, file?: ToolResult["file"]): ToolResult => ({
  v: 1,
  ok: true,
  summary,
  detail,
  truncated: false,
  ...(file ? { file } : {}),
});
const failure = (summary: string, detail: string, file?: ToolResult["file"]): ToolResult => ({
  v: 1,
  ok: false,
  summary,
  detail,
  truncated: false,
  ...(file ? { file } : {}),
});

/** A failure the model is told about, carried out of the steps of a call. */
class Refusal extends Error {
  readonly result: ToolResult;
  constructor(result: ToolResult) {
    super(result.summary);
    this.result = result;
  }
}

const str = (value: unknown) => (typeof value === "string" ? value : "");
const num = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const DRIVER_WORDS: Partial<Record<AppDriverError["code"], (app: string) => string>> = {
  off_limits: (app) =>
    `${app} is never available: terminals, password managers, system settings and neema itself are off limits. Do not try to reach it another way.`,
  not_installed: (app) =>
    `${app} is not installed on this computer. app_list shows what is running.`,
  not_running: (app) => `${app} is not running. Open it with app_open.`,
  no_window: (app) =>
    `${app} has no open window. Open one with its menus or keys, or ask the user.`,
  stale_node: () =>
    "That reference is not in the latest look. Look again and use a reference from it.",
  no_frame: () => "That element has no position on screen. Look again, or use x and y.",
  action_failed: (app) => `${app} did not accept that. Look again and try another way.`,
  capture_failed: (app) => `${app}'s window could not be captured. Try again.`,
};

/**
 * App use for one server's chats on this machine, through the shared driver. Consent is asked
 * here, per app, natively, and only of the person at the machine; from another device only apps
 * they always allow are used. See docs/internals/app-use.md.
 */
export class AppUse {
  private readonly looks = new Map<string, ChatLook>();

  constructor(private readonly options: AppUseOptions) {}

  run(call: AppCall): Promise<ToolResult> {
    return this.options.driver.exclusive(() => this.runNow(call));
  }

  forgetChat(conversationId: string) {
    this.looks.delete(conversationId);
    if (this.options.driver.holder === this.key(conversationId)) this.options.driver.holder = null;
    return this.options.grants.forgetChat(conversationId);
  }

  private key(conversationId: string) {
    return `${this.options.scope}\u0000${conversationId}`;
  }

  private async runNow(call: AppCall): Promise<ToolResult> {
    if (call.signal.aborted) return failure("Stopped", "The call was stopped before it ran.");
    if (!this.options.driver.executable)
      return failure(
        "Apps can't be used here",
        "This computer cannot use apps for the user: app use needs the desktop app on a Mac.",
      );
    // The app's name as macOS gives it, once resolved: the row shows it, not the model's id.
    const named: { name?: string } = {};
    const withApp = (result: ToolResult): ToolResult =>
      named.name ? { ...result, app: { name: named.name } } : result;
    try {
      await this.ensurePermitted(call);
      return withApp(await this.dispatch(call, named));
    } catch (error) {
      if (error instanceof Refusal) return withApp(error.result);
      if (error instanceof AppDriverError) {
        if (error.code === "driver_exited") this.options.driver.exited();
        const app = named.name ?? (str(call.args.app) || "The app");
        const words = DRIVER_WORDS[error.code];
        return withApp(failure(`Couldn't use ${app}`, words ? words(app) : error.message));
      }
      this.options.log(`app use failed: ${error instanceof Error ? error.message : String(error)}`);
      return withApp(failure("That did not work", "App use failed unexpectedly. Try again once."));
    }
  }

  private call: AppDriver["call"] = (method, params) => this.options.driver.call(method, params);

  /** Screen Recording and Accessibility are neema's, granted once in System Settings. */
  private async ensurePermitted(call: AppCall) {
    if (this.options.driver.permitted) return;
    const permissions = await this.call("permissions", {});
    if (permissions.accessibility && permissions.capture) {
      this.options.driver.permitted = true;
      return;
    }
    if (call.local) {
      await this.options.explainPermissions(call.signal);
      // Accessibility counts at once; Screen Recording only after neema reopens.
      const now = await this.call("permissions", {});
      if (now.accessibility && now.capture) {
        this.options.driver.permitted = true;
        return;
      }
    }
    throw new Refusal(
      failure(
        "neema needs permission to use apps",
        call.local
          ? "The user was shown how to allow neema under Accessibility and Screen Recording in System Settings; Screen Recording counts once neema reopens. Nothing ran. Tell them so and try again when they say."
          : "neema on the user's computer is not allowed to use apps yet. Tell the user to allow it under Accessibility and Screen Recording in System Settings there.",
      ),
    );
  }

  private async dispatch(call: AppCall, named: { name?: string }): Promise<ToolResult> {
    if (call.name === "app_list") return this.list(call.conversationId);
    const asked = str(call.args.app);
    if (!asked) return failure("Which app?", "Name the app with app, as app_list shows it.");
    const resolved = await this.call("resolve", { app: asked });
    named.name = resolved.name;
    await this.consent(call, resolved);
    const { appId, name } = resolved;
    switch (call.name) {
      case "app_open":
        // Also when running: macOS then asks the app to reopen, which brings a window back to
        // one that has none, and the driver waits for it.
        await this.call("open", { appId });
        return this.look(call.conversationId, appId, name, `Opened ${name}`);
      case "app_look":
        return this.look(call.conversationId, appId, name, `Looked at ${name}`);
      case "app_zoom":
        return this.zoom(call, appId, name);
      default:
        return this.act(call, appId, name);
    }
  }

  private async list(conversationId: string) {
    const { apps } = await this.call("apps", {});
    const lines = await Promise.all(
      apps
        .filter((app) => !app.offLimits && app.appId)
        .map(async (app) => {
          const allowed = await this.options.grants.allowed(conversationId, app.appId);
          return `- ${app.name} (${app.appId})${app.front ? ", in front" : ""}${allowed ? ", allowed in this chat" : ""}`;
        }),
    );
    return ok(
      `Listed ${lines.length} apps`,
      `Running apps on the user's computer:\n${lines.join("\n")}\n\nAn app not allowed yet asks the user on first use. app_open opens one that is not running.`,
    );
  }

  /** The first use of an app in a chat asks the person at the machine, and only them. */
  private async consent(call: AppCall, app: { appId: string; name: string }) {
    if (await this.options.grants.allowed(call.conversationId, app.appId)) return;
    if (!call.local)
      throw new Refusal(
        failure(
          `${app.name} needs the user's OK`,
          `This message came from another device, and ${app.name} may be used from there only when the user always allows it. Ask them to allow it at their computer.`,
        ),
      );
    const answer = await this.options.ask(app, call.signal);
    // An answer after Stop grants nothing: the call is over.
    if (call.signal.aborted) throw new Refusal(failure("Stopped", "The call was stopped."));
    if (answer === "deny")
      throw new Refusal(
        failure(
          `You declined ${app.name}`,
          `The user declined to let this chat use ${app.name}. Do not retry or reach it another way.`,
        ),
      );
    await this.options.grants.allow(call.conversationId, app.appId, answer);
  }

  private async look(
    conversationId: string,
    appId: string,
    name: string,
    summary: string,
    failed?: string,
  ): Promise<ToolResult> {
    const look = await this.call("look", { appId });
    const outline = buildOutline(look);
    this.looks.set(conversationId, {
      appId,
      app: name,
      outline,
      scale: look.window.width / look.image.width,
      window: look.window,
    });
    this.options.driver.holder = this.key(conversationId);
    const detail = [
      ...(failed ? [failed, ""] : []),
      `${look.app}${look.title ? `, window "${look.title}"` : ""}. The picture is ${look.image.width}×${look.image.height} px; positions and x, y are in its pixels.`,
      "",
      outline.text || "(The window names no controls; act by x and y on the picture.)",
      ...(outline.truncated
        ? ["", "(The outline was cut short; zoom or scroll for the rest.)"]
        : []),
    ].join("\n");
    const file = { mediaType: "image/png", base64: look.image.data, name: `${name}.png` };
    return failed ? failure(summary, detail, file) : ok(summary, detail, file);
  }

  /**
   * The chat's latest look, if the driver still holds it for this app. Otherwise the app is
   * looked at again and the model acts on that: another chat's look in between would make a
   * reference or a point mean something else.
   */
  private async current(call: AppCall, appId: string, name: string) {
    const look = this.looks.get(call.conversationId);
    if (
      look &&
      look.appId === appId &&
      this.options.driver.holder === this.key(call.conversationId)
    )
      return look;
    throw new Refusal(
      await this.look(
        call.conversationId,
        appId,
        name,
        `Looked at ${name} first`,
        "Nothing was done: this is a fresh look. Act on its references and picture.",
      ),
    );
  }

  /** A reference or picture point as the driver takes it: a node id, or window points. */
  private place(look: ChatLook, value: unknown): Place {
    const at = (value ?? {}) as Record<string, unknown>;
    const ref = str(at.ref);
    if (ref) {
      const node = look.outline.refs.get(ref);
      if (!node)
        throw new Refusal(
          failure(
            "Unknown reference",
            `${ref} is not in the latest look of ${look.app}. Use a reference from it, or x and y.`,
          ),
        );
      return { node };
    }
    const x = num(at.x);
    const y = num(at.y);
    if (x === undefined || y === undefined)
      throw new Refusal(failure("Where?", "Give ref, or both x and y in the picture's pixels."));
    return { x: x * look.scale, y: y * look.scale };
  }

  private async act(call: AppCall, appId: string, name: string): Promise<ToolResult> {
    const look = await this.current(call, appId, name);
    const args = call.args;
    let summary: string;
    switch (call.name) {
      case "app_click": {
        const place = this.place(look, args);
        const button = str(args.button);
        const modifiers = Array.isArray(args.modifiers)
          ? args.modifiers.filter((entry): entry is string => typeof entry === "string")
          : [];
        await this.call("click", {
          ...("node" in place ? { node: place.node } : { at: place }),
          ...(button === "right" || button === "middle" ? { button } : {}),
          ...(num(args.count) ? { count: num(args.count)! } : {}),
          ...(modifiers.length ? { modifiers } : {}),
        });
        summary = `Clicked in ${name}`;
        break;
      }
      case "app_type": {
        const text = str(args.text);
        const ref = str(args.ref);
        const target = ref ? this.place(look, { ref }) : undefined;
        const node = target && "node" in target ? target.node : undefined;
        if (args.replace === true && node) await this.call("setValue", { node, value: text });
        else await this.call("type", { text, ...(node ? { node } : {}) });
        summary = `Typed in ${name}`;
        break;
      }
      case "app_key": {
        const keys = str(args.keys);
        if (!keys) throw new Refusal(failure("Which keys?", 'Give keys, like "cmd+s".'));
        await this.call("key", { keys });
        summary = `Pressed ${keys} in ${name}`;
        break;
      }
      case "app_scroll": {
        const amount = Math.min(Math.max(Math.round(num(args.amount) ?? 5), 1), 50);
        const direction = str(args.direction) || "down";
        const lines = {
          up: { y: amount },
          down: { y: -amount },
          left: { x: amount },
          right: { x: -amount },
        }[direction] ?? { y: -amount };
        // No place scrolls the middle of the window, where the content usually is.
        const at: Place =
          str(args.ref) || num(args.x) !== undefined
            ? this.place(look, args)
            : { x: look.window.width / 2, y: look.window.height / 2 };
        await this.call("scroll", { at, ...lines });
        summary = `Scrolled in ${name}`;
        break;
      }
      case "app_drag": {
        await this.call("drag", {
          from: this.place(look, args.from),
          to: this.place(look, args.to),
        });
        summary = `Dragged in ${name}`;
        break;
      }
      default:
        return failure("Unknown tool", `${call.name} is not an app tool.`);
    }
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    return this.look(call.conversationId, appId, name, summary);
  }

  private async zoom(call: AppCall, appId: string, name: string): Promise<ToolResult> {
    const look = await this.current(call, appId, name);
    const [x, y, width, height] = [call.args.x, call.args.y, call.args.width, call.args.height].map(
      num,
    );
    if (x === undefined || y === undefined || !width || !height)
      return failure("Which part?", "Give x, y, width and height in the latest picture's pixels.");
    const picture = await this.call("zoom", {
      region: {
        x: x * look.scale,
        y: y * look.scale,
        width: width * look.scale,
        height: height * look.scale,
      },
    });
    return ok(
      `Zoomed into ${name}`,
      `Part of ${name}'s window at full detail, ${picture.width}×${picture.height} px. Positions for actions are still in the look's picture, not this one.`,
      { mediaType: "image/png", base64: picture.data, name: `${name} detail.png` },
    );
  }
}
