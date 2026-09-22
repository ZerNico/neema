import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CreateSplitButton } from "./create-split-button.tsx";

const renderButton = (disabled = false) =>
  render(
    <CreateSplitButton
      label="New thing"
      disabled={disabled}
      chat={<a href="/chat-draft" />}
      manual={<a href="/things/new" />}
    />,
  );

describe("CreateSplitButton", () => {
  it("creates through chat by default and offers the manual form in its menu", async () => {
    renderButton();
    expect(screen.getByRole("link", { name: "New thing" })).toHaveAttribute("href", "/chat-draft");
    fireEvent.click(screen.getByRole("button", { name: "More ways to create: New thing" }));
    expect(await screen.findByRole("menuitem", { name: "Create with chat" })).toHaveAttribute(
      "href",
      "/chat-draft",
    );
    expect(screen.getByRole("menuitem", { name: "Set up manually" })).toHaveAttribute(
      "href",
      "/things/new",
    );
  });

  it("disables both halves at a limit instead of hiding them", () => {
    renderButton(true);
    expect(screen.getByRole("button", { name: "New thing" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "More ways to create: New thing" })).toBeDisabled();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
