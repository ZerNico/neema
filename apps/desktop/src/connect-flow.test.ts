import { describe, expect, it, vi } from "vitest";
import { makeConnectFlow } from "./connect-flow.ts";

const host = (
  overrides: Partial<{
    fixedServer: () => boolean;
    hasMain: () => boolean;
    hasWork: () => boolean;
    currentOrigin: () => string | null;
  }> = {},
) => {
  const chooser = { focus: vi.fn(() => {}), destroy: vi.fn(() => {}) };
  const effects = {
    fixedServer: () => false,
    hasMain: () => true,
    hasWork: () => false,
    currentOrigin: () => "https://chat.example.com",
    ...overrides,
    confirmSwitch: vi.fn(async () => true),
    disposeWork: vi.fn(async () => {}),
    writeConfig: vi.fn(async (_origin: string) => {}),
    chooser: vi.fn((): typeof chooser | null => null),
    openConnect: vi.fn((_current: string | null) => {}),
    openMain: vi.fn((_origin: string) => {}),
    closeMain: vi.fn(() => {}),
  };
  return { effects, chooser };
};

describe("server chooser", () => {
  it("opens the chooser prefilled with the current origin when nothing is running", async () => {
    const { effects } = host();
    await expect(makeConnectFlow(effects).openChooser()).resolves.toEqual({ ok: true });
    expect(effects.confirmSwitch).not.toHaveBeenCalled();
    expect(effects.disposeWork).not.toHaveBeenCalled();
    expect(effects.openConnect).toHaveBeenCalledExactlyOnceWith("https://chat.example.com");
  });

  it("leaves Work running if the chooser is cancelled", async () => {
    const { effects } = host({ hasWork: () => true });
    const flow = makeConnectFlow(effects);
    await flow.openChooser();
    expect(effects.openConnect).toHaveBeenCalledExactlyOnceWith("https://chat.example.com");
    expect(effects.confirmSwitch).not.toHaveBeenCalled();
    expect(effects.disposeWork).not.toHaveBeenCalled();
  });

  it("does not ask on first run, when no main window exists", async () => {
    const { effects } = host({
      hasMain: () => false,
      hasWork: () => true,
      currentOrigin: () => null,
    });
    await makeConnectFlow(effects).openChooser();
    expect(effects.confirmSwitch).not.toHaveBeenCalled();
    expect(effects.openConnect).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("focuses an open chooser instead of opening a second one", async () => {
    const { effects, chooser } = host();
    effects.chooser.mockReturnValue(chooser);
    await makeConnectFlow(effects).openChooser();
    expect(chooser.focus).toHaveBeenCalledOnce();
    expect(effects.openConnect).not.toHaveBeenCalled();
  });

  it("coalesces competing accepted switches while confirmation is open", async () => {
    const { effects } = host({ hasWork: () => true });
    const answer = Promise.withResolvers<boolean>();
    effects.confirmSwitch.mockReturnValue(answer.promise);
    const flow = makeConnectFlow(effects);
    const first = flow.connect("https://other.example.com");
    const second = flow.connect("https://different.example.com");
    expect(second).toBe(first);
    answer.resolve(true);
    await first;
    expect(effects.confirmSwitch).toHaveBeenCalledOnce();
    expect(effects.writeConfig).toHaveBeenCalledExactlyOnceWith("https://other.example.com");
  });

  it("refuses to open or connect while CHAT_DESKTOP_SERVER pins the server", async () => {
    const { effects } = host({ fixedServer: () => true });
    const flow = makeConnectFlow(effects);
    const refusal = { ok: false, message: "The server is fixed by CHAT_DESKTOP_SERVER." };
    await expect(flow.openChooser()).resolves.toEqual(refusal);
    await expect(flow.connect("https://other.example.com")).resolves.toEqual(refusal);
    expect(effects.openConnect).not.toHaveBeenCalled();
    expect(effects.writeConfig).not.toHaveBeenCalled();
  });
});

describe("connecting", () => {
  it("rejects anything that is not a server address before touching config", async () => {
    const { effects } = host();
    const flow = makeConnectFlow(effects);
    const outcomes = await Promise.all(
      ["", "file:///etc/passwd", 42, null].map((candidate) => flow.connect(candidate)),
    );
    for (const outcome of outcomes)
      expect(outcome).toEqual({ ok: false, message: "That does not look like a server address." });
    expect(effects.writeConfig).not.toHaveBeenCalled();
    expect(effects.openMain).not.toHaveBeenCalled();
  });

  it("writes the origin, replaces the main window and destroys the chooser", async () => {
    const { effects, chooser } = host();
    effects.chooser.mockReturnValue(chooser);
    await expect(makeConnectFlow(effects).connect("other.example.com")).resolves.toEqual({
      ok: true,
    });
    expect(effects.writeConfig).toHaveBeenCalledExactlyOnceWith("https://other.example.com");
    expect(effects.disposeWork).toHaveBeenCalledOnce();
    expect(effects.closeMain).toHaveBeenCalledOnce();
    expect(effects.openMain).toHaveBeenCalledExactlyOnceWith("https://other.example.com");
    expect(chooser.destroy).toHaveBeenCalledOnce();
    expect(effects.closeMain.mock.invocationCallOrder[0]).toBeLessThan(
      effects.openMain.mock.invocationCallOrder[0]!,
    );
  });

  it("opens the first main window on first run without closing anything", async () => {
    const { effects, chooser } = host({ hasMain: () => false });
    effects.chooser.mockReturnValue(chooser);
    await makeConnectFlow(effects).connect("https://chat.example.com/path?q=1");
    expect(effects.disposeWork).not.toHaveBeenCalled();
    expect(effects.closeMain).not.toHaveBeenCalled();
    expect(effects.openMain).toHaveBeenCalledExactlyOnceWith("https://chat.example.com");
    expect(chooser.destroy).toHaveBeenCalledOnce();
  });

  it("asks if Work starts while the chooser is open", async () => {
    let running = false;
    const { effects } = host({ hasWork: () => running });
    const flow = makeConnectFlow(effects);
    await flow.openChooser();
    running = true;
    effects.confirmSwitch.mockResolvedValueOnce(false);
    await expect(flow.connect("https://other.example.com")).resolves.toEqual({
      ok: true,
      declined: true,
    });
    expect(effects.disposeWork).not.toHaveBeenCalled();
    expect(effects.writeConfig).not.toHaveBeenCalled();
  });

  it("keeps Work when the selected server is already current", async () => {
    const { effects, chooser } = host({ hasWork: () => true });
    effects.chooser.mockReturnValue(chooser);
    await expect(makeConnectFlow(effects).connect("https://chat.example.com")).resolves.toEqual({
      ok: true,
    });
    expect(effects.confirmSwitch).not.toHaveBeenCalled();
    expect(effects.disposeWork).not.toHaveBeenCalled();
    expect(chooser.destroy).toHaveBeenCalledOnce();
  });

  it("asks before connect tears down work, even if the chooser is already open", async () => {
    const { effects, chooser } = host({ hasWork: () => true });
    effects.chooser.mockReturnValue(chooser);
    effects.confirmSwitch.mockResolvedValueOnce(false);
    const flow = makeConnectFlow(effects);
    await expect(flow.connect("https://other.example.com")).resolves.toEqual({
      ok: true,
      declined: true,
    });
    expect(effects.confirmSwitch).toHaveBeenCalledOnce();
    expect(effects.writeConfig).not.toHaveBeenCalled();
    expect(effects.disposeWork).not.toHaveBeenCalled();
    expect(effects.openMain).not.toHaveBeenCalled();
    effects.confirmSwitch.mockResolvedValueOnce(true);
    await expect(flow.connect("https://other.example.com")).resolves.toEqual({ ok: true });
    expect(effects.writeConfig).toHaveBeenCalledExactlyOnceWith("https://other.example.com");
    expect(effects.disposeWork).toHaveBeenCalledOnce();
    expect(effects.openMain).toHaveBeenCalledExactlyOnceWith("https://other.example.com");
  });
});
