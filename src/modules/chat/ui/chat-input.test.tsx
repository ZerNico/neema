import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Suspense, useImperativeHandle, useState, type Ref } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatInput } from "./chat-input.tsx";
import type { Attachment } from "~/modules/attachments/schema.ts";
import {
  useAttachmentUploads,
  type AttachmentUploads,
} from "~/modules/attachments/client/use-attachment-uploads.ts";

// The queries reach for server functions; the harness seeds their caches, so
// the modules only have to exist.
vi.mock("~/modules/chat/server/functions.ts", () => ({
  listChatModels: vi.fn(),
  listConversations: vi.fn(),
  getConversationWithMessages: vi.fn(),
}));
vi.mock("~/modules/tools/server/functions.ts", () => ({ getWebSearchAvailability: vi.fn() }));
vi.mock("~/modules/attachments/server/functions.ts", () => ({
  getDocumentParsingAvailability: vi.fn(),
  uploadAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
}));

const model = (overrides: {
  id: string;
  displayName: string;
  vision?: boolean;
  files?: boolean;
}) => ({
  id: overrides.id,
  providerId: "provider-1",
  providerName: "Provider One",
  modelKey: overrides.id,
  displayName: overrides.displayName,
  type: "chat" as const,
  enabled: true,
  contextLength: 128_000,
  capabilities: {
    reasoning: false,
    tools: false,
    vision: overrides.vision ?? false,
    files: overrides.files ?? false,
  },
});

const MODELS = [
  model({ id: "text-only", displayName: "Text Only" }),
  model({ id: "vision", displayName: "Vision Model", vision: true }),
];

/** A promise whose settlement the test drives, so "uploading" can be observed. */
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

let attachmentCount = 0;
const dto = (overrides: Partial<Attachment> = {}): Attachment => {
  const n = ++attachmentCount;
  return {
    id: `attachment-${n}`,
    fileName: `file-${n}.txt`,
    size: 12,
    mediaType: "text/plain",
    kind: "text",
    ...overrides,
  };
};

const textFile = (name = "notes.txt") => new File(["hello"], name, { type: "text/plain" });
const imageFile = (name = "shot.png") => new File(["png"], name, { type: "image/png" });

interface Harness {
  onSubmit: ReturnType<typeof vi.fn<() => void>>;
  upload: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  handle: () => AttachmentUploads;
  setModel: (modelId: string) => void;
  container: HTMLElement;
}

function Harness({
  upload,
  destroy,
  onSubmit,
  initialValue,
  parsingEnabled,
  handleRef,
  modelRef,
}: {
  upload: (file: File) => Promise<Attachment>;
  destroy: (attachmentId: string) => Promise<unknown>;
  onSubmit: () => void;
  initialValue: string;
  parsingEnabled: boolean;
  handleRef: Ref<AttachmentUploads>;
  modelRef: Ref<(modelId: string) => void>;
}) {
  const [value, setValue] = useState(initialValue);
  const [modelId, setModelId] = useState("text-only");
  const attachments = useAttachmentUploads({ upload, destroy });
  useImperativeHandle(handleRef, () => attachments);
  useImperativeHandle(modelRef, () => setModelId, []);
  void parsingEnabled;
  return (
    <ChatInput
      value={value}
      onValueChange={setValue}
      onSubmit={onSubmit}
      disabled={false}
      modelId={modelId}
      onModelChange={setModelId}
      searchEnabled={false}
      onSearchEnabledChange={() => {}}
      attachments={attachments}
    />
  );
}

const setup = (
  options: {
    upload?: (file: File) => Promise<Attachment>;
    initialValue?: string;
    parsingEnabled?: boolean;
  } = {},
): Harness => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  client.setQueryData(["chat-models"], MODELS);
  client.setQueryData(["tools", "web-search", "availability"], {
    configured: false,
    enabled: false,
  });
  client.setQueryData(["tools", "document-parsing", "availability"], {
    configured: true,
    enabled: options.parsingEnabled ?? true,
    kind: "local",
  });

  const onSubmit = vi.fn();
  const upload = vi.fn(options.upload ?? (() => Promise.resolve(dto())));
  const destroy = vi.fn(() => Promise.resolve());
  let handle: AttachmentUploads | null = null;
  let setModel: (modelId: string) => void = () => {};

  const { container } = render(
    <QueryClientProvider client={client}>
      <Suspense fallback={null}>
        <Harness
          upload={upload as unknown as (file: File) => Promise<Attachment>}
          destroy={destroy}
          onSubmit={onSubmit}
          initialValue={options.initialValue ?? ""}
          parsingEnabled={options.parsingEnabled ?? true}
          handleRef={(value) => {
            handle = value;
          }}
          modelRef={(value) => {
            if (value) setModel = value;
          }}
        />
      </Suspense>
    </QueryClientProvider>,
  );

  return {
    onSubmit,
    upload,
    destroy,
    container,
    handle: () => handle!,
    setModel: (modelId) => act(() => setModel(modelId)),
  };
};

