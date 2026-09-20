import { act, renderHook, waitFor } from "@testing-library/react";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceImports } from "./use-workspace-imports.ts";

// The shell is the unit under test's only collaborator: `desktopClient` and
// the path lookup are replaced, never the hook itself.
const shell = {
  importFile: vi.fn(
    (_input: { conversationId: string; fileName: string; base64: string }) =>
      Effect.succeed({ path: _input.fileName }),
  ),
  importFileFromPath: vi.fn(
    (_input: { conversationId: string; fileName: string; sourcePath: string }) =>
      Effect.succeed({ path: _input.fileName }),
  ),
  discardImport: vi.fn((_input: { conversationId: string; name: string }) =>
    Effect.succeed(undefined),
  ),
};

const lookup = vi.hoisted(() => ({ paths: new Map<File, string>() }));

vi.mock("./bridge.ts", () => ({
  desktopClient: () => shell,
}));

// The preload-side lookup, replaced the same way the shell is.
vi.mock("@chat/desktop-rpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chat/desktop-rpc")>()),
  filePathForFile: (file: File) => lookup.paths.get(file) ?? null,
}));

const file = (name = "notes.txt", size?: number) => {
  const f = new File(["hello"], name, { type: "text/plain" });
  if (size !== undefined) Object.defineProperty(f, "size", { value: size });
  return f;
};

beforeEach(() => {
  shell.importFile.mockClear();
  shell.importFileFromPath.mockClear();
  shell.discardImport.mockClear();
  lookup.paths.clear();
});

