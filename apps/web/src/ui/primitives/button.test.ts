import { describe, expect, it } from "vitest";
import { buttonVariants } from "~/ui/primitives/button";
describe("buttonVariants", () => {
  it("keeps the outline border instead of the base transparent one", () => {
    const classes = buttonVariants({ size: "sm", variant: "outline" }).split(" ");
    expect(classes).toContain("border-border");
    expect(classes).not.toContain("border-transparent");
  });
  it("keeps filled variants borderless", () => {
    expect(buttonVariants({ variant: "default" }).split(" ")).toContain("border-transparent");
  });
});
