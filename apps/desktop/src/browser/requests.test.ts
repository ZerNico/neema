import { expect, it } from "vitest";
import {
  decodeAct,
  decodeAction,
  decodeDrive,
  decodeLifecycle,
  decodeSite,
  decodeSiteGrant,
  decodeSnapshot,
  decodeWaitFor,
} from "./requests.ts";

it("passes well-formed actions through, keeping only known fields", () => {
  expect(decodeAction({ kind: "click", callId: "c", ref: "e1", extra: 1 })).toEqual({
    kind: "click",
    callId: "c",
    ref: "e1",
  });
  expect(
    decodeAction({ kind: "type", callId: "c", ref: "e2", text: "hi", submit: true, secret: "yes" }),
  ).toEqual({
    kind: "type",
    callId: "c",
    ref: "e2",
    text: "hi",
    clear: false,
    submit: true,
    secret: false,
  });
  expect(decodeAction({ kind: "scroll", callId: "c", deltaY: 1e9, deltaX: "1" })).toEqual({
    kind: "scroll",
    callId: "c",
    deltaX: 0,
    deltaY: 100_000,
  });
  // Scrolling nowhere is no action.
  expect(decodeAction({ kind: "scroll", callId: "c", direction: "down" })).toBeNull();
});

it("refuses anything malformed rather than guessing", () => {
  for (const input of [
    null,
    { kind: "click" },
    { kind: "type", callId: "c", ref: "e1" },
    { kind: "evaluate", callId: "c", expression: "" },
    { kind: "navigate", callId: "c" },
  ])
    expect(decodeAction(input)).toBeNull();
  // A coordinate that is not a real number is dropped, not passed to the page.
  expect(decodeAction({ kind: "click", callId: "c", x: Number.NaN, y: 4 })).toEqual({
    kind: "click",
    callId: "c",
    y: 4,
  });
});

it("decodes the page's other requests, refusing what main could not use", () => {
  expect(decodeLifecycle({ webContentsId: 3, state: "frozen" })).toEqual({
    webContentsId: 3,
    state: "frozen",
  });
  expect(() => decodeLifecycle({ webContentsId: 3, state: "discarded" })).toThrow("state");
  expect(() => decodeSnapshot({ webContentsId: "3" })).toThrow("tab");
  expect(decodeWaitFor({ webContentsId: 1, callId: "c", text: "Done" })).toEqual({
    webContentsId: 1,
    callId: "c",
    condition: { text: "Done", timeoutMs: 0 },
  });
  expect(() => decodeWaitFor({ webContentsId: 1, callId: "c", text: "x".repeat(5000) })).toThrow(
    "text",
  );
  expect(decodeDrive({ webContentsId: 1, callId: "c", driving: null })).toEqual({
    webContentsId: 1,
    callId: "c",
    driving: null,
  });
  expect(
    decodeDrive({
      webContentsId: 1,
      callId: "c",
      driving: { conversationId: "c", allow: ["https://a.test"] },
    }),
  ).toEqual({
    webContentsId: 1,
    callId: "c",
    driving: { conversationId: "c", allow: ["https://a.test"] },
  });
  expect(() => decodeDrive({ webContentsId: 1, callId: "c", driving: { allow: [] } })).toThrow(
    "chat",
  );
  expect(() => decodeSnapshot({ webContentsId: 1 })).toThrow("call");
  expect(() => decodeAct({ webContentsId: 1, action: { kind: "click" } })).toThrow("action");
  const action = { kind: "evaluate", callId: "stable", expression: "1" };
  expect(() => decodeAct({ webContentsId: 1, action })).toThrow("call");
  expect(decodeAct({ webContentsId: 1, action, callId: "execution" })).toEqual({
    webContentsId: 1,
    action,
    callId: "execution",
  });
  expect(() =>
    decodeSiteGrant({ conversationId: "c", url: "https://a.test", scope: "forever" }),
  ).toThrow("scope");
  expect(() => decodeSite(42)).toThrow("site");
});
