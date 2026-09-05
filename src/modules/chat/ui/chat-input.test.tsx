import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Suspense, useImperativeHandle, useState, type Ref } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatInput } from "./chat-input.tsx";
import { renderToString } from "react-dom/server";
import { useSearchMode } from "./use-search-mode.ts";
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

function DefaultProbe({ initialModelId }: { initialModelId: string | null }) {
  const [modelId, setModelId] = useState(initialModelId);
  const [searchEnabled, setSearchEnabled] = useState(true);
  return (
    <>
      <output data-testid="selected-default">{modelId ?? "none"}</output>
      <output data-testid="default-search">{searchEnabled ? "on" : "off"}</output>
      <button onClick={() => setModelId("text-only")}>Choose Alpha</button>
      <ChatInput
        value=""
        onValueChange={() => {}}
        onSubmit={() => {}}
        disabled={false}
        modelId={modelId}
        onModelChange={setModelId}
        searchEnabled={searchEnabled}
        onSearchEnabledChange={setSearchEnabled}
      />
    </>
  );
}
const renderDefaultProbe = (
  initialModelId: string | null,
  rows = MODELS.map((entry) => ({ ...entry, isDefault: entry.id === "vision" })),
) => {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(["chat-models"], rows);
  client.setQueryData(["tools", "web-search", "availability"], { configured: true, enabled: true });
  render(
    <QueryClientProvider client={client}>
      <DefaultProbe initialModelId={initialModelId} />
    </QueryClientProvider>,
  );
  return client;
};

describe("ChatInput default model", () => {
  it.each([null, "removed"])(
    "selects the marked default for %s rather than the first row",
    (initialModelId) => {
      renderDefaultProbe(initialModelId);
      expect(screen.getByTestId("selected-default")).toHaveTextContent("vision");
      expect(screen.getByTestId("default-search")).toHaveTextContent("off");
    },
  );

  it("preserves valid conversation and manual selections through policy refreshes", () => {
    const client = renderDefaultProbe("text-only");
    expect(screen.getByTestId("selected-default")).toHaveTextContent("text-only");
    act(() =>
      client.setQueryData(
        ["chat-models"],
        MODELS.map((entry) => ({ ...entry, isDefault: true })),
      ),
    );
    expect(screen.getByTestId("selected-default")).toHaveTextContent("text-only");
  });

  it("does not enforce changed defaults on an already selected new chat", async () => {
    const client = renderDefaultProbe(null);
    expect(screen.getByTestId("selected-default")).toHaveTextContent("vision");
    act(() =>
      client.setQueryData(
        ["chat-models"],
        MODELS.map((entry) => ({ ...entry, isDefault: entry.id === "text-only" })),
      ),
    );
    expect(screen.getByTestId("selected-default")).toHaveTextContent("vision");
    fireEvent.click(screen.getByRole("button", { name: "Choose Alpha" }));
    act(() => client.setQueryData(["chat-models"], [{ ...MODELS[1]!, isDefault: true }]));
    await waitFor(() => expect(screen.getByTestId("selected-default")).toHaveTextContent("vision"));
  });

  it("falls back defensively when an older response has no default marker", () => {
    renderDefaultProbe(
      null,
      MODELS.map((entry) => ({ ...entry, isDefault: false })),
    );
    expect(screen.getByTestId("selected-default")).toHaveTextContent("text-only");
  });

  it("leaves an empty list unselected", () => {
    renderDefaultProbe(null, []);
    expect(screen.getByTestId("selected-default")).toHaveTextContent("none");
  });
});

function InitialControls({
  modelId,
  onModelChange,
  onSubmit,
}: {
  modelId: string | null;
  onModelChange: (id: string) => void;
  onSubmit: () => void;
}) {
  const search = useSearchMode(modelId);
  return (
    <ChatInput
      value="Hello"
      onValueChange={() => {}}
      onSubmit={onSubmit}
      disabled={false}
      modelId={modelId}
      onModelChange={onModelChange}
      searchEnabled={search.enabled}
      onSearchEnabledChange={search.setEnabled}
    />
  );
}

