import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Attachment } from "~/modules/attachments/schema.ts";
import { LocalFileConversationProvider } from "~/modules/desktop/ui/local-file-preview.tsx";
import { AssistantMarkdown } from "./assistant-markdown.tsx";
import { FileReferenceContext, FileReferenceMachine } from "./file-reference-context.ts";

vi.mock("~/modules/desktop/client/bridge.ts", () => ({ useDesktop: () => null }));

const image: Attachment = {
  id: "image",
  fileName: "real.png",
  size: 20,
  kind: "image",
  mediaType: "image/png",
};
const queryClient = new QueryClient();
const context = {
  attachments: new Map([
    [image.id, image],
    ["other", { ...image, id: "other", fileName: "other.png" }],
  ]),
  aliases: { attachments: { old: "image" }, workspaceAncestors: ["source"] },
  machineId: "machine",
};
const view = (content: string, streaming = false) => (
  <QueryClientProvider client={queryClient}>
    <LocalFileConversationProvider conversationId="branch" workspaceRoot="/work/branch">
      <FileReferenceContext value={context}>
        <FileReferenceMachine value="machine">
          <AssistantMarkdown content={content} streaming={streaming} />
        </FileReferenceMachine>
      </FileReferenceContext>
    </LocalFileConversationProvider>
  </QueryClientProvider>
);

describe("assistant inline file references", () => {
  it("uses the actual file name and previews an inherited attachment through its current id", () => {
    render(view("Here is [misleading label](/api/files/old)."));
    expect(screen.queryByText("misleading label")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview real.png" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("img")).toHaveAttribute("src", "/api/files/image");
  });

  it("keeps an open preview mounted while the answer streams", () => {
    const { rerender } = render(view("Here is [file](/api/files/image).", true));
    const chip = screen.getByRole("button", { name: "Preview real.png" });
    fireEvent.click(chip);
    const dialog = screen.getByRole("dialog");
    rerender(view("Here is [file](/api/files/image). More text.", true));
    expect(screen.getByRole("button", { name: "Preview real.png", hidden: true })).toBe(chip);
    expect(screen.getByRole("dialog")).toBe(dialog);
  });

  it("closes the old preview when the referenced file identity changes", () => {
    const { rerender } = render(view("[file](/api/files/image)"));
    fireEvent.click(screen.getByRole("button", { name: "Preview real.png" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    rerender(view("[file](/api/files/other)"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview other.png" }));
    expect(within(screen.getByRole("dialog")).getByRole("img")).toHaveAttribute(
      "src",
      "/api/files/other",
    );
  });

  it("keeps unknown ids and malformed reserved links inert", () => {
    render(view("[missing](/api/files/unknown) [invalid](/local-file?path=relative)"));
    expect(screen.getByText("missing")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("invalid")).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("does not interpret bare names, code or image embeds as references", () => {
    render(
      view(
        "real.png `real.png` `[file](/api/files/image)`\n\n```text\n[file](/api/files/image)\n```\n\n![image](/api/files/image)",
      ),
    );
    expect(screen.queryByRole("button", { name: "Preview real.png" })).not.toBeInTheDocument();
  });

  it("retains Streamdown's normal-link safety confirmation", () => {
    render(view("[Example](https://example.com)"));
    fireEvent.click(screen.getByRole("button", { name: "Example" }));
    expect(screen.getByText("Open external link?")).toBeInTheDocument();
    expect(screen.getByText("https://example.com/")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open link" })).toBeInTheDocument();
  });

  it("keeps unfinished links inert until Streamdown has their destination", () => {
    const { rerender } = render(view("[file](/api/files/ima", true));
    expect(screen.queryByRole("button", { name: "Preview real.png" })).not.toBeInTheDocument();
    rerender(view("[file](/api/files/image)", true));
    expect(screen.getByRole("button", { name: "Preview real.png" })).toBeInTheDocument();
  });

  it.each([
    ["/Users/alex/work/a%20%23%25%2B%26.png", "a #%+&.png"],
    ["C:%5CUsers%5Calex%5Ca%20b.png", "a b.png"],
    ["%5C%5Cserver%5Cshare%5Ca.png", "a.png"],
  ])("handles transformed local href %s without a browser filesystem fallback", (path, name) => {
    render(view(`[file](/local-file?path=${path})`));
    expect(screen.getByRole("button", { name: `Unavailable file: ${name}` })).toBeDisabled();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("still strips undefined citation markers with always-on file components", () => {
    render(view("Answer[^7] [file](/api/files/image)"));
    expect(screen.queryByText(/\[\^7\]/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview real.png" })).toBeInTheDocument();
  });

  it("has no reference-count or text-prefix cutoff", () => {
    const content = `${"long prose ".repeat(24_000)}\n\n` + "[file](/api/files/image) ".repeat(130);
    render(view(content));
    expect(screen.getAllByRole("button", { name: "Preview real.png" })).toHaveLength(130);
  });
});