describe("useWorkspaceImports", () => {
  it("imports at add time and reports the stored names in order", async () => {
    shell.importFile.mockImplementation((input: { fileName: string }) =>
      Effect.succeed({ path: input.fileName }),
    );
    const { result } = renderHook(() => useWorkspaceImports("chat"));
    act(() => result.current.addFiles([file("a.txt"), file("b.txt")]));

    expect(result.current.importing).toBe(true);
    await waitFor(() => expect(result.current.importing).toBe(false));
    expect(result.current.fileNames).toEqual(["a.txt", "b.txt"]);
    expect(shell.importFile).toHaveBeenCalledTimes(2);
  });

  it("never reads an oversized paste: the chip fails from its size alone", async () => {
    const { result } = renderHook(() => useWorkspaceImports("chat"));
    act(() => result.current.addFiles([file("huge.zip", 60 * 1024 * 1024)]));

    expect(result.current.items[0]?.status).toBe("error");
    expect(result.current.items[0]?.error).toBe("Too large. The limit is 50.0 MB.");
    expect(result.current.hasError).toBe(true);
    expect(shell.importFile).not.toHaveBeenCalled();
  });

  it("copies a dropped file from its path, so the low cap does not apply", async () => {
    const { result } = renderHook(() => useWorkspaceImports("chat"));
    const dropped = file("dump.sql", 60 * 1024 * 1024);
    lookup.paths.set(dropped, "/Users/test/Downloads/dump.sql");
    act(() => result.current.addFiles([dropped]));

    await waitFor(() => expect(result.current.importing).toBe(false));
    // Over the base64 cap, yet no bytes crossed the bridge.
    expect(result.current.fileNames).toEqual(["dump.sql"]);
    expect(shell.importFile).not.toHaveBeenCalled();
    expect(shell.importFileFromPath).toHaveBeenCalledWith({
      conversationId: "chat",
      fileName: "dump.sql",
      sourcePath: "/Users/test/Downloads/dump.sql",
    });
  });

  it("still refuses a drop beyond the path cap", async () => {
    const { result } = renderHook(() => useWorkspaceImports("chat"));
    const dropped = file("disk.img", 600 * 1024 * 1024);
    lookup.paths.set(dropped, "/Users/test/disk.img");
    act(() => result.current.addFiles([dropped]));

    expect(result.current.items[0]?.status).toBe("error");
    expect(result.current.items[0]?.error).toBe("Too large. The limit is 512.0 MB.");
    expect(shell.importFile).not.toHaveBeenCalled();
    expect(shell.importFileFromPath).not.toHaveBeenCalled();
  });

  it("submits immediately when nothing is in flight", async () => {
    const { result } = renderHook(() => useWorkspaceImports("chat"));
    act(() => result.current.addFiles([file("a.txt")]));
    await waitFor(() => expect(result.current.importing).toBe(false));

    const send = vi.fn();
    act(() => result.current.submit(send));
    expect(result.current.queued).toBe(false);
    expect(send).toHaveBeenCalledWith(["a.txt"]);
  });

  it("queues a send until the in-flight import settles", async () => {
    let release!: (value: { path: string }) => void;
    shell.importFile.mockImplementationOnce(
      () =>
        Effect.promise(
          () => new Promise<{ path: string }>((resolve) => (release = resolve)),
        ),
    );
    const { result } = renderHook(() => useWorkspaceImports("chat"));
    act(() => result.current.addFiles([file("a.txt")]));

    const send = vi.fn();
    act(() => result.current.submit(send));
    expect(result.current.queued).toBe(true);
    expect(send).not.toHaveBeenCalled();

    // The base64 read sits between the chip and the RPC, so the deferred is
    // only armed after a few microtasks.
    await waitFor(() => expect(shell.importFile).toHaveBeenCalled());
    await act(async () => {});
    await act(async () => release({ path: "a.txt" }));
    expect(send).toHaveBeenCalledWith(["a.txt"]);
    expect(result.current.queued).toBe(false);
  });

  it("cancels a queued send when an import fails", async () => {
    shell.importFile.mockImplementationOnce(() =>
      Effect.fail(new Error("disk full") as never),
    );
    const { result } = renderHook(() => useWorkspaceImports("chat"));
    act(() => result.current.addFiles([file("a.txt")]));

    const send = vi.fn();
    act(() => result.current.submit(send));
    await waitFor(() => expect(result.current.hasError).toBe(true));

    expect(send).not.toHaveBeenCalled();
    expect(result.current.queued).toBe(false);
  });

  it("removes an unclaimed file from the workspace when its chip is removed", async () => {
    shell.importFile.mockImplementation((input: { fileName: string }) =>
      Effect.succeed({ path: input.fileName }),
    );
    const { result } = renderHook(() => useWorkspaceImports("chat"));
    act(() => result.current.addFiles([file("a.txt")]));
    await waitFor(() => expect(result.current.importing).toBe(false));

    act(() => result.current.remove(result.current.items[0]!.localId));
    expect(result.current.items).toEqual([]);
    expect(shell.discardImport).toHaveBeenCalledWith({ conversationId: "chat", name: "a.txt" });
  });

  it("markClaimed forgets the chips but keeps the files", async () => {
    shell.importFile.mockImplementation((input: { fileName: string }) =>
      Effect.succeed({ path: input.fileName }),
    );
    const { result } = renderHook(() => useWorkspaceImports("chat"));
    act(() => result.current.addFiles([file("a.txt")]));
    await waitFor(() => expect(result.current.importing).toBe(false));

    act(() => result.current.markClaimed());
    expect(result.current.items).toEqual([]);
    expect(shell.discardImport).not.toHaveBeenCalled();
  });

  it("reset drops chips and deletes the unclaimed files", async () => {
    shell.importFile.mockImplementation((input: { fileName: string }) =>
      Effect.succeed({ path: input.fileName }),
    );
    const { result } = renderHook(() => useWorkspaceImports("chat"));
    act(() => result.current.addFiles([file("a.txt")]));
    await waitFor(() => expect(result.current.importing).toBe(false));

    act(() => result.current.reset());
    expect(result.current.items).toEqual([]);
    expect(shell.discardImport).toHaveBeenCalledWith({ conversationId: "chat", name: "a.txt" });
  });
});
