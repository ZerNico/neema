import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageRangeEncoded } from "../schema.ts";
import { UsageRangePicker } from "./usage-dashboard.tsx";

/**
 * The calendar renders a real month grid, so these tests pin a clock: the
 * picker disables future days, and "which days are clickable" would otherwise
 * drift with the wall clock.
 */
const NOW = new Date("2026-08-24T12:00:00.000Z");

beforeEach(() => {
  // `shouldAdvanceTime` keeps user-event's internal waits from deadlocking
  // against the frozen clock.
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

const setup = (range: UsageRangeEncoded = { kind: "preset", days: 30 }) => {
  const onChange = vi.fn();
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(<UsageRangePicker range={range} onChange={onChange} />);
  return { onChange, user };
};

// The trigger has no aria-label: its visible text *is* the range, so the
// button is found by that text.
const trigger = () => screen.getByRole("button", { name: /Last \d+ days|–/ });

const openPicker = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(trigger());
};

/**
 * Two months are on screen, so "10" alone is ambiguous. react-day-picker
 * stamps each cell with its full date — the only handle that names one day.
 */
const day = (iso: string): HTMLElement => {
  const cell = document.querySelector<HTMLElement>(`[data-day="${iso}"] button`);
  if (!cell) throw new Error(`no day cell for ${iso}`);
  return cell;
};

describe("UsageRangePicker", () => {
  it("labels the trigger with the active preset", () => {
    setup({ kind: "preset", days: 7 });
    expect(trigger()).toHaveTextContent("Last 7 days");
  });

  it("labels the trigger with the inclusive end day of a custom range", () => {
    // The window's `to` is exclusive, so Aug 16 midnight means "through the
    // 15th" — showing the 16th would claim a day that isn't in the data.
    setup({
      kind: "custom",
      from: "2026-08-10T00:00:00.000Z",
      to: "2026-08-16T00:00:00.000Z",
    });
    expect(trigger()).toHaveTextContent("Aug 10 – Aug 15, 2026");
  });

  it("emits a tagged preset and closes", async () => {
    const { onChange, user } = setup();
    await openPicker(user);
    await user.click(screen.getByText("Last 90 days"));

    expect(onChange).toHaveBeenCalledWith({ kind: "preset", days: 90 });
    expect(screen.queryByText("Custom range…")).not.toBeInTheDocument();
  });

  it("shows two months once custom is chosen", async () => {
    const { user } = setup();
    await openPicker(user);
    await user.click(screen.getByText("Custom range…"));

    expect(screen.getByText(/August 2026/)).toBeInTheDocument();
    expect(screen.getByText(/September 2026/)).toBeInTheDocument();
  });

  it("keeps Apply disabled until a day is picked", async () => {
    const { onChange, user } = setup();
    await openPicker(user);
    await user.click(screen.getByText("Custom range…"));

    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("treats a single click as a one-day window", async () => {
    // react-day-picker sets both ends on the first click, so this is a
    // complete range rather than a half-finished one.
    const { onChange, user } = setup();
    await openPicker(user);
    await user.click(screen.getByText("Custom range…"));
    await user.click(day("2026-08-10"));
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(onChange).toHaveBeenCalledWith({
      kind: "custom",
      from: "2026-08-10T00:00:00.000Z",
      to: "2026-08-11T00:00:00.000Z",
    });
  });

  it("offers today but refuses the future", async () => {
    const { user } = setup();
    await openPicker(user);
    await user.click(screen.getByText("Custom range…"));

    // Usage cannot exist ahead of the clock; a selectable tomorrow would only
    // ever produce an unexplained empty dashboard.
    expect(day("2026-08-24")).not.toBeDisabled();
    expect(day("2026-08-25")).toBeDisabled();
    expect(day("2026-09-05")).toBeDisabled();
  });

  it("converts a completed selection to a half-open UTC window", async () => {
    const { onChange, user } = setup();
    await openPicker(user);
    await user.click(screen.getByText("Custom range…"));
    await user.click(day("2026-08-10"));
    await user.click(day("2026-08-15"));
    await user.click(screen.getByRole("button", { name: "Apply" }));

    // The user picked Aug 10–15 inclusive; `to` is the following midnight.
    expect(onChange).toHaveBeenCalledWith({
      kind: "custom",
      from: "2026-08-10T00:00:00.000Z",
      to: "2026-08-16T00:00:00.000Z",
    });
  });

  it("does not commit on Cancel", async () => {
    const { onChange, user } = setup();
    await openPicker(user);
    await user.click(screen.getByText("Custom range…"));
    await user.click(day("2026-08-10"));
    await user.click(day("2026-08-15"));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("reopens on the preset list, not the calendar it was last left on", async () => {
    const { user } = setup();
    await openPicker(user);
    await user.click(screen.getByText("Custom range…"));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await openPicker(user);

    expect(screen.getByText("Custom range…")).toBeInTheDocument();
    expect(screen.queryByText(/September 2026/)).not.toBeInTheDocument();
  });
});
