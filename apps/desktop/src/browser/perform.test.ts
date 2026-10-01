import { afterEach, describe, expect, it, vi } from "vitest";
import { perform, type ActingPage } from "./perform.ts";

// An answer that never comes, as from a page whose thread is busy.
const NEVER = Symbol("never");

// A guest's protocol: records every command and answers from a table.
const page = (
  answers: Record<string, unknown> = {},
  overrides: Partial<ActingPage> = {},
): ActingPage & { sent: Array<[string, Record<string, unknown> | undefined]> } => {
  const sent: Array<[string, Record<string, unknown> | undefined]> = [];
  return {
    sent,
    cdp: {
      send: async <T>(method: string, params?: Record<string, unknown>) => {
        sent.push([method, params]);
        const answer = answers[method];
        if (answer instanceof Error) throw answer;
        if (answer === NEVER) return new Promise<T>(() => {});
        // An answer may depend on what was sent, as callFunctionOn's does on the code.
        return (typeof answer === "function" ? answer(params) : answer) as T;
      },
    },
    evaluate: async () => undefined,
    node: (ref) => (ref === "e1" ? 41 : null),
    screenshotScale: undefined,
    typedSecret: vi.fn(),
    ...overrides,
  };
};

// A field that answers typing with `value`, and a submit with "submitted".
const answer = (value: string) => ({
  "DOM.describeNode": { node: { attributes: [] } },
  "DOM.resolveNode": { object: { objectId: "o1" } },
  "Runtime.callFunctionOn": (params: { functionDeclaration: string }) => ({
    result: {
      value: params.functionDeclaration.includes("requestSubmit") ? "submitted" : value,
    },
  }),
});

const BOX = { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } };
const methods = (target: ReturnType<typeof page>) => target.sent.map(([method]) => method);

afterEach(() => {
  vi.useRealTimers();
});

