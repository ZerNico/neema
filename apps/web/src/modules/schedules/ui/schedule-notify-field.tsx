import { useStore } from "@tanstack/react-form";
import { Link } from "@tanstack/react-router";
import { NotificationReachHint } from "~/modules/notifications/ui/reach-hint.tsx";
import { EMPTY_SCHEDULE_DRAFT } from "../draft-schema.ts";
import type { ScheduleNotify } from "../schema.ts";
import { withForm } from "~/ui/form/app-form.ts";
import { FieldDescription, FieldLabel } from "~/ui/primitives/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";
import { m } from "~/paraglide/messages.js";

const modes = () =>
  [
    { value: "always", label: m.schedules_notify_always() },
    { value: "conditional", label: m.schedules_notify_conditional() },
    { value: "off", label: m.schedules_notify_off() },
  ] as const satisfies ReadonlyArray<{ value: ScheduleNotify; label: string }>;

/** Whether a run tells its owner, and who decides. Failures notify unless it is off. */
export const ScheduleNotifyField = withForm({
  defaultValues: EMPTY_SCHEDULE_DRAFT,
  render: function ScheduleNotifyField({ form }) {
    const notify = useStore(form.store, (state) => state.values.notify);
    const MODES = modes();
    return (
      <div className="flex flex-col gap-3">
        <FieldLabel>{m.schedules_notify_label()}</FieldLabel>
        <Select
          items={MODES}
          value={notify}
          onValueChange={(mode: ScheduleNotify | null) => {
            if (mode) form.setFieldValue("notify", mode);
          }}
        >
          <SelectTrigger aria-label={m.schedules_notify_label()} className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODES.map((mode) => (
              <SelectItem key={mode.value} value={mode.value}>
                {mode.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {notify === "off" ? null : <NotificationReachHint />}
        <FieldDescription>
          {notify === "conditional"
            ? m.schedules_notify_conditional_hint()
            : notify === "off"
              ? m.schedules_notify_off_hint()
              : m.schedules_notify_always_hint()}{" "}
          <Link to="/settings/notifications" className="underline underline-offset-2">
            {m.schedules_notify_where()}
          </Link>
        </FieldDescription>
      </div>
    );
  },
});
