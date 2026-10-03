import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelSelect } from "./model-select.tsx";

vi.stubGlobal(
  "matchMedia",
  vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
);

const MODELS = [
  { id: "m1", displayName: "Qwen3 Embedding 8B", providerName: "OpenRouter", detail: "4096d" },
  { id: "m2", displayName: "Sonnet", providerName: "Anthropic" },
];

describe("ModelSelect", () => {
  it("shows the chosen model by name and provider, never by id", () => {
    render(<ModelSelect models={MODELS} value="m1" onChange={() => {}} aria-label="Model" />);
    const trigger = screen.getByRole("combobox", { name: "Model" });
    // Name and provider are separate spans, drawn as in the list.
    expect(trigger).toHaveTextContent("Qwen3 Embedding 8BOpenRouter · 4096d");
    expect(trigger).not.toHaveTextContent("m1");
  });

  it("lists rows with provider and optional detail, and reports the picked id", async () => {
    const onChange = vi.fn();
    render(<ModelSelect models={MODELS} value={null} onChange={onChange} aria-label="Model" />);
    const trigger = screen.getByRole("combobox", { name: "Model" });
    expect(trigger).toHaveTextContent("Choose a model");
    fireEvent.click(trigger);
    const wide = await screen.findByRole("option", { name: /Qwen3 Embedding 8B/ });
    expect(wide).toHaveTextContent("OpenRouter · 4096d");
    expect(screen.getByRole("option", { name: /Sonnet/ })).not.toHaveTextContent("·");
    fireEvent.click(wide);
    expect(onChange).toHaveBeenCalledWith("m1");
  });

  it("disables itself with an explanatory placeholder when there is nothing to pick", () => {
    render(
      <ModelSelect
        models={[]}
        value={null}
        onChange={() => {}}
        aria-label="Model"
        emptyPlaceholder="Add a model first"
      />,
    );
    const trigger = screen.getByRole("combobox", { name: "Model" });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveTextContent("Add a model first");
  });
});
