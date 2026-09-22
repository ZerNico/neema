import { BubbleChatIcon, PencilEdit02Icon } from "@hugeicons/core-free-icons";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CreateSplitButton } from "./create-split-button.tsx";

const renderButton = (disabled = false) =>
  render(
    <CreateSplitButton
      label="New thing"
      disabled={disabled}
      options={[
        { label: "Create with chat", icon: BubbleChatIcon, link: <a href="/chat-draft" /> },
        { label: "Set up manually", icon: PencilEdit02Icon, link: <a href="/things/new" /> },
      ]}
    />,
  );

describe("CreateSplitButton", () => {
  it("does the first option on the button and lists every option in its menu", async () => {
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
