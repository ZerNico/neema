import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Attachment } from "../schema.ts";
import {
  attachmentUrl,
  createPastedTextFile,
  shouldPasteAsFile,
  useAttachmentUploads,
} from "./use-attachment-uploads.ts";

// Only imported for its default upload/delete paths, which every test replaces.
vi.mock("../server/functions.ts", () => ({
  uploadAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
}));

let count = 0;
const dto = (overrides: Partial<Attachment> = {}): Attachment => {
  const n = ++count;
  return {
    id: `attachment-${n}`,
    fileName: `file-${n}.txt`,
    size: 5,
    mediaType: "text/plain",
    kind: "text",
    ...overrides,
  };
};

const textFile = (name = "notes.txt") => new File(["hello"], name, { type: "text/plain" });
const imageFile = (name = "shot.png") => new File(["png"], name, { type: "image/png" });

const setup = (upload: (file: File) => Promise<Attachment> = () => Promise.resolve(dto())) => {
  const destroy = vi.fn(() => Promise.resolve());
  const view = renderHook(() => useAttachmentUploads({ upload, destroy }));
  return { ...view, destroy };
};

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => `blob:${Math.random()}`);
  URL.revokeObjectURL = vi.fn();
});

describe("paste heuristics", () => {
  it("only turns big pastes into files", () => {
    expect(shouldPasteAsFile("short")).toBe(false);
    expect(shouldPasteAsFile("x".repeat(2_001))).toBe(true);
    expect(shouldPasteAsFile("line\n".repeat(51))).toBe(true);
  });

  it("names the pasted file predictably", () => {
    const file = createPastedTextFile("body");
    expect(file.name).toBe("pasted-text.txt");
    expect(file.type).toBe("text/plain");
  });
});

