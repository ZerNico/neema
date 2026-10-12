import { act, renderHook, waitFor } from "@testing-library/react";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceImports } from "./use-workspace-imports.ts";

const CONVERSATION = "01990f4e-6650-7a33-a768-611e2e4bf4c7";
const RESERVATION = "550e8400-e29b-41d4-a716-446655440001";

const shell = {
  stageFile: vi.fn((input: { fileName: string }) =>
    Effect.succeed({ name: input.fileName, bytes: 5 }),
  ),
  discardStagedFile: vi.fn(() => Effect.succeed(undefined)),
  discardSubmission: vi.fn(() => Effect.succeed(undefined)),
  promoteSubmission: vi.fn((input: { reservationId: string }) =>
    Effect.succeed({
      reservationId: input.reservationId,
      files: [{ stagedName: "a.txt", finalName: "a.txt", bytes: 5 }],
    }),
  ),
  commitPromotion: vi.fn(() => Effect.succeed(undefined)),
  rollbackPromotion: vi.fn(() => Effect.succeed(undefined)),
};

const dropped = vi.hoisted(() => ({ stage: vi.fn() }));

vi.mock("./bridge.ts", () => ({
  desktopClient: () => shell,
}));

vi.mock("@chat/desktop-rpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chat/desktop-rpc")>()),
  stageDroppedFile: dropped.stage,
}));

const file = (name = "notes.txt", size?: number) => {
  const value = new File(["hello"], name, { type: "text/plain" });
  if (size !== undefined) Object.defineProperty(value, "size", { value: size });
  return value;
};

beforeEach(() => {
  for (const mock of Object.values(shell)) mock.mockClear();
  dropped.stage.mockReset();
  dropped.stage.mockReturnValue(Effect.succeed(null));
});

