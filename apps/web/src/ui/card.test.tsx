import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it } from "vitest";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./card.tsx";
import { ListCard, ListRow } from "./page-shell.tsx";

const expectFlatSurface = (surface: HTMLElement) => {
  expect(surface).toHaveClass(
    "border",
    "border-border",
    "rounded-3xl",
    "bg-background",
    "text-foreground",
    "shadow-none",
    "ring-0",
    "dark:ring-0",
  );
  expect(surface).not.toHaveClass(
    "rounded-4xl",
    "bg-card",
    "text-card-foreground",
    "shadow-md",
    "ring-1",
  );
};

describe("app cards", () => {
  it("shares flat light and dark surfaces with lists without adding card layout to lists", () => {
    render(
      <>
        <Card data-testid="card">Padded content</Card>
        <ListCard>
          <ListRow>List content</ListRow>
        </ListCard>
      </>,
    );
    const card = screen.getByTestId("card");
    const list = screen.getByText("List content").parentElement!;
    expectFlatSurface(card);
    expectFlatSurface(list);
    expect(card).toHaveClass("flex", "flex-col", "py-(--card-spacing)");
    expect(list).toHaveClass("divide-y", "divide-border", "overflow-hidden");
    expect(list).not.toHaveClass("flex", "flex-col", "py-(--card-spacing)", "gap-(--card-spacing)");
  });

  it("preserves sizes, slots, DOM props and refs", () => {
    const ref = createRef<HTMLDivElement>();
    const headerRef = createRef<HTMLDivElement>();
    const footerRef = createRef<HTMLDivElement>();
    const { container } = render(
      <Card ref={ref} size="sm" id="usage-card" aria-label="Usage" className="min-w-0 gap-3">
        <CardHeader ref={headerRef}>
          <CardTitle>Title</CardTitle>
          <CardDescription>Description</CardDescription>
          <CardAction>Action</CardAction>
        </CardHeader>
        <CardContent>Content</CardContent>
        <CardFooter ref={footerRef}>Footer</CardFooter>
      </Card>,
    );
    const card = screen.getByLabelText("Usage");
    expect(ref.current).toBe(card);
    expect(card).toHaveAttribute("id", "usage-card");
    expect(card).toHaveAttribute("data-size", "sm");
    expect(card).toHaveClass("min-w-0", "gap-3", "data-[size=sm]:[--card-spacing:--spacing(4)]");
    expect(card).not.toHaveClass("gap-(--card-spacing)");
    for (const slot of [
      "card",
      "card-header",
      "card-title",
      "card-description",
      "card-action",
      "card-content",
      "card-footer",
    ]) {
      expect(container.querySelector(`[data-slot="${slot}"]`)).not.toBeNull();
    }
    expect(headerRef.current).toHaveAttribute("data-slot", "card-header");
    expect(footerRef.current).toHaveAttribute("data-slot", "card-footer");
  });

  it("aligns header, footer and image corners while retaining primitive spacing", () => {
    render(
      <Card data-testid="card">
        <CardHeader data-testid="header">Header</CardHeader>
        <CardFooter data-testid="footer">Footer</CardFooter>
      </Card>,
    );
    const card = screen.getByTestId("card");
    expect(card).toHaveAttribute("data-size", "default");
    expect(card).toHaveClass(
      "[--card-spacing:--spacing(6)]",
      "has-[>img:first-child]:pt-0",
      "*:[img:first-child]:rounded-t-3xl",
      "*:[img:last-child]:rounded-b-3xl",
    );
    expect(card).not.toHaveClass(
      "*:[img:first-child]:rounded-t-4xl",
      "*:[img:last-child]:rounded-b-4xl",
    );
    expect(screen.getByTestId("header")).toHaveClass("rounded-t-3xl", "px-(--card-spacing)");
    expect(screen.getByTestId("header")).not.toHaveClass("rounded-t-4xl");
    expect(screen.getByTestId("footer")).toHaveClass("rounded-b-3xl", "px-(--card-spacing)");
    expect(screen.getByTestId("footer")).not.toHaveClass("rounded-b-4xl");
  });
});