describe("ChatInput first render", () => {
  it.each([
    { id: null, label: "Vision Model", search: true, configured: true, empty: false },
    { id: "removed", label: "Vision Model", search: true, configured: true, empty: false },
    { id: "vision", label: "Vision Model", search: true, configured: true, empty: false },
    { id: "text-only", label: "Text Only", search: false, configured: true, empty: false },
    { id: null, label: "Vision Model", search: false, configured: false, empty: false },
    { id: null, label: "Select model", search: false, configured: true, empty: true },
  ])(
    "renders the resolved controls before effects: %#",
    ({ id, label, search, configured, empty }) => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      client.setQueryData(
        ["chat-models"],
        empty
          ? []
          : MODELS.map((entry) => ({
              ...entry,
              isDefault: entry.id === "vision",
              capabilities: { ...entry.capabilities, tools: entry.id === "vision" },
            })),
      );
      client.setQueryData(["tools", "web-search", "availability"], {
        configured,
        enabled: configured,
      });
      const onModelChange = vi.fn();
      const onSubmit = vi.fn();
      const input = (modelId: string | null) => (
        <QueryClientProvider client={client}>
          <InitialControls modelId={modelId} onModelChange={onModelChange} onSubmit={onSubmit} />
        </QueryClientProvider>
      );
      // Server rendering never runs effects: this catches a placeholder flash
      // that a normal Testing Library render (which flushes effects) would miss.
      const container = document.createElement("div");
      container.innerHTML = renderToString(input(id));
      const initial = within(container);
      expect(initial.getByRole("combobox")).toHaveTextContent(label);
      const toggle = initial.queryByRole("button", { name: "Search the web" });
      if (search) expect(toggle).toHaveAttribute("aria-pressed", "true");
      else expect(toggle).toBeNull();
      expect(onModelChange).not.toHaveBeenCalled();

      if (!empty && (id === null || id === "removed")) {
        expect(initial.getByRole("button", { name: "Send" })).toBeDisabled();
        const { rerender } = render(input(id));
        expect(onModelChange).toHaveBeenCalledWith("vision");
        // The owner has not applied the callback yet: neither click nor Enter
        // may send with a different model from the one shown in the trigger.
        fireEvent.click(sendButton());
        fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
        expect(onSubmit).not.toHaveBeenCalled();
        rerender(input("vision"));
        fireEvent.click(sendButton());
        expect(onSubmit).toHaveBeenCalledTimes(1);
      }
    },
  );
});

describe("ChatInput search toggle", () => {
  it("keeps enabled search distinct from the disabled hover style", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
    });
    client.setQueryData(
      ["chat-models"],
      [{ ...MODELS[0]!, capabilities: { ...MODELS[0]!.capabilities, tools: true } }],
    );
    client.setQueryData(["tools", "web-search", "availability"], {
      configured: true,
      enabled: true,
    });
    const onSearchEnabledChange = vi.fn();
    const input = (searchEnabled: boolean) => (
      <QueryClientProvider client={client}>
        <Suspense fallback={null}>
          <ChatInput
            value=""
            onValueChange={() => {}}
            onSubmit={() => {}}
            disabled={false}
            modelId="text-only"
            onModelChange={() => {}}
            searchEnabled={searchEnabled}
            onSearchEnabledChange={onSearchEnabledChange}
          />
        </Suspense>
      </QueryClientProvider>
    );
    const { rerender } = render(input(false));
    const toggle = screen.getByRole("button", { name: "Search the web" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveClass("text-muted-foreground", "hover:bg-muted");
    fireEvent.click(toggle);
    expect(onSearchEnabledChange).toHaveBeenLastCalledWith(true);

    rerender(input(true));
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveClass("bg-primary", "text-primary-foreground", "hover:bg-primary/80");
    for (const className of [
      "hover:bg-muted",
      "hover:text-foreground",
      "dark:hover:bg-muted/50",
      "text-muted-foreground",
    ]) {
      expect(toggle).not.toHaveClass(className);
    }
    fireEvent.click(toggle);
    expect(onSearchEnabledChange).toHaveBeenLastCalledWith(false);

    rerender(input(false));
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveClass("text-muted-foreground", "hover:bg-muted");
    expect(toggle).not.toHaveClass("bg-primary");
  });
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

  it("shows a source file in the line-numbered viewer, with no rendered toggle", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("const x = 1;", { status: 200 }));
    const harness = setup({
      upload: () => Promise.resolve(dto({ id: "a-ts", fileName: "app.ts" })),
    });
    pick(harness, new File(["const x = 1;"], "app.ts", { type: "text/plain" }));

    fireEvent.click(await screen.findByRole("button", { name: "Preview app.ts" }));

    // Source files go to CodeViewer, not through markdown: one line, numbered,
    // coloured once the grammar lands. "Rendered/Plain" is markdown-only.
    await waitFor(() => {
      expect(document.querySelectorAll("[data-shiki-token]").length).toBeGreaterThan(1);
    });
    expect(screen.getByText("const")).toBeInTheDocument();
    // One numbered line — the dialog's own chrome also carries aria-hidden, so
    // count the gutter cells next to the tokens rather than the whole document.
    const viewer = document.querySelector("[data-shiki-token]")!.closest(".font-mono")!;
    expect(viewer.querySelectorAll("[aria-hidden]")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Plain" })).not.toBeInTheDocument();
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
