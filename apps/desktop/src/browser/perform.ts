import type { BrowserAction, BrowserActionResult } from "@chat/desktop-rpc";
import { parseKey, type KeyPress } from "./keys.ts";

const EVALUATE_MAX_MS = 10_000;
const EVALUATE_MAX_CHARS = 20_000;
// How long a trivial expression may take before the page counts as busy.
const BUSY_PROBE_MS = 500;

// A timer that can be called off, so a settled race leaves nothing pending.
const delay = (ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<"elapsed">((resolve) => {
    timer = setTimeout(() => resolve("elapsed"), ms);
  });
  return { done, cancel: () => clearTimeout(timer) };
};

/** The DevTools protocol of one guest; the caller types what a command returns. */
export interface Cdp {
  send<T>(method: string, params?: Record<string, unknown>): Promise<T>;
}

/** What acting on one guest needs, apart from Electron, so it can be tested. */
export interface ActingPage {
  readonly cdp: Cdp;
  /** Runs code in the agent's isolated world: the page's DOM, none of its scripts. */
  evaluate(code: string): Promise<unknown>;
  /** The node a reference of the last outline stands for, or null. */
  node(ref: string): number | null;
  /** Page pixels per pixel of the last screenshot, if there was one. */
  readonly screenshotScale: number | undefined;
  /** A secret went into this node: later outlines must not read its value back. */
  typedSecret(node: number): void;
}

const stale = (): BrowserActionResult => ({
  ok: false,
  reason: "stale-ref",
  message: "That reference is not on the page any more. Take a new browser_snapshot.",
});

// A key press made inside the page, never through the protocol's keyboard,
// which in a <webview> goes wherever the window's focus is, even the app's own
// message box. The page sees key events; what the key does is done here too.
const PRESS_IN_PAGE = `(press) => {
  const target = document.activeElement || document.body;
  const init = {
    key: press.key, code: press.code, keyCode: press.keyCode, which: press.keyCode,
    bubbles: true, cancelable: true, composed: true,
    altKey: (press.modifiers & 1) !== 0, ctrlKey: (press.modifiers & 2) !== 0,
    metaKey: (press.modifiers & 4) !== 0, shiftKey: (press.modifiers & 8) !== 0,
  };
  const go = target.dispatchEvent(new KeyboardEvent("keydown", init));
  const editable = target.isContentEditable || target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLInputElement && !["button", "checkbox", "radio", "submit", "reset"].includes(target.type));
  if (go) {
    if (press.text) target.dispatchEvent(new KeyboardEvent("keypress", init));
    if (press.key === "Enter") {
      const form = target.form || (target.closest && target.closest("form"));
      if (target instanceof HTMLInputElement && form) form.requestSubmit();
      else if (editable) document.execCommand("insertText", false, "\\n");
      else if (target.click && (target instanceof HTMLButtonElement || target instanceof HTMLAnchorElement)) target.click();
    } else if (press.key === "Backspace" && editable) document.execCommand("delete");
    else if (press.key === "Delete" && editable) document.execCommand("forwardDelete");
    else if (press.key === "Tab") {
      const all = [...document.querySelectorAll("a[href], button, input, select, textarea, [tabindex]")]
        .filter((element) => element.tabIndex >= 0 && !element.disabled && element.offsetParent !== null);
      const next = all[(all.indexOf(target) + (init.shiftKey ? all.length - 1 : 1)) % all.length];
      if (next) next.focus();
    } else if (press.text && editable) document.execCommand("insertText", false, press.text);
  }
  target.dispatchEvent(new KeyboardEvent("keyup", init));
  return true;
}`;

const pressKey = (page: ActingPage, press: KeyPress) =>
  page.evaluate(`(${PRESS_IN_PAGE})(${JSON.stringify(press)})`);

const click = async (cdp: Cdp, x: number, y: number) => {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  const press = { x, y, button: "left", clickCount: 1 };
  await cdp.send("Input.dispatchMouseEvent", { ...press, type: "mousePressed" });
  await cdp.send("Input.dispatchMouseEvent", { ...press, type: "mouseReleased" });
};

