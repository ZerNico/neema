import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { unexpectedFailureBody } from "~/server-error.ts";
import { errorReport, toastError } from "./error-toast.ts";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
beforeEach(() => vi.clearAllMocks());

describe("toastError", () => {
  it("leads with the plain title and adds the server's reason as a sentence", () => {
    toastError(
      "Could not save the schedule.",
      new Error("a schedule can run at most once an hour"),
    );
    expect(toast.error).toHaveBeenCalledWith("Could not save the schedule.", {
      description: "A schedule can run at most once an hour.",
    });
  });

  it("shows only the title when there is nothing a person could use", () => {
    toastError("Could not delete the chat.", new TypeError("Failed to fetch"));
    expect(toast.error).toHaveBeenCalledWith("Could not delete the chat.", undefined);
  });

  it("offers the reference and a copyable report for an unexpected failure", () => {
    toastError("Could not save the agent.", new Error(unexpectedFailureBody("K7F2QX")));
    const [title, options] = vi.mocked(toast.error).mock.calls[0]!;
    expect(title).toBe("Could not save the agent.");
    expect(options).toMatchObject({
      description: "Something went wrong on our side. Reference K7F2QX.",
      action: { label: "Copy details" },
    });
  });
});

describe("errorReport", () => {
  it("carries what an admin needs to find the log line", () => {
    const report = errorReport({
      title: "Could not save the agent.",
      reference: "K7F2QX",
      raw: "Something went wrong on our side.\nReference: K7F2QX",
      at: new Date("2026-09-23T10:00:00Z"),
      page: "https://chat.example/agents/a1",
    });
    expect(report).toContain("Reference: K7F2QX");
    expect(report).toContain("Time: 2026-09-23T10:00:00.000Z");
    expect(report).toContain("Page: https://chat.example/agents/a1");
  });
});
