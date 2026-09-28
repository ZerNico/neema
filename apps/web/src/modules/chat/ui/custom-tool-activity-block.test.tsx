import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CustomToolActivityBlock } from "./custom-tool-activity-block.tsx";

const failedActivity = {
  family: "custom" as const,
  version: 1 as const,
  name: "custom_catalog__lookup",
  displayName: "Lookup",
  status: "error" as const,
  callId: "call-1",
  error: "The upstream service refused the request.",
};

describe("CustomToolActivityBlock", () => {
  it("reveals an error even when the call has no result preview", async () => {
    const user = userEvent.setup();
    render(<CustomToolActivityBlock activity={failedActivity} />);

    const trigger = screen.getByRole("button", { name: /Lookup failed/ });
    expect(screen.queryByText(failedActivity.error)).toBeNull();

    await user.click(trigger);

    expect(screen.getByText(failedActivity.error)).toBeVisible();
  });

  it("names each working file's state in the words the deck row uses", async () => {
    const user = userEvent.setup();
    const activity = {
      family: "custom" as const,
      name: "custom_decks__build",
      displayName: "Build deck",
      status: "complete" as const,
      callId: "call-2",
      workingFiles: [
        { id: "a", revision: 1, name: "A.pptx" },
        { id: "b", revision: 1, name: "B.pptx" },
      ],
    };
    const { rerender } = render(
      <CustomToolActivityBlock activity={activity} published={new Set(["a"])} />,
    );
    await user.click(screen.getByRole("button", { name: /^Build deck · Working/ }));
    expect(screen.getByText("A.pptx · Published")).toBeInTheDocument();
    expect(screen.getByText("B.pptx · Working")).toBeInTheDocument();
    rerender(<CustomToolActivityBlock activity={activity} published={new Set(["a"])} terminal />);
    expect(screen.getByText("B.pptx · Draft")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Build deck · Draft/ })).toBeInTheDocument();
    rerender(
      <CustomToolActivityBlock activity={activity} published={new Set(["a", "b"])} terminal />,
    );
    expect(screen.getByRole("button", { name: /^Build deck · Published/ })).toBeInTheDocument();
  });
});