// The centre of a referenced node, scrolled into view first; null once it is gone.
const centreOf = async (cdp: Cdp, backendNodeId: number) => {
  try {
    await cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
    const { model } = await cdp.send<{ model: { content: number[] } }>("DOM.getBoxModel", {
      backendNodeId,
    });
    const [x1 = 0, y1 = 0, , , x3 = 0, y3 = 0] = model.content;
    return { x: (x1 + x3) / 2, y: (y1 + y3) / 2 };
  } catch {
    return null;
  }
};

const isPasswordField = async (cdp: Cdp, backendNodeId: number) => {
  const described = await cdp
    .send<{ node?: { attributes?: string[] } }>("DOM.describeNode", { backendNodeId })
    .catch(() => null);
  if (!described) return null;
  const attributes = described.node?.attributes ?? [];
  return attributes.some(
    (value, index) =>
      index % 2 === 0 && value === "type" && attributes[index + 1]?.toLowerCase() === "password",
  );
};

/**
 * Runs fixed code on a referenced node, with any value as an argument rather
 * than as code. Null once the node is gone.
 */
const callOn = async (
  cdp: Cdp,
  backendNodeId: number,
  code: string,
  values: ReadonlyArray<string | number> = [],
) => {
  const resolved = await cdp
    .send<{ object?: { objectId?: string } }>("DOM.resolveNode", { backendNodeId })
    .catch(() => null);
  const objectId = resolved?.object?.objectId;
  if (!objectId) return null;
  const { result } = await cdp.send<{ result: { value?: unknown } }>("Runtime.callFunctionOn", {
    objectId,
    returnByValue: true,
    arguments: values.map((value) => ({ value })),
    functionDeclaration: code,
  });
  return result;
};

// Types through the page's own editing commands, after its text or in place
// of it, so the page's input handling sees it as typing. The protocol's
// insertText drops text in a guest Electron has not activated, and keyboard
// select-all does nothing on macOS. The text is an argument, never code.
const TYPE_TEXT = `function (text, clear) {
  const NOT_TEXT = ["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"];
  const field =
    this instanceof HTMLTextAreaElement ||
    (this instanceof HTMLInputElement && !NOT_TEXT.includes(this.type));
  if (!(field || this.isContentEditable) || this.disabled || this.readOnly) return "not-editable";
  this.focus();
  if (document.activeElement !== this && !this.contains(document.activeElement)) return "not-editable";
  const selection = getSelection();
  if (field) {
    try {
      const end = this.value.length;
      this.setSelectionRange(clear ? 0 : end, end);
    } catch {
      if (clear) this.select();
    }
  } else {
    const range = document.createRange();
    range.selectNodeContents(this);
    if (!clear) range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  const done = text.length > 0
    ? document.execCommand("insertText", false, text)
    : !clear || document.execCommand("delete");
  if (!done) return "not-editable";
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return "ok";
}`;

// Submits the form a field belongs to, as Enter would; "no-form" leaves Enter to the caller.
const SUBMIT_FORM = `function () {
  const form = this.form || (this.closest && this.closest("form"));
  if (!form) return "no-form";
  form.requestSubmit();
  return "submitted";
}`;

// Scrolls the element it runs on by the given pixels, at once, and says where
// it ended up: how far down, out of how far it can go.
const SCROLL_BY = `function (left, top) {
  this.scrollBy({ left, top, behavior: "instant" });
  return [Math.round(this.scrollTop), Math.max(0, this.scrollHeight - this.clientHeight)];
}`;

// Fixed code with the wanted value as an argument; nothing typed runs.
const SELECT_OPTION = `function (wanted) {
  if (!(this instanceof HTMLSelectElement)) return "not-select";
  const option = [...this.options].find(
    (o) => o.value === wanted || o.label === wanted || o.text.trim() === wanted,
  );
  if (!option) return "no-option";
  this.value = option.value;
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return "ok";
}`;

