import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  it("reads as asked while the dock answers it, with nothing to press here", () => {
    render(<AskUserBlock activity={activity} messageStatus="complete" awaiting />);
    expect(screen.getByText("Waiting for your answer")).toBeInTheDocument();
    expect(screen.getByText("Where should we start?")).toBeInTheDocument();
    expect(screen.getByText("Design: Plan the interface")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("shows an older question read-only", () => {
    render(<AskUserBlock activity={activity} messageStatus="complete" />);
    expect(screen.getByText("Previous questions · read-only")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("says the questions are on their way while the answer streams", () => {
    render(
      <AskUserBlock
        activity={{ ...activity, status: "running", questions: [] }}
        messageStatus="streaming"
      />,
    );
    expect(screen.getByText("Preparing questions…")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("never offers controls for rejected or undecodable presentation results", () => {
    render(
      <AskUserBlock
        activity={{ ...activity, status: "error", questions: [] }}
        messageStatus="complete"
      />,
    );
    expect(screen.getByText("These questions are unavailable.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