describe("useAttachmentUploads", () => {
  it("reports ordered ids once uploads finish", async () => {
    let n = 0;
    const { result } = setup(() => Promise.resolve(dto({ id: `a-${++n}` })));
    act(() => result.current.addFiles([textFile("a.txt"), textFile("b.txt")]));

    expect(result.current.uploading).toBe(true);
    await waitFor(() => expect(result.current.uploading).toBe(false));
    expect(result.current.attachmentIds).toEqual(["a-1", "a-2"]);
  });

  it("submits immediately when nothing is in flight", async () => {
    const { result } = setup(() => Promise.resolve(dto({ id: "a-1" })));
    act(() => result.current.addFiles([textFile()]));
    await waitFor(() => expect(result.current.uploading).toBe(false));

    const send = vi.fn();
    act(() => result.current.submit(send));

    expect(result.current.queued).toBe(false);
    expect(send).toHaveBeenCalledWith(["a-1"]);
  });

  it("drops a queued send when the queue is cancelled", async () => {
    let resolve!: (value: Attachment) => void;
    const { result } = setup(() => new Promise<Attachment>((res) => (resolve = res)));
    act(() => result.current.addFiles([textFile()]));

    const send = vi.fn();
    act(() => result.current.submit(send));
    expect(result.current.queued).toBe(true);

    act(() => result.current.cancelQueue());
    await act(async () => resolve(dto()));

    expect(send).not.toHaveBeenCalled();
    expect(result.current.queued).toBe(false);
  });

  it("seeds the chips of a message being edited", () => {
    const { result, destroy } = setup();
    const existing = dto({ id: "a-existing", fileName: "shot.png", kind: "image" });
    act(() => result.current.seed([existing]));

    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]).toMatchObject({
      existing: true,
      status: "complete",
      previewUrl: attachmentUrl("a-existing"),
    });

    // Removing it only drops the chip: the save releases it by omission.
    act(() => result.current.remove(result.current.items[0]!.localId));
    expect(destroy).not.toHaveBeenCalled();
    expect(result.current.attachmentIds).toEqual([]);
  });

  it("keeps claimed attachments but deletes unclaimed ones on reset", async () => {
    const { result, destroy } = setup(() => Promise.resolve(dto({ id: "a-new" })));
    act(() => result.current.seed([dto({ id: "a-existing" })]));
    act(() => result.current.addFiles([textFile()]));
    await waitFor(() => expect(result.current.uploading).toBe(false));

    act(() => result.current.reset());

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledWith("a-new");
    expect(result.current.items).toEqual([]);
  });

  it("forgets everything without deleting once a message claims it", async () => {
    const { result, destroy } = setup(() => Promise.resolve(dto({ id: "a-new" })));
    act(() => result.current.addFiles([textFile()]));
    await waitFor(() => expect(result.current.uploading).toBe(false));

    act(() => result.current.markClaimed(["a-new"]));

    expect(destroy).not.toHaveBeenCalled();
    expect(result.current.items).toEqual([]);
  });

  it("acknowledges only submitted attachment IDs and preserves later chips", async () => {
    let count = 0;
    const { result, destroy } = setup(() => Promise.resolve(dto({ id: `a-${++count}` })));
    act(() => result.current.addFiles([textFile("a.txt")]));
    await waitFor(() => expect(result.current.uploading).toBe(false));
    const submittedIds = result.current.attachmentIds;
    act(() => result.current.addFiles([textFile("b.txt")]));
    await waitFor(() => expect(result.current.uploading).toBe(false));
    act(() => result.current.markClaimed(submittedIds));
    expect(result.current.attachmentIds).toEqual(["a-2"]);
    expect(destroy).not.toHaveBeenCalled();
  });

  it.each(["remove", "reset", "seed", "unmount"])(
    "holds removed submitted bytes across %s until acceptance or rejection",
    async (removal) => {
      for (const accepted of [true, false]) {
        const { result, destroy, unmount } = setup(() => Promise.resolve(dto({ id: "A" })));
        act(() => result.current.addFiles([textFile()]));
        await waitFor(() => expect(result.current.uploading).toBe(false));
        let release!: () => void;
        act(() => {
          release = result.current.beginSubmission(["A"]);
        });
        const claim = result.current.markClaimed;
        act(() => {
          if (removal === "remove") result.current.remove(result.current.items[0]!.localId);
          else if (removal === "reset") result.current.reset();
          else if (removal === "seed") result.current.seed([dto({ id: "existing" })]);
          else unmount();
        });
        expect(destroy).not.toHaveBeenCalled();
        act(() => {
          if (accepted) claim(["A"]);
          release();
          release();
        });
        if (accepted) expect(destroy).not.toHaveBeenCalled();
        else expect(destroy).toHaveBeenCalledExactlyOnceWith("A");
        unmount();
      }
    },
  );

  it("releases a failed visible upload for retry and leaves later files independent", async () => {
    const { result, destroy } = setup((file) => Promise.resolve(dto({ id: file.name })));
    act(() => result.current.addFiles([textFile("A")]));
    await waitFor(() => expect(result.current.uploading).toBe(false));
    let release!: () => void;
    act(() => {
      release = result.current.beginSubmission(["A"]);
    });
    act(() => result.current.addFiles([textFile("B")]));
    await waitFor(() => expect(result.current.uploading).toBe(false));
    act(() => result.current.remove(result.current.items[1]!.localId));
    expect(destroy).toHaveBeenCalledExactlyOnceWith("B");
    act(() => release());
    expect(result.current.attachmentIds).toEqual(["A"]);
    expect(destroy).toHaveBeenCalledTimes(1);
    act(() => result.current.remove(result.current.items[0]!.localId));
    expect(destroy).toHaveBeenLastCalledWith("A");
  });

  it("retains submitted bytes until every pending owner releases them", async () => {
    const { result, destroy } = setup(() => Promise.resolve(dto({ id: "A" })));
    act(() => result.current.addFiles([textFile()]));
    await waitFor(() => expect(result.current.uploading).toBe(false));
    let releaseA!: () => void;
    let releaseB!: () => void;
    act(() => {
      releaseA = result.current.beginSubmission(["A"]);
      releaseB = result.current.beginSubmission(["A"]);
      result.current.reset();
      releaseA();
    });
    expect(destroy).not.toHaveBeenCalled();
    act(() => releaseB());
    expect(destroy).toHaveBeenCalledExactlyOnceWith("A");
  });

  it("revokes image previews when the chip goes away", async () => {
    const { result } = setup(() => Promise.resolve(dto({ kind: "image" })));
    act(() => result.current.addFiles([imageFile()]));
    const url = result.current.items[0]!.previewUrl!;
    expect(url).toMatch(/^blob:/);

    act(() => result.current.remove(result.current.items[0]!.localId));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(url);
  });

  it("revokes previews left over at unmount", () => {
    const { result, unmount } = setup();
    act(() => result.current.addFiles([imageFile()]));
    const url = result.current.items[0]!.previewUrl!;

    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(url);
  });

  it("reports fullness and clears the notice on demand", () => {
    const { result } = setup();
    act(() => result.current.addFiles(Array.from({ length: 6 }, () => textFile())));

    expect(result.current.items).toHaveLength(5);
    expect(result.current.isFull).toBe(true);
    expect(result.current.notice).toContain("at most 5 files");

    act(() => result.current.dismissNotice());
    expect(result.current.notice).toBeNull();
  });
});