const evaluate = async (page: ActingPage, expression: string): Promise<BrowserActionResult> => {
  const limit = delay(EVALUATE_MAX_MS);
  try {
    const outcome = await Promise.race([
      page.evaluate(expression).then((value) => ({ value })),
      limit.done,
    ]);
    if (outcome === "elapsed") {
      // A loop keeps the page's thread, and every later call on this tab with
      // it, so it is ended. Only when the page is busy, though: terminating
      // while nothing runs (the code awaiting a promise that never settles)
      // would kill the page's own next script instead.
      const probe = delay(BUSY_PROBE_MS);
      const busy =
        (await Promise.race([
          page.cdp.send("Runtime.evaluate", { expression: "0" }).then(
            () => "answered" as const,
            () => "answered" as const,
          ),
          probe.done,
        ])) === "elapsed";
      probe.cancel();
      if (busy) await page.cdp.send("Runtime.terminateExecution").catch(() => {});
      return {
        ok: false,
        reason: "script-error",
        message: `It ran longer than ${EVALUATE_MAX_MS / 1000} seconds.`,
      };
    }
    const { value } = outcome;
    const json = value === undefined ? "undefined" : (JSON.stringify(value) ?? String(value));
    return {
      ok: true,
      value: json.slice(0, EVALUATE_MAX_CHARS),
      truncated: json.length > EVALUATE_MAX_CHARS,
    };
  } catch (error) {
    return {
      ok: false,
      reason: "script-error",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    limit.cancel();
  }
};

/**
 * One action, as real input through the DevTools protocol so the page sees
 * trusted events exactly as from a person. Only `evaluate` runs code.
 */
export async function perform(
  page: ActingPage,
  action: BrowserAction,
): Promise<BrowserActionResult> {
  const { cdp } = page;
  switch (action.kind) {
    case "click": {
      if (action.ref) {
        const node = page.node(action.ref);
        const centre = node === null ? null : await centreOf(cdp, node);
        if (!centre) return stale();
        await click(cdp, centre.x, centre.y);
        return { ok: true };
      }
      const scale = page.screenshotScale;
      if (scale === undefined || action.x === undefined || action.y === undefined)
        return {
          ok: false,
          reason: "no-screenshot",
          message:
            "Click by reference, or take a browser_snapshot with a screenshot first and give x and y in its pixels.",
        };
      await click(cdp, action.x * scale, action.y * scale);
      return { ok: true };
    }
    case "type": {
      const node = page.node(action.ref);
      const password = node === null ? null : await isPasswordField(cdp, node);
      if (node === null || password === null) return stale();
      if (password && !action.secret)
        return {
          ok: false,
          reason: "password-field",
          message:
            "That is a password field. Only type a password the user gave you for this site, with sensitive set.",
        };
      const typed = await callOn(cdp, node, TYPE_TEXT, [action.text, action.clear ? 1 : 0]);
      if (!typed) return stale();
      if (typed.value !== "ok")
        return {
          ok: false,
          reason: "not-editable",
          message:
            "That element does not take text. Type into a field from the latest browser_snapshot.",
        };
      if (action.secret) page.typedSecret(node);
      if (action.submit) {
        const submitted = await callOn(cdp, node, SUBMIT_FORM);
        const enter = parseKey("Enter");
        if (submitted?.value !== "submitted" && enter) await pressKey(page, enter);
      }
      return { ok: true };
    }
    case "press": {
      const press = parseKey(action.key);
      if (!press)
        return {
          ok: false,
          reason: "bad-key",
          message: `"${action.key}" is not a key this knows. Use names like Enter, Escape, Tab, ArrowDown, or Control+A.`,
        };
      await pressKey(page, press);
      return { ok: true };
    }
    case "scroll": {
      // The page itself unless a scrollable element is named; never wheel
      // events, which scroll whatever happens to be under the pointer.
      const node = action.ref ? page.node(action.ref) : null;
      if (action.ref && node === null) return stale();
      const result =
        node === null
          ? {
              value: await page.evaluate(
                `(${SCROLL_BY}).call(document.scrollingElement || document.documentElement, ${action.deltaX}, ${action.deltaY})`,
              ),
            }
          : await callOn(cdp, node, SCROLL_BY, [action.deltaX, action.deltaY]);
      if (!result) return stale();
      const [top, max] = Array.isArray(result.value) ? result.value : [];
      return typeof top === "number" && typeof max === "number"
        ? { ok: true, value: `${top} of ${max}` }
        : { ok: true };
    }
    case "select": {
      const node = page.node(action.ref);
      const result = node === null ? null : await callOn(cdp, node, SELECT_OPTION, [action.value]);
      if (!result) return stale();
      if (result.value === "not-select")
        return { ok: false, reason: "not-select", message: "That element is not a dropdown." };
      if (result.value === "no-option")
        return {
          ok: false,
          reason: "no-option",
          message: `The dropdown has no option "${action.value}".`,
        };
      return { ok: true };
    }
    case "evaluate":
      return evaluate(page, action.expression);
  }
}
