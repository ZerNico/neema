import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DesktopError,
  makeDesktopClient,
  makeDesktopResponder,
  PROTOCOL_VERSION,
  type DesktopClient,
  type DesktopHandlers,
} from "@chat/desktop-rpc";
import type { DesktopToolActivity } from "~/modules/chat/client/use-message-stream.ts";
import { DesktopActivityBlock } from "~/modules/chat/ui/desktop-activity-block.tsx";
import { AssistantMarkdown } from "~/modules/chat/ui/assistant-markdown.tsx";
import {
  FileReferenceContext,
  FileReferenceMachine,
} from "~/modules/chat/ui/file-reference-context.ts";
import { LocalFileConversationProvider } from "./local-file-preview.tsx";

const bridge = vi.hoisted(() => ({ client: null as DesktopClient | null }));
vi.mock("../client/bridge.ts", () => ({ useDesktop: () => bridge.client }));
const sonner = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: sonner.error } }));

/** Every call the preview actually made to the machine, in order. */
let asked: { tag: string; path: string }[];
let files: Record<string, { text: string } | { mediaType: string; base64: string }>;
/** Object URLs handed out, and the bytes behind them, standing in for jsdom. */
let handed: string[];
let revoked: string[];
let behind: Map<string, Blob>;

const refuse = (reason: DesktopError["reason"], message: string) =>
  Effect.fail(new DesktopError({ reason, message }));

const notUsed = (tag: string) => () =>
  Effect.fail(new DesktopError({ reason: "failed", message: `${tag} is not part of this test` }));

/**
 * A real client over a real responder, so a test exercises the declared
 * schemas rather than a hand-written stand-in for them. Only the disk is fake.
 */
const connect = (): DesktopClient => {
  const handlers: DesktopHandlers = {
    executionSession: notUsed("executionSession"),
    cancelCall: notUsed("cancelCall"),
    setWorkState: notUsed("setWorkState"),
    folderStatus: notUsed("folderStatus"),
    chooseFolder: notUsed("chooseFolder"),
    detachFolder: notUsed("detachFolder"),
    listDirectory: notUsed("listDirectory"),
    fileInfo: ({ path }) =>
      Effect.suspend(() => {
        asked.push({ tag: "fileInfo", path });
        return files[path] === undefined
          ? refuse("not-found", `${path} does not exist.`)
          : Effect.succeed({ path, bytes: 4 });
      }),
    writeFile: notUsed("writeFile"),
    saveToWorkspace: notUsed("saveToWorkspace"),
    editFile: notUsed("editFile"),
    movePath: notUsed("movePath"),
    deletePath: notUsed("deletePath"),
    findFiles: notUsed("findFiles"),
    searchFiles: notUsed("searchFiles"),
    runCommand: notUsed("runCommand"),
    requestNetworkAccess: notUsed("requestNetworkAccess"),
    setUpSandbox: notUsed("setUpSandbox"),
    stageFile: notUsed("stageFile"),
    discardStagedFile: notUsed("discardStagedFile"),
    discardSubmission: notUsed("discardSubmission"),
    promoteSubmission: notUsed("promoteSubmission"),
    commitPromotion: notUsed("commitPromotion"),
    rollbackPromotion: notUsed("rollbackPromotion"),
    listPendingPromotions: notUsed("listPendingPromotions"),
    cloneWorkspace: notUsed("cloneWorkspace"),
    copyFolderGrants: notUsed("copyFolderGrants"),
    discardWorkspace: notUsed("discardWorkspace"),
    readFile: ({ path }) =>
      Effect.suspend(() => {
        asked.push({ tag: "readFile", path });
        const file = files[path];
        if (file === undefined) return refuse("not-found", `${path} does not exist.`);
        if (!("text" in file)) return refuse("not-text", `${path} is not a text file.`);
        return Effect.succeed({ path, text: file.text, truncated: false });
      }),
    readBinary: ({ path }) =>
      Effect.suspend(() => {
        asked.push({ tag: "readBinary", path });
        const file = files[path];
        if (file === undefined) return refuse("not-found", `${path} does not exist.`);
        if (!("mediaType" in file)) return refuse("not-binary", `${path} is not an image.`);
        return Effect.succeed({ ...file, path, bytes: 4 });
      }),
    revealPath: ({ path, mode }) =>
      Effect.suspend(() => {
        asked.push({ tag: `revealPath:${mode}`, path });
        // Folders have no entry here; a named file that has none is gone.
        if (path.includes(".") && files[path] === undefined)
          return refuse("not-found", `${path} does not exist.`);
        return mode === "open" && path.endsWith("runme")
          ? refuse(
              "not-openable",
              `${path} is marked executable, so opening it could run it. Show it in the folder instead.`,
            )
          : Effect.succeed(undefined);
      }),
  };
  const respond = makeDesktopResponder(handlers);
  return makeDesktopClient({
    protocolVersion: PROTOCOL_VERSION,
    stageDroppedFile: async () => null,
    // Round-tripped through JSON, because contextBridge carries nothing else.
    request: async (tag, payload) => {
      const wire = JSON.parse(JSON.stringify(payload)) as unknown;
      return JSON.parse(JSON.stringify(await Effect.runPromise(respond(tag, wire)))) as never;
    },
  });
};

