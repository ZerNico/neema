import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { Disclosure, DisclosureContent, DisclosureTrigger } from "./disclosure.tsx";

const animationClasses = [
  "h-[var(--collapsible-panel-height)]",
  "overflow-hidden",
  "opacity-100",
  "transition-[height,opacity]",
  "duration-200",
  "ease-out",
  "data-ending-style:h-0",
  "data-ending-style:opacity-0",
  "data-starting-style:h-0",
  "data-starting-style:opacity-0",
  "motion-reduce:transition-none",
  "[&[hidden]:not([hidden='until-found'])]:hidden",
];

describe("DisclosureContent", () => {
  it("supplies the shared animation defaults and merges caller classes", () => {
    const { rerender } = render(
      <Disclosure defaultOpen>
        <DisclosureContent data-testid="panel">Details</DisclosureContent>
      </Disclosure>,
    );

    expect(screen.getByTestId("panel")).toHaveClass(...animationClasses);

    rerender(
      <Disclosure defaultOpen>
        <DisclosureContent data-testid="panel" className="duration-300 px-3">
          Details
        </DisclosureContent>
      </Disclosure>,
    );

    expect(screen.getByTestId("panel")).toHaveClass("duration-300", "px-3");
    expect(screen.getByTestId("panel")).not.toHaveClass("duration-200");
    expect(screen.getByTestId("panel")).toHaveClass("transition-[height,opacity]");
  });

  it("evaluates callback className with Base UI state without losing animation classes", () => {
    const className = vi.fn((state: { open: boolean }) => (state.open ? "px-3" : "px-1"));
    const { rerender } = render(
      <Disclosure open>
        <DisclosureContent keepMounted data-testid="panel" className={className}>
          Details
        </DisclosureContent>
      </Disclosure>,
    );

    expect(className).toHaveBeenLastCalledWith(expect.objectContaining({ open: true }));
    expect(screen.getByTestId("panel")).toHaveClass(...animationClasses, "px-3");

    rerender(
      <Disclosure open={false}>
        <DisclosureContent keepMounted data-testid="panel" className={className}>
          Details
        </DisclosureContent>
      </Disclosure>,
    );

    expect(className).toHaveBeenLastCalledWith(expect.objectContaining({ open: false }));
    expect(screen.getByTestId("panel")).toHaveClass(...animationClasses, "px-1");
    expect(screen.getByTestId("panel")).not.toHaveClass("px-3");
  });

  it("preserves refs, render composition, props, events, and keepMounted", () => {
    const ref = createRef<HTMLDivElement>();
    const onClick = vi.fn();
    render(
      <Disclosure defaultOpen>
        <DisclosureTrigger>Toggle details</DisclosureTrigger>
        <DisclosureContent
          ref={ref}
          render={<div role="region" />}
          keepMounted
          id="details"
          aria-label="Details"
          data-testid="panel"
          style={{ paddingTop: 7 }}
          onClick={onClick}
        >
          Details body
        </DisclosureContent>
      </Disclosure>,
    );

    const panel = screen.getByTestId("panel");
    expect(ref.current).toBe(panel);
    expect(panel).toHaveAttribute("role", "region");
    expect(panel).toHaveAttribute("id", "details");
    expect(panel).toHaveAttribute("aria-label", "Details");
    expect(panel).toHaveAttribute("data-slot", "collapsible-content");
    expect(panel).toHaveStyle({ paddingTop: "7px" });
    expect(panel).toHaveTextContent("Details body");
    fireEvent.click(panel);
    expect(onClick).toHaveBeenCalledOnce();

    const trigger = screen.getByRole("button", { name: "Toggle details" });
    expect(trigger).toHaveAttribute("aria-controls", "details");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("panel")).toBe(panel);
    expect(ref.current).toBe(panel);
  });
});