const fileInput = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>('input[type="file"]')!;

const pick = (harness: Harness, ...files: File[]) =>
  fireEvent.change(fileInput(harness.container), { target: { files } });

const sendButton = () => screen.getByRole("button", { name: /^Send$/ });
const queuedButton = () => screen.getByRole("button", { name: "Sending after uploads finish" });

beforeEach(() => {
  // jsdom has no object-URL implementation.
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
});

describe("ChatInput attachment picking", () => {
  it("opens the hidden file input from the plus menu", async () => {
    const harness = setup();
    const click = vi.spyOn(fileInput(harness.container), "click");

    fireEvent.click(screen.getByRole("button", { name: "Add attachment" }));
    fireEvent.click(await screen.findByText("Attach files"));

    expect(click).toHaveBeenCalled();
  });

  it("accepts the configured file types and resets the input after a pick", () => {
    const harness = setup();
    const input = fileInput(harness.container);
    expect(input.accept).toContain("application/pdf");
    expect(input.multiple).toBe(true);

    pick(harness, textFile());
    expect(harness.upload).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("");
  });

  it("accepts a file drop on the shell", () => {
    const harness = setup();
    const shell = harness.container.firstElementChild!;
    const dataTransfer = { files: [textFile()], types: ["Files"] };

    fireEvent.dragEnter(shell, { dataTransfer });
    fireEvent.drop(shell, { dataTransfer });

    expect(harness.upload).toHaveBeenCalledTimes(1);
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
  });

  it("shows the drop overlay while a file drag hovers the shell", () => {
    const harness = setup();
    const shell = harness.container.firstElementChild!;
    const dataTransfer = { files: [], types: ["Files"] };

    fireEvent.dragEnter(shell, { dataTransfer });
    expect(screen.getByText("Drop files to attach")).toBeInTheDocument();

    fireEvent.dragLeave(shell, { dataTransfer });
    expect(screen.queryByText("Drop files to attach")).not.toBeInTheDocument();
  });

  it("ignores drags that carry no files", () => {
    const harness = setup();
    const shell = harness.container.firstElementChild!;
    fireEvent.drop(shell, { dataTransfer: { files: [], types: ["text/plain"] } });
    expect(harness.upload).not.toHaveBeenCalled();
  });

  it("stops after the per-message limit and explains why", () => {
    const harness = setup();
    pick(harness, ...Array.from({ length: 6 }, (_, i) => textFile(`f${i}.txt`)));

    expect(harness.upload).toHaveBeenCalledTimes(5);
    expect(screen.getByText("You can attach at most 5 files per message.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add attachment" })).toBeDisabled();
  });
});

describe("ChatInput paste", () => {
  const paste = (harness: Harness, data: { files?: File[]; text?: string }) => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { files: data.files ?? [], getData: () => data.text ?? "" },
    });
    fireEvent(harness.container.firstElementChild!, event);
    return event;
  };

  it("uploads files pasted from the clipboard", () => {
    const harness = setup();
    paste(harness, { files: [imageFile()] });
    expect(harness.upload).toHaveBeenCalledTimes(1);
  });

  it("turns a large text paste into an attachment", () => {
    const harness = setup();
    const event = paste(harness, { text: "x".repeat(2_001) });

    expect(event.defaultPrevented).toBe(true);
    expect(harness.upload).toHaveBeenCalledTimes(1);
    expect((harness.upload.mock.calls[0]![0] as File).name).toBe("pasted-text.txt");
  });

  it("leaves a small text paste to the textarea", () => {
    const harness = setup();
    const event = paste(harness, { text: "short" });

    expect(event.defaultPrevented).toBe(false);
    expect(harness.upload).not.toHaveBeenCalled();
  });
});