const wrote = (path: string, name: DesktopToolActivity["name"] = "write_local_file") =>
  ({
    family: "desktop",
    callId: `call-${path}`,
    name,
    status: "complete",
    turnIndex: 0,
    callIndex: 0,
    args: { path },
    result: { v: 1, ok: true, summary: `Wrote ${path}`, detail: "", truncated: false },
  }) satisfies DesktopToolActivity;

const show = (activity: DesktopToolActivity) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
    >
      <LocalFileConversationProvider conversationId="01990f4e-6650-7a33-a768-611e2e4bf4c7">
        <DesktopActivityBlock activity={activity} />
      </LocalFileConversationProvider>
    </QueryClientProvider>,
  );

const click = (activity: DesktopToolActivity) =>
  userEvent.click(screen.getByRole("button", { name: new RegExp(activity.result!.summary!) }));

beforeEach(() => {
  asked = [];
  handed = [];
  revoked = [];
  behind = new Map();
  sonner.error.mockReset();
  bridge.client = connect();
  files = {
    "site/notes.md": { text: "# Notes\nstill here" },
    "site/logo.svg": { text: '<svg xmlns="http://www.w3.org/2000/svg" onload="steal()"></svg>' },
    "site/logo.png": { mediaType: "image/png", base64: "iVBORw==" },
    "site/report.bin": { mediaType: "application/octet-stream", base64: "AAAA" },
  };
  let next = 0;
  vi.stubGlobal(
    "URL",
    Object.assign(class extends URL {}, {
      createObjectURL: vi.fn((blob: Blob) => {
        const url = `blob:test/${(next += 1)}`;
        handed.push(url);
        behind.set(url, blob);
        return url;
      }),
      revokeObjectURL: vi.fn((url: string) => revoked.push(url)),
    }),
  );
  // The dialog reads a text file back out of the URL it was handed.
  vi.stubGlobal("fetch", (url: string) =>
    Promise.resolve({ ok: true, text: () => behind.get(url)!.text() }),
  );
});

