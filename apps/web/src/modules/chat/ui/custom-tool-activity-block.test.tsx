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
});
