import { ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { DEV_RESTART, makeDevReloader } from "./dev-reloader.ts";

afterEach(() => vi.useRealTimers());

it("waits for the old process to finish cleanup before launching its replacement", async () => {
  const children: ChildProcess[] = [];
  const host = {
    spawn: vi.fn(() => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          `
        process.on('message', message => {
          if (message === ${JSON.stringify(DEV_RESTART)}) process.send('cleaning');
          if (message === 'finish') process.exit(0);
        });
      `,
        ],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
      children.push(child);
      return child;
    }),
    quit: vi.fn(),
    reportError: vi.fn(),
  };
  const reloader = makeDevReloader(host);
  try {
    await reloader.restart();
    const first = children[0]!;
    const cleaning = once(first, "message");
    const restarted = reloader.restart();
    expect(await cleaning).toEqual(["cleaning", undefined]);
    expect(host.spawn).toHaveBeenCalledTimes(1);
    first.send("finish");
    await restarted;
    expect(first.exitCode).toBe(0);
    expect(host.spawn).toHaveBeenCalledTimes(2);
    expect(host.quit).not.toHaveBeenCalled();
    const second = children[1]!;
    const closing = once(second, "message");
    const stopped = reloader.stop();
    await closing;
    second.send("finish");
    await stopped;
    expect(second.exitCode).toBe(0);
    expect(host.reportError).not.toHaveBeenCalled();
  } finally {
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const closed = once(child, "close");
        child.kill("SIGKILL");
        await closed;
      }),
    );
  }
});

function fixture() {
  const children: ChildProcess[] = [];
  const host = {
    spawn: vi.fn(() => {
      const child = new ChildProcess();
      Object.defineProperty(child, "connected", { value: true });
      child.send = vi.fn(() => true);
      vi.spyOn(child, "kill").mockReturnValue(true);
      children.push(child);
      return child;
    }),
    quit: vi.fn(),
    reportError: vi.fn(),
  };
  return { host, children, reloader: makeDevReloader(host) };
}

it("escalates only the owned process and still waits for its close event", async () => {
  vi.useFakeTimers();
  const { host, children, reloader } = fixture();
  await reloader.restart();
  const restarted = reloader.restart();
  await vi.advanceTimersByTimeAsync(0);
  const first = children[0]!;
  expect(first.send).toHaveBeenCalledWith(DEV_RESTART, expect.any(Function));
  expect(first.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10000);
  expect(first.kill).toHaveBeenCalledWith("SIGKILL");
  expect(host.spawn).toHaveBeenCalledTimes(1);
  first.emit("close", null, "SIGKILL");
  await restarted;
  expect(host.spawn).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("refuses to launch another instance when the old process cannot be stopped", async () => {
  vi.useFakeTimers();
  const { host, reloader } = fixture();
  await reloader.restart();
  const result = expect(reloader.restart()).rejects.toThrow("refusing to launch another");
  await vi.advanceTimersByTimeAsync(15000);
  await result;
  expect(host.spawn).toHaveBeenCalledTimes(1);
});

it("shutdown during a rebuild prevents the queued replacement from starting", async () => {
  vi.useFakeTimers();
  const { host, children, reloader } = fixture();
  await reloader.restart();
  const restarted = reloader.restart();
  await vi.advanceTimersByTimeAsync(0);
  const stopped = reloader.stop();
  children[0]!.emit("close", 0, null);
  await Promise.all([restarted, stopped]);
  expect(host.spawn).toHaveBeenCalledTimes(1);
  expect(host.quit).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("a normal Quit stops the dev loop, unlike a crash or replacement", async () => {
  const { host, children, reloader } = fixture();
  await reloader.restart();
  children[0]!.emit("exit", 1, null);
  expect(host.quit).not.toHaveBeenCalled();
  const other = fixture();
  await other.reloader.restart();
  other.children[0]!.emit("exit", 0, null);
  expect(other.host.quit).toHaveBeenCalledOnce();
});
