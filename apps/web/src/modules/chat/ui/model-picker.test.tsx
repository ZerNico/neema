import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ModelPicker, type PickableModel } from "./model-picker.tsx";
import { Button } from "~/ui/primitives/button";

const model = (id: string, displayName: string, providerName: string): PickableModel => ({
  id,
  displayName,
  providerName,
  contextLength: 128_000,
  capabilities: { reasoning: false, tools: true, vision: false, files: false },
});

const MODELS = [
  model("sonnet", "Claude Sonnet 5", "Anthropic"),
  model("opus", "Claude Opus 5", "Anthropic"),
  model("gpt", "GPT-5", "OpenAI"),
];

const renderPicker = (props: Partial<Parameters<typeof ModelPicker>[0]> = {}) => {
  const onChange = vi.fn();
  render(
    <ModelPicker
      models={MODELS}
      value="sonnet"
      onChange={onChange}
      trigger={<Button aria-label="Change model" />}
      {...props}
    >
      <span>Claude Sonnet 5</span>
    </ModelPicker>,
  );
  return { onChange, user: userEvent.setup() };
};

// Base UI opens the popup off a native click on the trigger; userEvent's
// synthetic sequence leaves it shut in jsdom.
const openPicker = async () => {
  screen.getByRole("combobox", { name: "Change model" }).click();
  await screen.findByPlaceholderText("Search models…");
};

describe("ModelPicker", () => {
  it("keeps model rows compact without a details toggle", async () => {
    renderPicker();
    await openPicker();
    expect(screen.queryByText("128k")).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Native tool calling" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show model details" })).not.toBeInTheDocument();
  });

  it("keeps capability tooltips inside selectable model rows", async () => {
    const { user, onChange } = renderPicker({
      models: [{ ...MODELS[0]!, capabilities: { ...MODELS[0]!.capabilities!, imageOutput: true } }],
    });
    await openPicker();
    const icon = screen.getByRole("img", { name: "Image generation" });
    await user.hover(icon);
    expect(await screen.findByText("Image generation")).toHaveAttribute(
      "data-slot",
      "tooltip-content",
    );
    expect(icon.closest('[role="option"]')).not.toBeNull();
    await user.click(icon);
    expect(onChange).toHaveBeenCalledWith("sonnet");
  });

  it("groups the models under their provider", async () => {
    renderPicker();
    await openPicker();

    expect(screen.getByRole("group", { name: "Anthropic" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "OpenAI" })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("marks the current model", async () => {
    renderPicker();
    await openPicker();

    expect(screen.getByRole("option", { name: /Claude Sonnet 5/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("option", { name: /GPT-5/ })).toHaveAttribute("aria-selected", "false");
  });

  it("filters on the model name", async () => {
    const { user } = renderPicker();
    await openPicker();
    await user.type(screen.getByPlaceholderText("Search models…"), "opus");

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Claude Opus 5");
  });

  // The provider name is never shown on the row itself, so typing it has to
  // work or the grouping heading is the only way to find a provider's models.
  it("filters on the provider name too", async () => {
    const { user } = renderPicker();
    await openPicker();
    await user.type(screen.getByPlaceholderText("Search models…"), "openai");

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("GPT-5");
  });

  it("shows the admin's description under a model and finds it by that too", async () => {
    const { user } = renderPicker({
      models: [{ ...MODELS[2]!, description: "Fast, good for everyday questions" }, MODELS[0]!],
    });
    await openPicker();
    expect(screen.getByText("Fast, good for everyday questions")).toBeVisible();
    await user.type(screen.getByPlaceholderText("Search models…"), "everyday");
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("GPT-5");
  });

  it("reports the empty label when nothing matches", async () => {
    const { user } = renderPicker({ emptyLabel: "No models match" });
    await openPicker();
    await user.type(screen.getByPlaceholderText("Search models…"), "gemini");

    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No models match")).toBeInTheDocument();
  });

  it("hands the picked model's id back", async () => {
    const { onChange, user } = renderPicker();
    await openPicker();
    await user.click(screen.getByRole("option", { name: /GPT-5/ }));

    expect(onChange).toHaveBeenCalledWith("gpt");
  });

  it("stays shut while disabled", () => {
    renderPicker({ disabled: true });
    const trigger = screen.getByRole("combobox", { name: "Change model" });
    expect(trigger).toBeDisabled();

    trigger.click();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });
});
