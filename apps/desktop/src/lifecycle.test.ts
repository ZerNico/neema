import { describe, expect, it, vi } from "vitest";
import { makeLifecycle } from "./lifecycle.ts";

const host = () => ({
  hide: vi.fn(),
  hasWork: () => true,
  confirmQuit: vi.fn(async () => true),
  dispose: vi.fn(async () => {}),
  quit: vi.fn(),
  reportError: vi.fn(),
});

describe("desktop lifetime", () => {
  it("closing hides the window without stopping work", () => {
    const effects = host();
    const lifecycle = makeLifecycle(effects);
    const event = { preventDefault: vi.fn() };
    lifecycle.close(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(effects.hide).toHaveBeenCalledOnce();
    expect(effects.dispose).not.toHaveBeenCalled();
    expect(effects.quit).not.toHaveBeenCalled();
  });

  it("lets the user decline quitting active work", async () => {
    const effects = host();
    effects.confirmQuit.mockResolvedValue(false);
    const lifecycle = makeLifecycle(effects);
    await lifecycle.beforeQuit({ preventDefault: vi.fn() });
    expect(effects.dispose).not.toHaveBeenCalled();
    expect(effects.quit).not.toHaveBeenCalled();
  });

  it("coalesces quit requests and awaits disposal before exiting", async () => {
    const effects = host();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    effects.dispose.mockImplementation(() => {
      started.resolve();
      return finish.promise;
    });
    const lifecycle = makeLifecycle(effects);
    const event = { preventDefault: vi.fn() };
    const first = lifecycle.beforeQuit(event);
    await started.promise;
    const second = lifecycle.beforeQuit(event);
    expect(second).toBe(first);
    expect(effects.quit).not.toHaveBeenCalled();
    finish.resolve();
    await first;
    expect(effects.confirmQuit).toHaveBeenCalledOnce();
    expect(effects.dispose).toHaveBeenCalledOnce();
    expect(effects.quit).toHaveBeenCalledOnce();
    event.preventDefault.mockClear();
    lifecycle.beforeQuit(event);
    lifecycle.close(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("development restart skips confirmation but still awaits owned cleanup", async () => {
    const effects = host();
    const finish = Promise.withResolvers<void>();
    effects.dispose.mockReturnValue(finish.promise);
    const lifecycle = makeLifecycle(effects);
    const restarting = lifecycle.beforeQuit({ preventDefault: vi.fn() }, { confirm: false });
    expect(effects.confirmQuit).not.toHaveBeenCalled();
    expect(effects.dispose).toHaveBeenCalledOnce();
    expect(effects.quit).not.toHaveBeenCalled();
    finish.resolve();
    await restarting;
    expect(effects.quit).toHaveBeenCalledOnce();
  });

  it("does not silently exit when cleanup fails", async () => {
    const effects = host();
    effects.dispose.mockRejectedValue(new Error("cleanup failed"));
    await makeLifecycle(effects).beforeQuit({ preventDefault: vi.fn() });
    expect(effects.reportError).toHaveBeenCalledOnce();
    expect(effects.quit).not.toHaveBeenCalled();
  });
});
