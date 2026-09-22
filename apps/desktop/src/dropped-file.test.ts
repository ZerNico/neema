import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { makeDroppedFileHandler } from "./dropped-file.ts";

const CONVERSATION = "01990f4e-6650-7a33-a768-611e2e4bf4c7";
const SUBMISSION = "550e8400-e29b-41d4-a716-446655440000";
const ORIGIN = "https://chat.example.com";
const payload = {
  conversationId: CONVERSATION,
  submissionId: SUBMISSION,
  fileName: "report.pdf",
};

const fixture = () => {
  const mainFrame = { url: `${ORIGIN}/chat/${CONVERSATION}` };
  const contents = { mainFrame };
  const stage = vi.fn(() => Effect.succeed({ name: "report.pdf", bytes: 42 }));
  const handler = makeDroppedFileHandler({
    contents: () => contents,
    origin: () => ORIGIN,
    stage,
    run: (effect) => Effect.runPromise(effect),
  });
  return {
    contents,
    mainFrame,
    stage,
    handler,
    event: { sender: contents, senderFrame: mainFrame },
  };
};

describe("dropped-file IPC boundary", () => {
  it("accepts the configured window's main frame and keeps the host path private", async () => {
    const { event, handler, stage } = fixture();

    await expect(
      handler(event, { payload, sourcePath: "/Users/test/Downloads/report.pdf" }),
    ).resolves.toEqual({ ok: true, value: { name: "report.pdf", bytes: 42 } });
    expect(stage).toHaveBeenCalledWith(payload, "/Users/test/Downloads/report.pdf");
  });

  it("refuses a wrong origin, foreign window, and non-main frame", async () => {
    const { contents, event, handler, mainFrame, stage } = fixture();
    mainFrame.url = "https://other.example.com/chat";
    await expect(handler(event, { payload, sourcePath: "/tmp/report.pdf" })).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({ reason: "failed", message: "Not allowed from this page." }),
    });
    mainFrame.url = `${ORIGIN}/chat/${CONVERSATION}`;

    for (const denied of [
      { sender: { mainFrame }, senderFrame: mainFrame },
      { sender: contents, senderFrame: { ...mainFrame } },
    ]) {
      await expect(handler(denied, { payload, sourcePath: "/tmp/report.pdf" })).resolves.toEqual({
        ok: false,
        error: expect.objectContaining({
          reason: "failed",
          message: "Not allowed from this page.",
        }),
      });
    }
    expect(stage).not.toHaveBeenCalled();
  });

  it("rejects malformed public metadata and a missing private source path", async () => {
    const { event, handler, stage } = fixture();

    await expect(
      handler(event, {
        payload: { ...payload, conversationId: "../../outside" },
        sourcePath: "/tmp/report.pdf",
      }),
    ).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({ reason: "failed", message: "Malformed request." }),
    });
    await expect(handler(event, { payload })).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({ reason: "failed", message: "Malformed request." }),
    });
    expect(stage).not.toHaveBeenCalled();
  });
});