describe("a work file row on the desktop", () => {
  it("reads the file only when it is clicked, and reads it from the machine", async () => {
    const row = wrote("site/notes.md");
    show(row);
    // The transcript stays quiet: rendering the row touches no disk.
    expect(asked).toEqual([]);

    await click(row);

    expect(await screen.findByText("still here")).toBeTruthy();
    expect(asked).toEqual([{ tag: "readFile", path: "site/notes.md" }]);
    expect(screen.getByRole("heading", { name: "notes.md" })).toBeTruthy();
  });

  it("shows a model-written SVG as a picture that cannot run or be followed", async () => {
    const row = wrote("site/logo.svg");
    show(row);
    await click(row);

    const image = await screen.findByRole("img", { name: "logo.svg" });
    expect(image.getAttribute("src")).toBe(handed[0]);
    expect(behind.get(handed[0]!)?.type).toBe("image/svg+xml");
    // An `<img>` and nothing else: the markup never becomes part of this page,
    // and there is no link to the blob, which would run it on our origin.
    expect(document.querySelector("svg[onload]")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.queryByRole("link", { name: "Open original" })).toBeNull();
  });

  it("shows an image through an object URL and gives it back on close", async () => {
    const row = wrote("site/logo.png");
    show(row);
    await click(row);

    const image = await screen.findByRole("img", { name: "logo.png" });
    expect(image.getAttribute("src")).toBe(handed[0]);
    expect(asked.map((call) => call.tag)).toEqual(["readBinary"]);

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(revoked).toEqual(handed));
  });

  it("puts reveal beside the name, and offers no Open the machine would refuse", async () => {
    const row = wrote("site/logo.svg");
    show(row);
    await click(row);
    await screen.findByRole("img", { name: "logo.svg" });

    // The name and the actions share one row, so neither is stacked below.
    const title = screen.getByRole("heading", { name: "logo.svg" });
    const action = screen.getByRole("button", { name: "Show in folder" });
    expect(title.closest("[data-slot=dialog-header]")?.contains(action)).toBe(true);
    expect(title.parentElement?.contains(action)).toBe(true);

    // Markup is on the shared list, so the button that could only refuse is
    // absent rather than present and broken.
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();

    await userEvent.click(action);
    await waitFor(() =>
      expect(asked.at(-1)).toEqual({ tag: "revealPath:reveal", path: "site/logo.svg" }),
    );
  });

  it("offers Open for an ordinary file and reports what the machine says back", async () => {
    files["site/runme"] = { text: "#!/bin/sh\n" };
    const row = wrote("site/runme");
    show(row);
    await click(row);
    await screen.findByRole("heading", { name: "runme" });

    // No extension to go on, so the site offers it and the machine decides.
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(sonner.error).toHaveBeenCalledTimes(1));
    expect(sonner.error.mock.calls[0]![0]).toBe(
      "site/runme is marked executable, so opening it could run it. Show it in the folder instead.",
    );
  });

  it("says plainly when the file is gone and offers the folder it was in", async () => {
    delete files["site/notes.md"];
    const row = wrote("site/notes.md");
    show(row);
    await click(row);

    await waitFor(() => expect(sonner.error).toHaveBeenCalledTimes(1));
    expect(sonner.error.mock.calls[0]![0]).toBe("This file isn’t there anymore.");
    expect(screen.queryByRole("dialog")).toBeNull();

    sonner.error.mock.calls[0]![1].action.onClick();
    await waitFor(() => expect(asked.at(-1)).toEqual({ tag: "revealPath:reveal", path: "site" }));
  });

  it("opens the dialog for a file with no preview, so its actions stay reachable", async () => {
    const row = wrote("site/report.bin");
    show(row);
    await click(row);

    expect(await screen.findByText("There’s no preview for this kind of file.")).toBeTruthy();
    // No image extension, so the read goes straight to text and the refusal
    // turns into a size-only dialog.
    expect(asked.map((call) => call.tag)).toEqual(["readFile", "fileInfo"]);
    // No bytes were handed over: nothing to render, nothing to revoke.
    expect(handed).toEqual([]);
    expect(sonner.error).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Show in folder" }));
    await waitFor(() =>
      expect(asked.at(-1)).toEqual({ tag: "revealPath:reveal", path: "site/report.bin" }),
    );
  });

  it("follows a move to where the file now is, and ignores a row with no file", async () => {
    const moved = {
      ...wrote("unused", "move_local_file"),
      args: { from: "site/old.md", to: "site/notes.md" },
    } satisfies DesktopToolActivity;
    show(moved);
    await click(moved);
    expect(await screen.findByText("still here")).toBeTruthy();
    expect(asked).toEqual([{ tag: "readFile", path: "site/notes.md" }]);

    show({ ...wrote("site/notes.md", "run_command"), args: { command: "ls" } });
    expect(screen.queryByRole("button", { name: /Wrote site\/notes\.md/ })).toBeNull();
  });
});

const branchId = "01990f4e-6650-7a33-a768-611e2e4bf4c7";
const sourceId = "01a0df3a-9159-75d9-9270-2348eeeca617";
const inlineView = (content: string, origin: string | null = "machine", streaming = false) => (
  <QueryClientProvider client={new QueryClient()}>
    <LocalFileConversationProvider
      conversationId={branchId}
      workspaceRoot={`/workspaces/${branchId}`}
    >
      <FileReferenceContext
        value={{
          attachments: new Map(),
          aliases: { attachments: {}, workspaceAncestors: [sourceId] },
          machineId: "machine",
        }}
      >
        <FileReferenceMachine value={origin}>
          <AssistantMarkdown content={content} streaming={streaming} />
        </FileReferenceMachine>
      </FileReferenceContext>
    </LocalFileConversationProvider>
  </QueryClientProvider>
);
const inlineLink = (path: string) => `[file](/local-file?path=${encodeURIComponent(path)})`;

