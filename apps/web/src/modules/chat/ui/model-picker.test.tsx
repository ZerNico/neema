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
  capabilities: { imageOutput: false, reasoning: false, tools: true, vision: false, files: false },
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

  it("lists every model in the order given, naming each one's provider", async () => {
    renderPicker();
    await openPicker();

    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Claude Sonnet 5Anthropic",
      "Claude Opus 5Anthropic",
      "GPT-5OpenAI",
    ]);
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
    expect(screen.getByText("OpenAI · Fast, good for everyday questions")).toBeVisible();
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

  it("puts the best name match first while searching", async () => {
    const { user } = renderPicker({
      models: [{ ...MODELS[0]!, description: "Better than GPT-5 at prose" }, ...MODELS.slice(1)],
    });
    await openPicker();
    await user.type(screen.getByPlaceholderText("Search models…"), "gpt");

    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "GPT-5OpenAI",
      "Claude Sonnet 5Anthropic · Better than GPT-5 at prose",
    ]);
  });

  it("leaves the provider off rows when every model comes from one", async () => {
    renderPicker({ models: MODELS.slice(0, 2) });
    await openPicker();
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Claude Sonnet 5",
      "Claude Opus 5",
    ]);
  });

  it("disables a model whose limit is used up when picking to answer, and only then", async () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const models = [MODELS[0]!, { ...MODELS[1]!, limitedUntil: until }];
    renderPicker({ models, limited: true });
    await openPicker();
    const limited = screen.getByRole("option", { name: /Claude Opus 5/ });
    expect(limited).toHaveAttribute("aria-disabled", "true");
    expect(limited).toHaveTextContent(/Available again/);
    expect(screen.getByRole("option", { name: /Claude Sonnet 5/ })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("offers a limited model where choosing it spends nothing", async () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    renderPicker({ models: [{ ...MODELS[1]!, limitedUntil: until }] });
    await openPicker();
    expect(screen.getByRole("option", { name: /Claude Opus 5/ })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
});
