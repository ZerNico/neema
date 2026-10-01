import type { BrowserAction, BrowserLifecycle } from "@chat/desktop-rpc";

const MAX_TEXT = 100_000;

const text = (value: unknown, max = 4096) =>
  typeof value === "string" && value.length <= max ? value : null;
const coordinate = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100_000
    ? value
    : undefined;

// Every request from the page is decoded here rather than trusted: the page is
// the configured server's, but a value that reaches the guests or the grant
// file must still be the shape main expects.

const LIFECYCLES: ReadonlyArray<BrowserLifecycle> = ["active", "background", "frozen"];
const SCOPES = ["chat", "always"] as const;

const record = (payload: unknown): Record<string, unknown> =>
  typeof payload === "object" && payload !== null ? { ...payload } : {};

const required = (value: unknown, label: string) => {
  const decoded = text(value);
  if (decoded === null) throw new Error(`Invalid ${label}.`);
  return decoded;
};

const tab = (input: Record<string, unknown>) => {
  if (typeof input.webContentsId !== "number") throw new Error("Invalid browser tab.");
  return input.webContentsId;
};

export function decodeLifecycle(payload: unknown) {
  const input = record(payload);
  const state = LIFECYCLES.find((known) => known === input.state);
  if (!state) throw new Error("Invalid browser tab state.");
  return { webContentsId: tab(input), state };
}

export function decodeSnapshot(payload: unknown) {
  const input = record(payload);
  return { webContentsId: tab(input), screenshot: input.screenshot === true };
}

export function decodeWaitFor(payload: unknown) {
  const input = record(payload);
  return {
    webContentsId: tab(input),
    condition: {
      ...(input.text === undefined ? {} : { text: required(input.text, "text") }),
      ...(input.urlIncludes === undefined
        ? {}
        : { urlIncludes: required(input.urlIncludes, "address") }),
      timeoutMs: typeof input.timeoutMs === "number" ? input.timeoutMs : 0,
    },
  };
}

export function decodeAct(payload: unknown) {
  const input = record(payload);
  const action = decodeAction(input.action);
  if (!action) throw new Error("Invalid browser action.");
  return { webContentsId: tab(input), action };
}

const SAVE_MAX = 50;

export function decodeSave(payload: unknown) {
  const input = record(payload);
  const urls = Array.isArray(input.urls) ? input.urls : [];
  if (urls.length === 0 || urls.length > SAVE_MAX) throw new Error("Invalid file list.");
  return {
    webContentsId: tab(input),
    urls: urls.map((url) => {
      const address = required(url, "address");
      if (!/^https?:\/\//i.test(address)) throw new Error("Invalid address.");
      return address;
    }),
  };
}

export function decodeDrive(payload: unknown) {
  const input = record(payload);
  const driving = record(input.driving);
  return {
    webContentsId: tab(input),
    driving:
      input.driving === null
        ? null
        : {
            conversationId: required(driving.conversationId, "chat"),
            allow: Array.isArray(driving.allow)
              ? driving.allow.map((url) => required(url, "address"))
              : [],
          },
  };
}

export function decodeSiteCheck(payload: unknown) {
  const input = record(payload);
  return {
    conversationId: required(input.conversationId, "chat"),
    url: required(input.url, "address"),
  };
}

export function decodeSiteGrant(payload: unknown) {
  const input = record(payload);
  const scope = SCOPES.find((known) => known === input.scope);
  if (!scope) throw new Error("Invalid scope.");
  return { ...decodeSiteCheck(input), scope };
}

export const decodeSite = (value: unknown) => required(value, "site");

// A scroll distance in pixels, finite and bounded; anything else is none.
const distance = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(-100_000, Math.min(100_000, value))
    : 0;

/** Decodes an action sent by the page; null refuses it. */
export function decodeAction(input: unknown): BrowserAction | null {
  if (typeof input !== "object" || input === null) return null;
  const raw = input as Record<string, unknown>;
  const callId = text(raw.callId, 200);
  if (!callId) return null;
  switch (raw.kind) {
    case "click": {
      const ref = text(raw.ref, 32);
      const x = coordinate(raw.x);
      const y = coordinate(raw.y);
      return {
        kind: "click",
        callId,
        ...(ref ? { ref } : {}),
        ...(x === undefined ? {} : { x }),
        ...(y === undefined ? {} : { y }),
      };
    }
    case "type": {
      const ref = text(raw.ref, 32);
      const typed = text(raw.text, MAX_TEXT);
      if (!ref || typed === null) return null;
      return {
        kind: "type",
        callId,
        ref,
        text: typed,
        clear: raw.clear === true,
        submit: raw.submit === true,
        secret: raw.secret === true,
      };
    }
    case "press": {
      const key = text(raw.key, 64);
      return key ? { kind: "press", callId, key } : null;
    }
    case "scroll": {
      const ref = text(raw.ref, 32);
      const deltaX = distance(raw.deltaX);
      const deltaY = distance(raw.deltaY);
      if (deltaX === 0 && deltaY === 0) return null;
      return { kind: "scroll", callId, deltaX, deltaY, ...(ref ? { ref } : {}) };
    }
    case "select": {
      const ref = text(raw.ref, 32);
      const value = text(raw.value);
      return ref && value !== null ? { kind: "select", callId, ref, value } : null;
    }
    case "evaluate": {
      const expression = text(raw.expression, MAX_TEXT);
      return expression ? { kind: "evaluate", callId, expression } : null;
    }
    default:
      return null;
  }
}
