import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Image01Icon, ViewIcon } from "@hugeicons/core-free-icons";
import { CAPABILITY_META, CapabilityIcons } from "./capability-icons.tsx";
const capabilities = { tools: true, reasoning: true, vision: true, files: true };
describe("CapabilityIcons", () => {
  it("preserves full native capability metadata for admin displays", () => {
    render(<CapabilityIcons capabilities={capabilities} />);
    expect(screen.getByRole("img", { name: "Native tool calling" })).toBeVisible();
    expect(screen.getByRole("img", { name: "Reasoning" })).toBeVisible();
    expect(screen.getByRole("img", { name: "Vision" })).toBeVisible();
  });
  it("uses plain file labels and never distinguishes native tools for users", () => {
    const { rerender } = render(<CapabilityIcons capabilities={capabilities} audience="user" />);
    expect(screen.getByRole("img", { name: "Reads images" })).toBeVisible();
    expect(screen.getByRole("img", { name: "Reads files" })).toBeVisible();
    expect(screen.queryByRole("img", { name: "Reasoning" })).not.toBeInTheDocument();
    rerender(<CapabilityIcons capabilities={capabilities} audience="user" details />);
    expect(screen.getByRole("img", { name: "Reasoning" })).toBeVisible();
    expect(screen.queryByRole("img", { name: "Native tool calling" })).not.toBeInTheDocument();
  });
});

it("labels image generation with an image icon, independently of vision", () => {
  const capability = CAPABILITY_META.find((item) => item.key === "imageOutput");
  expect(capability).toMatchObject({ label: "Image generation", icon: Image01Icon });
  expect(capability?.icon).not.toBe(ViewIcon);
  render(<CapabilityIcons capabilities={{ ...capabilities, imageOutput: true }} />);
  expect(screen.getByRole("img", { name: "Image generation" })).toBeVisible();
  expect(screen.getByRole("img", { name: "Vision" })).toBeVisible();
});
