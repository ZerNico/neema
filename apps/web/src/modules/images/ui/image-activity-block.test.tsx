import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AssistantFile } from "~/modules/chat/assistant-output.ts";
import type { ImageToolActivity } from "~/modules/chat/client/use-message-stream.ts";
import { GenuiActionsContext, type GenuiActions } from "~/modules/genui/ui/context.ts";
import { ImageActivityBlock } from "./image-activity-block.tsx";

const base: ImageToolActivity = {
  family: "image",
  name: "generate_image",
  callId: "call-1",
  status: "running",
  model: "GPT Image",
  editing: false,
  aspectRatio: "16:9",
  requested: 2,
};

const file = (id: string): AssistantFile => ({
  v: 1,
  attachment: { id, fileName: `${id}.png`, mediaType: "image/png", size: 10, kind: "image" },
  textOffset: 0,
  turnIndex: 0,
  eventIndex: 0,
  callIndex: 0,
  origin: { toolCallId: "call-1" },
  source: "image-tool",
});

const actions = (offer: (text: string) => void): GenuiActions => ({
  tailId: undefined,
  disabled: false,
  send: () => {},
  offer,
  save: async () => {},
  lookupMap: async () => ({ lookups: null, busy: false }),
});

describe("ImageActivityBlock", () => {
  it("holds a frame of the asked shape for each image while the model draws", () => {
    render(<ImageActivityBlock activity={base} files={[]} />);
    expect(screen.getByText("Creating images")).toBeInTheDocument();
    const frames = screen.getAllByRole("img", { name: "Creating images" });
    expect(frames).toHaveLength(2);
    expect(frames[0]).toHaveStyle({ aspectRatio: "16 / 9" });
  });

  it("draws the model's newest draft in the frame while it streams", () => {
    const { container } = render(
      <ImageActivityBlock
        activity={{ ...base, requested: 1 }}
        files={[]}
        preview="data:image/png;base64,AAAA"
      />,
    );
    const draft = container.querySelector('img[src="data:image/png;base64,AAAA"]');
    expect(draft).not.toBeNull();
    // Decorative: the frame itself names what is happening.
    expect(draft).toHaveAttribute("alt", "");
    expect(screen.getByRole("img", { name: "Creating image" })).toBeInTheDocument();
  });

  it("shows the images in place of the frames, with the model it used", () => {
    render(
      <ImageActivityBlock
        activity={{
          ...base,
          status: "complete",
          quality: "high",
          adjustments: ["Made 3:2 instead of 16:9."],
        }}
        files={[file("a"), file("b")]}
      />,
    );
    expect(screen.queryByText("Creating images")).toBeNull();
    expect(screen.getAllByRole("img", { name: "Image made with GPT Image" })).toHaveLength(2);
    expect(screen.getByText("Made with GPT Image")).toBeInTheDocument();
    // Shown only when it was sent; capitalized by CSS, which jsdom does not apply.
    expect(screen.getByText("high")).toBeInTheDocument();
    expect(screen.getByText("Made 3:2 instead of 16:9.")).toBeInTheDocument();
  });

  it("says a refusal in the provider's words instead of an empty frame", () => {
    render(
      <ImageActivityBlock
        activity={{ ...base, status: "error", refusal: "Rejected by the safety system." }}
        files={[]}
      />,
    );
    expect(screen.getByText("GPT Image declined")).toBeInTheDocument();
    expect(screen.getByText("Rejected by the safety system.")).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("puts an image into the composer as a reference to edit", async () => {
    const user = userEvent.setup();
    const offer = vi.fn();
    render(
      <GenuiActionsContext value={actions(offer)}>
        <ImageActivityBlock activity={{ ...base, status: "complete" }} files={[file("a")]} />
      </GenuiActionsContext>,
    );
    await user.click(screen.getByRole("button", { name: "Edit image" }));
    expect(offer).toHaveBeenCalledWith("[a.png](/api/files/a) ");
  });

  it("offers no edit where the conversation cannot take a draft", () => {
    render(<ImageActivityBlock activity={{ ...base, status: "complete" }} files={[file("a")]} />);
    expect(screen.queryByRole("button", { name: "Edit image" })).toBeNull();
    expect(screen.getByRole("link", { name: "Download image" })).toHaveAttribute(
      "download",
      "a.png",
    );
  });
});