describe("perform", () => {
  it("clicks the centre of a referenced node, and only a node the outline named", async () => {
    const target = page({ "DOM.getBoxModel": BOX });
    expect(await perform(target, { kind: "click", callId: "c", ref: "e1" })).toEqual({ ok: true });
    expect(target.sent.filter(([method]) => method === "Input.dispatchMouseEvent")).toEqual([
      ["Input.dispatchMouseEvent", { type: "mouseMoved", x: 20, y: 30 }],
      ["Input.dispatchMouseEvent", expect.objectContaining({ type: "mousePressed", x: 20, y: 30 })],
      ["Input.dispatchMouseEvent", expect.objectContaining({ type: "mouseReleased" })],
    ]);
    expect(await perform(page(), { kind: "click", callId: "c", ref: "e9" })).toMatchObject({
      reason: "stale-ref",
    });
  });

  it("clicks screenshot pixels only after a screenshot, scaled to the page", async () => {
    expect(await perform(page(), { kind: "click", callId: "c", x: 5, y: 5 })).toMatchObject({
      reason: "no-screenshot",
    });
    const target = page({}, { screenshotScale: 2 });
    await perform(target, { kind: "click", callId: "c", x: 5, y: 7 });
    expect(target.sent[0]).toEqual([
      "Input.dispatchMouseEvent",
      { type: "mouseMoved", x: 10, y: 14 },
    ]);
  });

  it("refuses to type into a password field unless the text is marked secret", async () => {
    const password = { "DOM.describeNode": { node: { attributes: ["type", "password"] } } };
    const refused = page(password);
    expect(
      await perform(refused, {
        kind: "type",
        callId: "c",
        ref: "e1",
        text: "x",
        clear: false,
        submit: false,
        secret: false,
      }),
    ).toMatchObject({ reason: "password-field" });
    expect(methods(refused)).not.toContain("Input.insertText");

    const code: string[] = [];
    const typed = page(
      {
        ...password,
        "DOM.resolveNode": { object: { objectId: "o1" } },
        // Typing succeeds; the field is in no form, so Enter submits.
        "Runtime.callFunctionOn": (params: { functionDeclaration: string }) => ({
          result: {
            value: params.functionDeclaration.includes("requestSubmit") ? "no-form" : "ok",
          },
        }),
      },
      { evaluate: async (expression) => (code.push(expression), true) },
    );
    expect(
      await perform(typed, {
        kind: "type",
        callId: "c",
        ref: "e1",
        text: "hunter2",
        clear: true,
        submit: true,
        secret: true,
      }),
    ).toEqual({ ok: true });
    // Typed through the page's own editing, with the text as an argument: the
    // protocol's insertText drops text in a guest Electron has not activated.
    expect(methods(typed)).toEqual([
      "DOM.describeNode",
      "DOM.resolveNode",
      "Runtime.callFunctionOn",
      "DOM.resolveNode",
      "Runtime.callFunctionOn",
    ]);
    // Without a form, Enter is pressed inside the page: the protocol's keyboard
    // goes wherever the window's focus is, which can be the app's message box.
    expect(code).toHaveLength(1);
    expect(code[0]).toContain('"key":"Enter"');
    expect(typed.sent[2]?.[1]?.arguments).toEqual([{ value: "hunter2" }, { value: 1 }]);
    expect(typed.sent[2]?.[1]?.functionDeclaration).toContain('execCommand("insertText"');
    // Later outlines mask the field the secret went into.
    expect(typed.typedSecret).toHaveBeenCalledWith(41);
  });

  it("says when an element takes no text, and submits a field's form rather than pressing Enter", async () => {
    const type = {
      kind: "type",
      callId: "c",
      ref: "e1",
      text: "x",
      clear: false,
      secret: false,
    } as const;
    expect(await perform(page(answer("not-editable")), { ...type, submit: false })).toMatchObject({
      reason: "not-editable",
    });
    const form = page(answer("ok"));
    expect(await perform(form, { ...type, submit: true })).toEqual({ ok: true });
    expect(methods(form)).not.toContain("Input.dispatchKeyEvent");
  });

  it("never uses the protocol's keyboard, whose input can land outside the page", async () => {
    const code: string[] = [];
    const target = page({}, { evaluate: async (expression) => (code.push(expression), true) });
    expect(await perform(target, { kind: "press", callId: "c", key: "Control+a" })).toEqual({
      ok: true,
    });
    expect(methods(target)).toEqual([]);
    expect(code[0]).toContain('"key":"a"');
  });

  it("knows a password field whatever the case of its type", async () => {
    const shouting = page({ "DOM.describeNode": { node: { attributes: ["type", "PASSWORD"] } } });
    expect(
      await perform(shouting, {
        kind: "type",
        callId: "c",
        ref: "e1",
        text: "x",
        clear: false,
        submit: false,
        secret: false,
      }),
    ).toMatchObject({ reason: "password-field" });
  });

  it("reports a node that is gone as stale rather than failing", async () => {
    const gone = page({ "DOM.describeNode": new Error("No node") });
    expect(
      await perform(gone, {
        kind: "type",
        callId: "c",
        ref: "e1",
        text: "x",
        clear: false,
        submit: false,
        secret: false,
      }),
    ).toMatchObject({ reason: "stale-ref" });
    expect(
      await perform(page({ "DOM.resolveNode": new Error("No node") }), {
        kind: "scroll",
        callId: "c",
        deltaX: 0,
        deltaY: 300,
        ref: "e1",
      }),
    ).toMatchObject({ reason: "stale-ref" });
  });

  it("scrolls the page or a named element by pixels, and says where it ended up", async () => {
    const code: string[] = [];
    const scrolled = page(
      {},
      { evaluate: async (expression) => (code.push(expression), [800, 4000]) },
    );
    expect(
      await perform(scrolled, { kind: "scroll", callId: "c", deltaX: 0, deltaY: 800 }),
    ).toEqual({ ok: true, value: "800 of 4000" });
    expect(code[0]).toContain(", 0, 800)");
    // No wheel events: they would scroll whatever is under the pointer.
    expect(methods(scrolled)).not.toContain("Input.dispatchMouseEvent");

    const list = page({
      "DOM.resolveNode": { object: { objectId: "o1" } },
      "Runtime.callFunctionOn": { result: { value: [300, 900] } },
    });
    expect(
      await perform(list, { kind: "scroll", callId: "c", deltaX: 0, deltaY: 300, ref: "e1" }),
    ).toEqual({ ok: true, value: "300 of 900" });
    const call = list.sent.find(([method]) => method === "Runtime.callFunctionOn")?.[1];
    expect(call?.arguments).toEqual([{ value: 0 }, { value: 300 }]);
  });

  it("chooses an option by passing the value as an argument, never as code", async () => {
    const target = page({
      "DOM.resolveNode": { object: { objectId: "o1" } },
      "Runtime.callFunctionOn": { result: { value: "no-option" } },
    });
    const value = '"); alert(1); ("';
    expect(await perform(target, { kind: "select", callId: "c", ref: "e1", value })).toMatchObject({
      reason: "no-option",
    });
    const call = target.sent.find(([method]) => method === "Runtime.callFunctionOn")?.[1];
    expect(call?.arguments).toEqual([{ value }]);
    expect(call?.functionDeclaration).not.toContain("alert");
  });

  it("returns what code read as capped JSON, and ends code that runs too long", async () => {
    const long = page({}, { evaluate: async () => ({ text: "x".repeat(30_000) }) });
    const read = await perform(long, { kind: "evaluate", callId: "c", expression: "1" });
    expect(read).toMatchObject({ ok: true, truncated: true });
    expect(read.ok && read.value?.length).toBe(20_000);

    vi.useFakeTimers();
    // A loop holds the page's thread, so a trivial probe gets no answer: ended.
    const looping = page({ "Runtime.evaluate": NEVER }, { evaluate: () => new Promise(() => {}) });
    const pending = perform(looping, { kind: "evaluate", callId: "c", expression: "for(;;){}" });
    await vi.advanceTimersByTimeAsync(10_500);
    expect(await pending).toMatchObject({ ok: false, reason: "script-error" });
    expect(methods(looping)).toEqual(["Runtime.evaluate", "Runtime.terminateExecution"]);

    // Code waiting on a promise leaves the page free; terminating then would
    // kill the page's own next script instead.
    const waiting = page({ "Runtime.evaluate": {} }, { evaluate: () => new Promise(() => {}) });
    const idle = perform(waiting, {
      kind: "evaluate",
      callId: "c",
      expression: "new Promise(() => {})",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await idle).toMatchObject({ ok: false, reason: "script-error" });
    expect(methods(waiting)).toEqual(["Runtime.evaluate"]);
  });
});