describe("useWorkspaceImports", () => {
  it("stages synthetic files as bounded base64 and reports stored names in order", async () => {
    const { result } = renderHook(() => useWorkspaceImports(CONVERSATION));
    act(() => result.current.addFiles([file("a.txt"), file("b.txt")]));

    expect(result.current.importing).toBe(true);
    await waitFor(() => expect(result.current.importing).toBe(false));
    expect(result.current.fileNames).toEqual(["a.txt", "b.txt"]);
    expect(shell.stageFile).toHaveBeenCalledTimes(2);
    expect(shell.stageFile).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: CONVERSATION,
        fileName: "a.txt",
        base64: btoa("hello"),
      }),
    );
  });

  it("stages a real dropped file through preload without exposing its host path", async () => {
    dropped.stage.mockReturnValueOnce(
      Effect.succeed({ name: "dump.sql", bytes: 60 * 1024 * 1024 }),
    );
    const { result } = renderHook(() => useWorkspaceImports(CONVERSATION));
    const value = file("dump.sql", 60 * 1024 * 1024);
    act(() => result.current.addFiles([value]));

    await waitFor(() => expect(result.current.importing).toBe(false));
    expect(result.current.fileNames).toEqual(["dump.sql"]);
    expect(dropped.stage).toHaveBeenCalledWith(
      value,
      expect.objectContaining({ conversationId: CONVERSATION, fileName: "dump.sql" }),
    );
    expect(shell.stageFile).not.toHaveBeenCalled();
  });

  it("refuses a synthetic file above the base64 cap after preload reports no path", async () => {
    const { result } = renderHook(() => useWorkspaceImports(CONVERSATION));
    act(() => result.current.addFiles([file("huge.zip", 60 * 1024 * 1024)]));

    await waitFor(() => expect(result.current.items[0]?.status).toBe("error"));
    expect(result.current.items[0]?.error).toBe("Too large. The limit is 50.0 MB.");
    expect(shell.stageFile).not.toHaveBeenCalled();
  });

  it("refuses any file beyond the host-path cap before calling preload", () => {
    const { result } = renderHook(() => useWorkspaceImports(CONVERSATION));
    act(() => result.current.addFiles([file("disk.img", 600 * 1024 * 1024)]));

    expect(result.current.items[0]?.status).toBe("error");
    expect(result.current.items[0]?.error).toBe("Too large. The limit is 512.0 MB.");
    expect(dropped.stage).not.toHaveBeenCalled();
    expect(shell.stageFile).not.toHaveBeenCalled();
  });

  it("queues a send until staging settles", async () => {
    let release!: (value: { name: string; bytes: number }) => void;
    shell.stageFile.mockImplementationOnce(() =>
      Effect.promise(() => new Promise((resolve) => (release = resolve))),
    );
    const { result } = renderHook(() => useWorkspaceImports(CONVERSATION));
    act(() => result.current.addFiles([file("a.txt")]));

    const send = vi.fn();
    act(() => result.current.submit(send));
    expect(result.current.queued).toBe(true);
    await waitFor(() => expect(shell.stageFile).toHaveBeenCalled());
    await act(async () => release({ name: "a.txt", bytes: 5 }));
    expect(send).toHaveBeenCalledWith(["a.txt"]);
    expect(result.current.queued).toBe(false);
  });

  it("cancels a queued send when staging fails", async () => {
    shell.stageFile.mockImplementationOnce(() => Effect.fail(new Error("disk full") as never));
    const { result } = renderHook(() => useWorkspaceImports(CONVERSATION));
    act(() => result.current.addFiles([file("a.txt")]));

    const send = vi.fn();
    act(() => result.current.submit(send));
    await waitFor(() => expect(result.current.hasError).toBe(true));
    expect(send).not.toHaveBeenCalled();
    expect(result.current.queued).toBe(false);
  });

  it("removes a completed staged file when its chip is removed", async () => {
    const { result } = renderHook(() => useWorkspaceImports(CONVERSATION));
    act(() => result.current.addFiles([file("a.txt")]));
    await waitFor(() => expect(result.current.importing).toBe(false));
    const submissionId = result.current.submissionId;

    act(() => result.current.remove(result.current.items[0]!.localId));
    expect(result.current.items).toEqual([]);
    expect(shell.discardStagedFile).toHaveBeenCalledWith({
      conversationId: CONVERSATION,
      submissionId,
      name: "a.txt",
    });
  });

  it("cleans up a late staging completion after the chip is removed", async () => {
    let release!: (value: { name: string; bytes: number }) => void;
    shell.stageFile.mockImplementationOnce(() =>
      Effect.promise(() => new Promise((resolve) => (release = resolve))),
    );
    const { result } = renderHook(() => useWorkspaceImports(CONVERSATION));
    act(() => result.current.addFiles([file("a.txt")]));
    const localId = result.current.items[0]!.localId;
    const submissionId = result.current.submissionId;
    act(() => result.current.remove(localId));
    await waitFor(() => expect(shell.stageFile).toHaveBeenCalled());
    await act(async () => release({ name: "a.txt", bytes: 5 }));

    expect(result.current.items).toEqual([]);
    expect(shell.discardStagedFile).toHaveBeenCalledWith({
      conversationId: CONVERSATION,
      submissionId,
      name: "a.txt",
    });
  });

  it("discards an unpromoted submission on reset and rotates its identity", async () => {
    const { result } = renderHook(() => useWorkspaceImports(CONVERSATION));
    act(() => result.current.addFiles([file("a.txt")]));
    await waitFor(() => expect(result.current.importing).toBe(false));
    const submissionId = result.current.submissionId;

    act(() => result.current.reset());
    expect(result.current.items).toEqual([]);
    expect(result.current.submissionId).not.toBe(submissionId);
    expect(shell.discardSubmission).toHaveBeenCalledWith({
      conversationId: CONVERSATION,
      submissionId,
    });
  });

  it("keeps later imports outside the submitted staging batch and settles exact identities", async () => {
    const { result } = renderHook(() => useWorkspaceImports(CONVERSATION));
    act(() => result.current.addFiles([file("a.txt")]));
    await waitFor(() => expect(result.current.importing).toBe(false));
    const submitted = result.current;
    let release!: () => void;
    act(() => {
      release = submitted.beginSubmission(["a.txt"]);
    });
    act(() => result.current.addFiles([file("b.txt")]));
    expect(result.current.items).toHaveLength(2);
    expect(shell.stageFile).toHaveBeenCalledTimes(1);
    await act(async () => {
      await submitted.promote(RESERVATION);
      await submitted.commit(RESERVATION);
    });
    act(() => {
      submitted.markClaimed(["a.txt"]);
      release();
    });
    await waitFor(() => expect(result.current.importing).toBe(false));
    expect(result.current.fileNames).toEqual(["b.txt"]);
    expect(shell.stageFile).toHaveBeenLastCalledWith(
      expect.objectContaining({ fileName: "b.txt", submissionId: result.current.submissionId }),
    );
    expect(result.current.submissionId).not.toBe(submitted.submissionId);
    expect(shell.discardSubmission).not.toHaveBeenCalled();
  });

  it("releases later imports for retry when a dispatch fails", async () => {
    const { result } = renderHook(() => useWorkspaceImports(CONVERSATION));
    act(() => result.current.addFiles([file("a.txt")]));
    await waitFor(() => expect(result.current.importing).toBe(false));
    const submissionId = result.current.submissionId;
    let release!: () => void;
    act(() => {
      release = result.current.beginSubmission(["a.txt"]);
    });
    act(() => result.current.addFiles([file("b.txt")]));
    act(() => release());
    await waitFor(() => expect(result.current.importing).toBe(false));
    expect(result.current.fileNames).toEqual(["a.txt", "b.txt"]);
    expect(result.current.submissionId).toBe(submissionId);
    expect(shell.stageFile).toHaveBeenLastCalledWith(
      expect.objectContaining({ fileName: "b.txt", submissionId }),
    );
  });

  it.each([true, false])(
    "holds a removed submitted file until acceptance is known (%s)",
    async (accepted) => {
      const { result } = renderHook(() => useWorkspaceImports(CONVERSATION));
      act(() => result.current.addFiles([file("a.txt")]));
      await waitFor(() => expect(result.current.importing).toBe(false));
      const submitted = result.current;
      let release!: () => void;
      act(() => {
        release = submitted.beginSubmission(["a.txt"]);
      });
      act(() => result.current.remove(submitted.items[0]!.localId));
      expect(shell.discardStagedFile).not.toHaveBeenCalled();
      act(() => {
        if (accepted) submitted.markClaimed(["a.txt"]);
        release();
      });
      if (accepted) expect(shell.discardStagedFile).not.toHaveBeenCalled();
      else
        expect(shell.discardStagedFile).toHaveBeenCalledWith({
          conversationId: CONVERSATION,
          submissionId: submitted.submissionId,
          name: "a.txt",
        });
    },
  );

  it("does not stage a later import removed while waiting for the submitted batch", async () => {
    const { result } = renderHook(() => useWorkspaceImports(CONVERSATION));
    act(() => result.current.addFiles([file("a.txt")]));
    await waitFor(() => expect(result.current.importing).toBe(false));
    let release!: () => void;
    act(() => {
      release = result.current.beginSubmission(["a.txt"]);
    });
    act(() => result.current.addFiles([file("b.txt")]));
    act(() => result.current.remove(result.current.items[1]!.localId));
    await act(async () => release());
    expect(shell.stageFile).toHaveBeenCalledTimes(1);
    expect(result.current.fileNames).toEqual(["a.txt"]);
  });

  it("defers unmount cleanup until a failed submitted batch releases", async () => {
    const { result, unmount } = renderHook(() => useWorkspaceImports(CONVERSATION));
    act(() => result.current.addFiles([file("a.txt")]));
    await waitFor(() => expect(result.current.importing).toBe(false));
    const submitted = result.current;
    let release!: () => void;
    act(() => {
      release = submitted.beginSubmission(["a.txt"]);
    });
    unmount();
    expect(shell.discardSubmission).not.toHaveBeenCalled();
    act(() => release());
    expect(shell.discardSubmission).toHaveBeenCalledWith({
      conversationId: CONVERSATION,
      submissionId: submitted.submissionId,
    });
  });

  it("does not discard a reset batch before its pending promotion settles", async () => {
    const { result, unmount } = renderHook(() => useWorkspaceImports(CONVERSATION));
    act(() => result.current.addFiles([file("a.txt")]));
    await waitFor(() => expect(result.current.importing).toBe(false));
    const submitted = result.current;
    let release!: () => void;
    act(() => {
      release = submitted.beginSubmission(["a.txt"]);
    });
    await act(async () => {
      await submitted.promote(RESERVATION);
    });
    act(() => result.current.reset());
    unmount();
    expect(shell.discardSubmission).not.toHaveBeenCalled();
    await act(async () => {
      await submitted.commit(RESERVATION);
      submitted.markClaimed(["a.txt"]);
      release();
    });
    expect(shell.discardSubmission).not.toHaveBeenCalled();
    expect(shell.discardStagedFile).not.toHaveBeenCalled();
  });

  it("promotes, commits, rolls back, and clears claimed chips through transaction RPCs", async () => {
    const { result } = renderHook(() => useWorkspaceImports(CONVERSATION));
    act(() => result.current.addFiles([file("a.txt")]));
    await waitFor(() => expect(result.current.importing).toBe(false));
    const submissionId = result.current.submissionId;

    await act(async () => {
      expect(await result.current.promote(RESERVATION)).toEqual({
        reservationId: RESERVATION,
        files: [{ stagedName: "a.txt", finalName: "a.txt", bytes: 5 }],
      });
      await result.current.rollback(RESERVATION);
      await result.current.promote(RESERVATION);
      await result.current.commit(RESERVATION);
    });
    act(() => result.current.markClaimed(["a.txt"]));

    expect(shell.promoteSubmission).toHaveBeenCalledWith({
      conversationId: CONVERSATION,
      submissionId,
      reservationId: RESERVATION,
    });
    expect(shell.rollbackPromotion).toHaveBeenCalledWith({
      conversationId: CONVERSATION,
      reservationId: RESERVATION,
    });
    expect(shell.commitPromotion).toHaveBeenCalledWith({
      conversationId: CONVERSATION,
      reservationId: RESERVATION,
    });
    expect(result.current.items).toEqual([]);
  });
});
