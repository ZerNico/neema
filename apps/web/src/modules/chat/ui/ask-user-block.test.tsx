import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AskUserBlock } from "./ask-user-block.tsx";
import type { AskToolActivity } from "../client/use-message-stream.ts";

const activity: AskToolActivity = {
  family: "ask",
  callId: "ask-1",
  name: "ask_user",
  status: "complete",
  questions: [
    {
      question: "Where should we start?",
      header: "Focus",
      multiSelect: false,
      options: [{ label: "Design", description: "Plan the interface" }, { label: "Code" }],
    },
  ],
};

const renderCard = (onRespond = vi.fn().mockResolvedValue(undefined)) => ({
  onRespond,
  ...render(<AskUserBlock activity={activity} messageStatus="complete" onRespond={onRespond} />),
});

describe("AskUserBlock resolved answers", () => {
  const resolved = {
    callId: "ask-1",
    messageId: "answer-user",
    response: { kind: "answers", answers: [{ selected: [1], custom: "" }] } as const,
  };

  it("labels the user's selected/custom answers and uses the actual reply timestamp", () => {
    render(
      <AskUserBlock
        activity={{ ...activity, questions: [{ ...activity.questions![0]!, multiSelect: true }] }}
        messageStatus="complete"
        resolved={{
          ...resolved,
          response: { kind: "answers", answers: [{ selected: [0, 1], custom: "Include tests" }] },
          time: {
            iso: "2026-09-05T12:00:00Z",
            clock: "12:00",
            absolute: "5 September 2026 at 12:00",
          },
          onEdit: vi.fn(),
        }}
      />,
    );
    expect(screen.queryByText("Your answers")).not.toBeInTheDocument();
    expect(screen.queryByText("Your answer")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Your answers")).not.toHaveClass("bg-muted/50");
    expect(screen.getByText("Include tests")).toBeInTheDocument();
    expect(screen.getByText("Design")).toBeInTheDocument();
    expect(screen.getByText("Code")).toBeInTheDocument();
    expect(screen.getByText("12:00")).toHaveAttribute("datetime", "2026-09-05T12:00:00Z");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit answers" })).toBeEnabled();
  });

  it("shows explicit skipped state and supports editing it without invented defaults", () => {
    const onEdit = vi.fn();
    const { rerender } = render(
      <AskUserBlock
        activity={activity}
        messageStatus="complete"
        resolved={{ ...resolved, response: { kind: "skip" }, onEdit }}
      />,
    );
    expect(screen.getByText("Skipped")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit answers" }));
    expect(onEdit).toHaveBeenCalledOnce();
    rerender(
      <AskUserBlock
        activity={activity}
        messageStatus="complete"
        resolved={{
          ...resolved,
          response: { kind: "skip" },
          editState: { onSave: vi.fn(), onCancel: vi.fn(), disabled: false },
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "Save answers" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Skip and regenerate" })).toBeEnabled();
  });

  it("seeds structural editing from durable choices and submits new indexed values", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const onCancel = vi.fn();
    render(
      <AskUserBlock
        activity={activity}
        messageStatus="complete"
        resolved={{ ...resolved, editState: { onSave, onCancel, disabled: false } }}
      />,
    );
    expect(screen.getByRole("button", { name: "Code" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "A custom revision" } });
    fireEvent.click(screen.getByRole("button", { name: "Save answers" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        kind: "answers",
        answers: [{ selected: [], custom: "A custom revision" }],
      }),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("retains a revised draft after save failure or cancelled confirmation", async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(false);
    render(
      <AskUserBlock
        activity={activity}
        messageStatus="complete"
        resolved={{ ...resolved, editState: { onSave, onCancel: vi.fn(), disabled: false } }}
      />,
    );
    const draft = screen.getByRole("textbox");
    fireEvent.change(draft, { target: { value: "Keep my revision" } });
    fireEvent.click(screen.getByRole("button", { name: "Save answers" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save answers" })).toBeEnabled());
    expect(draft).toHaveValue("Keep my revision");
    fireEvent.click(screen.getByRole("button", { name: "Save answers" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(draft).toHaveValue("Keep my revision");
  });
});

describe("AskUserBlock", () => {
  it("starts empty, requires explicit submission, and sends positional selections only", async () => {
    const { onRespond } = renderCard();
    expect(screen.queryByText("A little more context")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Answer each question, or skip and continue without answers."),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Where should we start?")).toBeInTheDocument();
    expect(screen.getByText("Plan the interface")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send answers" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Design" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "Code" }));
    expect(onRespond).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
    await waitFor(() =>
      expect(onRespond).toHaveBeenCalledWith("ask-1", {
        kind: "answers",
        answers: [{ selected: [1], custom: "" }],
      }),
    );
    expect(screen.queryByRole("button", { name: "Send answers" })).not.toBeInTheDocument();
  });

  it("makes custom text and options mutually exclusive for single selection", () => {
    renderCard();
    const custom = screen.getByRole("textbox", { name: "Or write your own answer" });
    fireEvent.click(screen.getByRole("button", { name: "Design" }));
    fireEvent.change(custom, { target: { value: "Documentation" } });
    expect(screen.getByRole("button", { name: "Design" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "Code" }));
    expect(custom).toHaveValue("");
    expect(screen.getByRole("button", { name: "Code" })).toHaveAttribute("aria-pressed", "true");
  });

  it("accepts multiple options plus custom text and requires every question", async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    render(
      <AskUserBlock
        activity={{
          ...activity,
          questions: [
            { ...activity.questions![0]!, multiSelect: true },
            { question: "What is the deadline?", options: [], multiSelect: false },
          ],
        }}
        messageStatus="complete"
        onRespond={onRespond}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Design" }));
    fireEvent.click(screen.getByRole("button", { name: "Code" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Add your own answer (optional)" }), {
      target: { value: "Tests" },
    });
    expect(screen.getByRole("button", { name: "Send answers" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Your answer" }), {
      target: { value: "Tomorrow" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
    await waitFor(() =>
      expect(onRespond).toHaveBeenCalledWith("ask-1", {
        kind: "answers",
        answers: [
          { selected: [0, 1], custom: "Tests" },
          { selected: [], custom: "Tomorrow" },
        ],
      }),
    );
  });

  it("skips the whole batch without turning draft values into answers", async () => {
    const { onRespond } = renderCard();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Unsent idea" } });
    fireEvent.click(screen.getByRole("button", { name: "Skip and continue" }));
    await waitFor(() => expect(onRespond).toHaveBeenCalledWith("ask-1", { kind: "skip" }));
  });

  it("guards repeated submissions synchronously, retains draft after rejection, and restores controls", async () => {
    let reject!: (error: Error) => void;
    const onRespond = vi.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    renderCard(onRespond);
    const custom = screen.getByRole("textbox");
    fireEvent.change(custom, { target: { value: "My draft" } });
    const button = screen.getByRole("button", { name: "Send answers" });
    const form = button.closest("form")!;
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveTextContent("Send answers");
    expect(within(button).queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Skip and continue" })).toBeDisabled();
    expect(custom).toBeDisabled();
    await act(async () => reject(new Error("Network interrupted")));
    expect(custom).toHaveValue("My draft");
    expect(button).toBeEnabled();
  });

  it.each(["streaming", "error", "aborted"])(
    "never enables a successful card in a %s assistant",
    (messageStatus) => {
      render(
        <AskUserBlock activity={activity} messageStatus={messageStatus} onRespond={vi.fn()} />,
      );
      expect(screen.getByText("Where should we start?")).toBeInTheDocument();
      for (const button of screen.queryAllByRole("button")) expect(button).toBeDisabled();
    },
  );

  it("shows old cards read-only with no duplicate copy of user draft answers", () => {
    const { rerender } = renderCard();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Private draft" } });
    rerender(<AskUserBlock activity={activity} messageStatus="complete" />);
    expect(screen.getByText("Previous questions · read-only")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByText("Private draft")).not.toBeInTheDocument();
    expect(screen.getByText("Code")).toBeInTheDocument();
  });

  it("hydrates a running card without selecting defaults and preserves draft across durable refetch", () => {
    const onRespond = vi.fn();
    const { rerender } = render(
      <AskUserBlock
        activity={{ ...activity, status: "running", questions: [] }}
        messageStatus="streaming"
        onRespond={onRespond}
      />,
    );
    expect(screen.getByText("Preparing questions…")).toBeInTheDocument();
    rerender(<AskUserBlock activity={activity} messageStatus="complete" onRespond={onRespond} />);
    expect(screen.getByRole("button", { name: "Send answers" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Code" }));
    rerender(
      <AskUserBlock
        activity={structuredClone(activity)}
        messageStatus="complete"
        onRespond={onRespond}
      />,
    );
    expect(screen.getByRole("button", { name: "Code" })).toHaveAttribute("aria-pressed", "true");
  });

  it("supports keyboard selection and allows choices to wrap on narrow layouts", async () => {
    const user = userEvent.setup();
    renderCard();
    const design = screen.getByRole("button", { name: "Design" });
    design.focus();
    await user.keyboard("{ArrowRight} ");
    expect(screen.getByRole("button", { name: "Code" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Code" })).toHaveAttribute("aria-pressed", "true");
    expect(design.closest('[data-slot="toggle-group"]')).toHaveClass("flex-wrap", "w-full");
    expect(design).toHaveClass("whitespace-normal", "max-w-full");
  });

  it("never offers controls for rejected or undecodable presentation results", () => {
    render(
      <AskUserBlock
        activity={{ ...activity, status: "error", questions: [] }}
        messageStatus="complete"
        onRespond={vi.fn()}
      />,
    );
    expect(screen.getByText("These questions are unavailable.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