describe("inline Work file references over the desktop bridge", () => {
  it("previews all five command-created images after streaming, reload and branching without attachment rows", async () => {
    const paths = Array.from({ length: 5 }, (_, index) => `downloaded_images/image_${index}.jpg`);
    for (const path of paths)
      files[`/workspaces/${branchId}/${path}`] = { mediaType: "image/jpeg", base64: "AAAA" };
    const content = paths.map((path) => inlineLink(`/workspaces/${sourceId}/${path}`)).join("\n\n");
    const first = render(inlineView(content, "machine", true));
    expect(asked).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Preview image_0.jpg" }));
    const dialog = await screen.findByRole("dialog");
    first.rerender(inlineView(content + "\n\nFinished.", "machine", true));
    expect(screen.getByRole("dialog")).toBe(dialog);
    first.unmount();
    expect(revoked).toEqual(handed);
    render(inlineView(content));
    for (let index = 0; index < paths.length; index += 1) {
      await userEvent.click(screen.getByRole("button", { name: `Preview image_${index}.jpg` }));
      expect(await screen.findByRole("img", { name: `image_${index}.jpg` })).toHaveAttribute(
        "src",
        handed.at(-1),
      );
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    }
    expect(asked).toEqual(
      [paths[0]!, ...paths].map((path) => ({
        tag: "readBinary",
        path: `/workspaces/${branchId}/${path}`,
      })),
    );
    expect(revoked).toEqual(handed);
  });

  it("does not fall back to a surviving source file when the branch copy is missing", async () => {
    const path = `/workspaces/${sourceId}/missing.png`;
    files[path] = { mediaType: "image/png", base64: "AAAA" };
    render(inlineView(inlineLink(path)));
    await userEvent.click(screen.getByRole("button", { name: "Preview missing.png" }));
    await waitFor(() => expect(sonner.error).toHaveBeenCalledTimes(1));
    expect(asked).toEqual([{ tag: "readBinary", path: `/workspaces/${branchId}/missing.png` }]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each([null, "other-machine"])(
    "refuses unknown or foreign machine provenance: %s",
    async (origin) => {
      render(inlineView(inlineLink(`/workspaces/${sourceId}/image.png`), origin));
      const chip = screen.getByRole("button", { name: "Unavailable file: image.png" });
      expect(chip).toBeDisabled();
      await userEvent.click(chip);
      expect(asked).toEqual([]);
    },
  );

  it.each(["svg", "html"])(
    "keeps inline %s files in the existing safe preview",
    async (extension) => {
      const path = `/attached/file.${extension}`;
      files[path] = {
        text:
          extension === "svg"
            ? '<svg xmlns="http://www.w3.org/2000/svg" onload="steal()"></svg>'
            : "<script>steal()</script><h1>Hello</h1>",
      };
      render(inlineView(inlineLink(path)));
      await userEvent.click(screen.getByRole("button", { name: `Preview file.${extension}` }));
      await screen.findByRole("dialog");
      expect(asked).toEqual([{ tag: "readFile", path }]);
      expect(document.querySelector("svg[onload], script, iframe")).toBeNull();
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Open" })).not.toBeInTheDocument();
      expect(behind.get(handed[0]!)?.type).toBe(
        extension === "svg" ? "image/svg+xml" : "text/plain",
      );
    },
  );

  it("uses Windows filenames in the preview and preserves absolute paths for reveal", async () => {
    const path = "C:\\attached\\image.png";
    files[path] = { mediaType: "image/png", base64: "AAAA" };
    const row = wrote(path);
    show(row);
    await userEvent.click(screen.getByRole("button", { name: row.result!.summary! }));
    await screen.findByRole("img", { name: "image.png" });
    await userEvent.click(screen.getByRole("button", { name: "Show in folder" }));
    await waitFor(() => expect(asked.at(-1)).toEqual({ tag: "revealPath:reveal", path }));
  });
});

describe("the same row in a browser", () => {
  beforeEach(() => {
    bridge.client = null;
  });

  it("stays history, with nothing to press and nothing to reveal", async () => {
    show(wrote("site/notes.md"));

    expect(screen.getByText("Wrote site/notes.md")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    await userEvent.click(screen.getByText("Wrote site/notes.md"));
    expect(asked).toEqual([]);
    expect(handed).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