describe("ChatInput upload state", () => {
  it("shows a spinner while uploading and the size once complete", async () => {
    const pending = deferred<Attachment>();
    const harness = setup({ upload: () => pending.promise });
    pick(harness, textFile());

    expect(screen.getByText("Uploading…")).toBeInTheDocument();
    expect(screen.getByTitle("notes.txt")).toHaveAttribute("aria-busy", "true");

    await act(async () => {
      pending.resolve(dto({ fileName: "notes.txt" }));
    });
    expect(screen.queryByText("Uploading…")).not.toBeInTheDocument();
    // The chip keeps showing the local file's size, not the DTO's.
    expect(screen.getByText("5 B")).toBeInTheDocument();
  });

  it("surfaces a failed upload and blocks sending", async () => {
    const harness = setup({ upload: () => Promise.reject(new Error("Upload failed.")) });
    pick(harness, textFile());

    expect(await screen.findByText("Upload failed.")).toBeInTheDocument();
    expect(sendButton()).toBeDisabled();
  });

  it("rejects a file over the size limit without uploading it", () => {
    const harness = setup();
    const huge = new File([""], "huge.bin", { type: "text/plain" });
    Object.defineProperty(huge, "size", { value: 21 * 1024 * 1024 });
    pick(harness, huge);

    expect(harness.upload).not.toHaveBeenCalled();
    expect(screen.getByText("Too large — the limit is 20.0 MB.")).toBeInTheDocument();
  });
});

describe("ChatInput removal", () => {
  it("deletes a completed attachment on removal", async () => {
    const harness = setup({ upload: () => Promise.resolve(dto({ id: "a-1" })) });
    pick(harness, textFile());
    await waitFor(() => expect(harness.handle().items[0]?.status).toBe("complete"));

    fireEvent.click(screen.getByRole("button", { name: "Remove notes.txt" }));

    expect(harness.destroy).toHaveBeenCalledWith("a-1");
    expect(screen.queryByText("notes.txt")).not.toBeInTheDocument();
  });

  it("deletes an in-flight attachment once its upload settles", async () => {
    const pending = deferred<Attachment>();
    const harness = setup({ upload: () => pending.promise });
    pick(harness, textFile());

    fireEvent.click(screen.getByRole("button", { name: "Remove notes.txt" }));
    expect(screen.queryByText("notes.txt")).not.toBeInTheDocument();
    expect(harness.destroy).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve(dto({ id: "a-late" }));
    });
    expect(harness.destroy).toHaveBeenCalledWith("a-late");
  });
});

