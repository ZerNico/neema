import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AskToolActivity } from "../client/use-message-stream.ts";
import { QuestionDock } from "./question-dock.tsx";

const focus = {
  question: "Where should we start?",
  header: "Focus",
  multiSelect: false,
  options: [{ label: "Design", description: "Plan the interface" }, { label: "Code" }],
};
const deadline = { question: "What is the deadline?", options: [], multiSelect: false };

const ask = (questions: AskToolActivity["questions"] = [focus]): AskToolActivity => ({
  family: "ask",
  callId: "ask-1",
  name: "ask_user",
  status: "complete",
  questions,
});

const show = ({
  activity = ask(),
  onRespond = vi.fn().mockResolvedValue(undefined),
  onDismiss = vi.fn(),
} = {}) => ({
  onRespond,
  onDismiss,
  ...render(
    <QuestionDock
      activity={activity}
      onRespond={onRespond}
      onDismiss={onDismiss}
      disabled={false}
      actions={null}
    />,
  ),
});

describe("QuestionDock", () => {
  it("starts empty and sends positional selections only when asked to", async () => {
    const { onRespond } = show();
    expect(screen.getByText("Plan the interface")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send answers" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Design" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "Code" }));
    // The last question never sends itself on a pick.
    expect(onRespond).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
    await waitFor(() =>
      expect(onRespond).toHaveBeenCalledWith("ask-1", {
        kind: "answers",
        answers: [{ selected: [1], custom: "" }],
      }),
    );
  });

  it("asks one question at a time, moves on after a single pick, and goes back with answers kept", async () => {
    const { onRespond } = show({ activity: ask([focus, deadline]) });
    expect(screen.getByText("Question 1 of 2")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Code" }));
    expect(screen.getByText("Question 2 of 2")).toBeInTheDocument();
    expect(screen.getByText("What is the deadline?")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Your answer" }), {
      target: { value: "Friday" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: "Code" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("textbox", { name: "Your answer" })).toHaveValue("Friday");
    fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
    await waitFor(() =>
      expect(onRespond).toHaveBeenCalledWith("ask-1", {
        kind: "answers",
        answers: [
          { selected: [1], custom: "" },
          { selected: [], custom: "Friday" },
        ],
      }),
    );
  });

  it("makes custom text and options mutually exclusive for single selection", () => {
    show();
    const custom = screen.getByRole("textbox", { name: "Or write your own answer" });
    fireEvent.click(screen.getByRole("button", { name: "Design" }));
    fireEvent.change(custom, { target: { value: "Documentation" } });
    expect(screen.getByRole("button", { name: "Design" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "Code" }));
    expect(custom).toHaveValue("");
  });

  it("accepts several options plus custom text when the question allows it", async () => {
    const { onRespond } = show({ activity: ask([{ ...focus, multiSelect: true }]) });
    fireEvent.click(screen.getByRole("button", { name: "Design" }));
    fireEvent.click(screen.getByRole("button", { name: "Code" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Add your own answer (optional)" }), {
      target: { value: "Tests" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
    await waitFor(() =>
      expect(onRespond).toHaveBeenCalledWith("ask-1", {
        kind: "answers",
        answers: [{ selected: [0, 1], custom: "Tests" }],
      }),
    );
  });

  it("picks by number and moves on with Enter, but leaves keys typed into a field alone", async () => {
    const user = userEvent.setup();
    const { onRespond } = show({ activity: ask([focus, deadline]) });
    const dock = screen.getByRole("region", { name: "Clarification questions" });
    dock.focus();
    await user.keyboard("2");
    expect(screen.getByText("Question 2 of 2")).toBeInTheDocument();
    const answer = screen.getByRole("textbox", { name: "Your answer" });
    await user.type(answer, "1");
    expect(answer).toHaveValue("1");
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(onRespond).toHaveBeenCalledWith("ask-1", {
        kind: "answers",
        answers: [
          { selected: [1], custom: "" },
          { selected: [], custom: "1" },
        ],
      }),
    );
  });

  it("hands the composer back on Escape or the close button, without answering", async () => {
    const user = userEvent.setup();
    const { onDismiss, onRespond } = show();
    screen.getByRole("region", { name: "Clarification questions" }).focus();
    await user.keyboard("{Escape}");
    fireEvent.click(screen.getByRole("button", { name: "Write a message instead" }));
    expect(onDismiss).toHaveBeenCalledTimes(2);
    expect(onRespond).not.toHaveBeenCalled();
  });

  it("skips the whole batch without turning draft values into answers", async () => {
    const { onRespond } = show();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Unsent idea" } });
    fireEvent.click(screen.getByRole("button", { name: "Skip and continue" }));
    await waitFor(() => expect(onRespond).toHaveBeenCalledWith("ask-1", { kind: "skip" }));
  });

  it("guards repeated submissions and keeps the answer after a rejection", async () => {
    let reject!: (error: Error) => void;
    const onRespond = vi.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    show({ onRespond });
    const custom = screen.getByRole("textbox");
    fireEvent.change(custom, { target: { value: "My draft" } });
    const button = screen.getByRole("button", { name: "Send answers" });
    const form = custom.closest("form")!;
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(within(button).queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Skip and continue" })).toBeDisabled();
    expect(custom).toBeDisabled();
    await act(async () => reject(new Error("Network interrupted")));
    expect(custom).toHaveValue("My draft");
    expect(button).toBeEnabled();
  });

  it("answers once: after the answer lands, nothing can send it again", async () => {
    const { onRespond } = show();
    fireEvent.click(screen.getByRole("button", { name: "Code" }));
    fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
    await waitFor(() => expect(onRespond).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send answers" })).toBeDisabled(),
    );
    expect(screen.getByRole("button", { name: "Skip and continue" })).toBeDisabled();
  });
});
