import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { attachLoadRecovery } from "./load-recovery.ts";

const origin = "https://chat.example.com";
const recoveryFile = "/app/static/recovery.html";
const fixture = () => {
  const navigation = Promise.withResolvers<void>();
  const localLoad = Promise.withResolvers<void>();
  const window = {
    isDestroyed: vi.fn(() => false),
    loadURL: vi.fn(() => navigation.promise),
    loadFile: vi.fn(() => localLoad.promise),
    webContents: new EventEmitter(),
  };
  const reportError = vi.fn();
  const recovery = attachLoadRecovery(window, origin, recoveryFile, reportError);
  return { window, navigation, localLoad, recovery, reportError };
};

describe("initial document recovery", () => {
  it("handles rejected loads and retries only the configured origin", async () => {
    const { window, navigation, localLoad, recovery } = fixture();
    const initial = recovery.retry();
    navigation.reject(new Error("ERR_CONNECTION_REFUSED"));
    localLoad.resolve();
    await initial;
    expect(window.loadFile).toHaveBeenCalledExactlyOnceWith(recoveryFile);
    window.loadURL.mockResolvedValueOnce();
    await recovery.retry();
    expect(window.loadURL.mock.calls).toEqual([[origin], [origin]]);
    await recovery.retry();
    expect(window.loadURL).toHaveBeenCalledTimes(2);
  });

  it("recovers from a main-frame failure event only once despite the rejected promise", async () => {
    const { window, navigation, localLoad, recovery } = fixture();
    const initial = recovery.retry();
    window.webContents.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", origin, true);
    expect(window.loadFile).toHaveBeenCalledExactlyOnceWith(recoveryFile);
    navigation.reject({ errno: -102 });
    localLoad.resolve();
    await initial;
    expect(window.loadFile).toHaveBeenCalledTimes(1);
  });

  it("ignores aborted, subframe and unrelated-origin failures", async () => {
    const { window, navigation, recovery } = fixture();
    const initial = recovery.retry();
    window.webContents.emit("did-fail-load", {}, -3, "ERR_ABORTED", origin, true);
    window.webContents.emit("did-fail-load", {}, -102, "failed", origin, false);
    window.webContents.emit("did-fail-load", {}, -102, "failed", "https://other.example.com", true);
    window.webContents.emit("did-fail-load", {}, -102, "failed", "invalid URL", true);
    expect(window.loadFile).not.toHaveBeenCalled();
    navigation.resolve();
    await initial;
    expect(window.loadFile).not.toHaveBeenCalled();
  });

  it.each([{ errno: -3 }, { code: "ERR_ABORTED" }])(
    "ignores an aborted load promise %j",
    async (cause) => {
      const { window, navigation, recovery } = fixture();
      const initial = recovery.retry();
      navigation.reject(cause);
      await initial;
      expect(window.loadFile).not.toHaveBeenCalled();
    },
  );

  it("never replaces a healthy Work renderer on later navigation or background failure", async () => {
    const { window, navigation, recovery } = fixture();
    const initial = recovery.retry();
    navigation.resolve();
    await initial;
    window.webContents.emit("did-fail-load", {}, -102, "failed", `${origin}/api/work`, false);
    window.webContents.emit("did-fail-load", {}, -102, "failed", `${origin}/chat`, true);
    await recovery.retry();
    expect(window.loadFile).not.toHaveBeenCalled();
    expect(window.loadURL).toHaveBeenCalledTimes(1);
  });

  it("serializes retries and ignores the old attempt after recovery starts", async () => {
    const { window, navigation, localLoad, recovery } = fixture();
    const initial = recovery.retry();
    await recovery.retry();
    expect(window.loadURL).toHaveBeenCalledTimes(1);
    window.webContents.emit("did-fail-load", {}, -102, "failed", origin, true);
    localLoad.resolve();
    window.loadURL.mockResolvedValueOnce();
    await recovery.retry();
    navigation.reject(new Error("late failure"));
    await initial;
    expect(window.loadFile).toHaveBeenCalledTimes(1);
    expect(window.loadURL).toHaveBeenCalledTimes(2);
  });

  it("reports a missing local page without an unhandled rejection", async () => {
    const { navigation, localLoad, recovery, reportError } = fixture();
    const initial = recovery.retry();
    navigation.reject(new Error("offline"));
    const cause = new Error("missing recovery file");
    localLoad.reject(cause);
    await initial;
    expect(reportError).toHaveBeenCalledExactlyOnceWith(cause);
  });

  it("does not navigate a destroyed window", async () => {
    const { window, recovery } = fixture();
    window.isDestroyed.mockReturnValue(true);
    await recovery.retry();
    expect(window.loadURL).not.toHaveBeenCalled();
    expect(window.loadFile).not.toHaveBeenCalled();
  });
});