describe("ChatInput submitting", () => {
  it("sends an attachment-only message", async () => {
    const harness = setup();
    expect(sendButton()).toBeDisabled();

    pick(harness, textFile());
    await waitFor(() => expect(sendButton()).toBeEnabled());

    fireEvent.click(sendButton());
    expect(harness.onSubmit).toHaveBeenCalledTimes(1);
  });

  it("queues the send until every upload settles, then fires once", async () => {
    const first = deferred<Attachment>();
    const second = deferred<Attachment>();
    const uploads = [first, second];
    let index = 0;
    const harness = setup({ upload: () => uploads[index++]!.promise });
    pick(harness, textFile("a.txt"), textFile("b.txt"));

    act(() => harness.handle().submit(() => harness.onSubmit()));
    expect(harness.onSubmit).not.toHaveBeenCalled();
    expect(queuedButton()).toBeDisabled();

    await act(async () => {
      first.resolve(dto());
    });
    expect(harness.onSubmit).not.toHaveBeenCalled();

    await act(async () => {
      second.resolve(dto());
    });
    expect(harness.onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Sending after uploads finish" })).toBeNull();
  });

  it("cancels the queued send when an upload fails", async () => {
    const pending = deferred<Attachment>();
    const harness = setup({ initialValue: "keep me", upload: () => pending.promise });
    pick(harness, textFile());

    act(() => harness.handle().submit(() => harness.onSubmit()));
    await act(async () => {
      pending.reject(new Error("nope"));
    });

    expect(harness.onSubmit).not.toHaveBeenCalled();
    // Draft and chip survive so the user can retry.
    expect(screen.getByRole("textbox")).toHaveValue("keep me");
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
  });
});

describe("ChatInput preview", () => {
  it("opens an in-app preview for a completed chip", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("file body", { status: 200 }));
    const harness = setup({
      upload: () => Promise.resolve(dto({ id: "a-9", fileName: "notes.txt" })),
    });
    pick(harness, textFile());
    const previewButton = await screen.findByRole("button", { name: "Preview notes.txt" });

    fireEvent.click(previewButton);

    expect(await screen.findByText("file body")).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledWith("/api/files/a-9");
    fetchSpy.mockRestore();
  });

  it("renders a markdown attachment and toggles back to the plain source", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("# Title\n\nbody text", { status: 200 }));
    const harness = setup({
      upload: () => Promise.resolve(dto({ id: "a-md", fileName: "notes.md" })),
    });
    pick(harness, new File(["# Title"], "notes.md", { type: "text/markdown" }));

    fireEvent.click(await screen.findByRole("button", { name: "Preview notes.md" }));

    expect(await screen.findByRole("heading", { name: "Title" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Plain" }));

    expect(screen.queryByRole("heading", { name: "Title" })).not.toBeInTheDocument();
    expect(screen.getByText(/# Title/)).toBeInTheDocument();
    fetchSpy.mockRestore();
  });

  it("highlights a source file as a code block and toggles back to plain", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("const x = 1;", { status: 200 }));
    const harness = setup({
      upload: () => Promise.resolve(dto({ id: "a-ts", fileName: "app.ts" })),
    });
    pick(harness, new File(["const x = 1;"], "app.ts", { type: "text/plain" }));

    fireEvent.click(await screen.findByRole("button", { name: "Preview app.ts" }));

    // streamdown's own code block — the fence we wrap the file in is consumed,
    // not shown, and the extension picks the language. Polled because
    // highlighting swaps the body in asynchronously.
    await waitFor(() => {
      const block = document.querySelector('[data-language="typescript"]');
      expect(block?.textContent).toContain("const x = 1;");
    });
    expect(screen.queryByText(/```/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Plain" }));

    expect(screen.getByText("const x = 1;").tagName).toBe("PRE");
    fetchSpy.mockRestore();
  });

  it("keeps a non-markdown text file on the plain view only", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("# not a heading", { status: 200 }));
    const harness = setup({
      upload: () => Promise.resolve(dto({ id: "a-txt", fileName: "notes.txt" })),
    });
    pick(harness, textFile());

    fireEvent.click(await screen.findByRole("button", { name: "Preview notes.txt" }));

    expect(await screen.findByText("# not a heading")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rendered" })).not.toBeInTheDocument();
    fetchSpy.mockRestore();
  });

  it("keeps the preview disabled while the upload is still in flight", () => {
    const pending = deferred<Attachment>();
    const harness = setup({ upload: () => pending.promise });
    pick(harness, textFile());

    expect(screen.getByRole("button", { name: "Preview notes.txt" })).toBeDisabled();
  });
});

describe("ChatInput model compatibility", () => {
  it("warns and blocks while the selected model cannot read an image", async () => {
    const harness = setup({
      initialValue: "look",
      upload: () => Promise.resolve(dto({ fileName: "shot.png", kind: "image" })),
    });
    pick(harness, imageFile());

    expect(
      await screen.findByText(
        "Text Only cannot read images — pick another model or remove this file.",
      ),
    ).toBeInTheDocument();
    expect(sendButton()).toBeDisabled();

    harness.setModel("vision");

    expect(screen.queryByText(/cannot read images/)).not.toBeInTheDocument();
    expect(sendButton()).toBeEnabled();
  });

  it("only warns about PDFs when local parsing is unavailable too", async () => {
    const pdf = new File(["%PDF"], "paper.pdf", { type: "application/pdf" });
    const withParsing = setup({
      initialValue: "read",
      upload: () => Promise.resolve(dto({ fileName: "paper.pdf", kind: "pdf" })),
    });
    pick(withParsing, pdf);
    await waitFor(() => expect(sendButton()).toBeEnabled());
    expect(screen.queryByText(/cannot read PDFs/)).not.toBeInTheDocument();
    withParsing.container.remove();

    const withoutParsing = setup({
      initialValue: "read",
      parsingEnabled: false,
      upload: () => Promise.resolve(dto({ fileName: "paper.pdf", kind: "pdf" })),
    });
    pick(withoutParsing, pdf);
    expect(await screen.findByText(/cannot read PDFs/)).toBeInTheDocument();
  });
});
