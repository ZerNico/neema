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

const MODES = [
  { value: "always", label: "When a run finishes" },
  { value: "conditional", label: "When it’s worth it" },
  { value: "off", label: "Never" },
] as const satisfies ReadonlyArray<{ value: ScheduleNotify; label: string }>;

/** Whether a run tells its owner, and who decides. Failures notify unless it is off. */
export const ScheduleNotifyField = withForm({
  defaultValues: EMPTY_SCHEDULE_DRAFT,
  render: function ScheduleNotifyField({ form }) {
    const notify = useStore(form.store, (state) => state.values.notify ?? "always");
    return (
      <div className="flex flex-col gap-3">
        <FieldLabel>Notify me</FieldLabel>
        <Select
          items={MODES}
          value={notify}
          onValueChange={(mode: ScheduleNotify | null) => {
            if (mode) form.setFieldValue("notify", mode);
          }}
        >
          <SelectTrigger aria-label="Notify me" className="w-52">
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
            ? "Say in the prompt when it’s worth telling you."
            : notify === "off"
              ? "Runs still show in the sidebar."
              : "Failed runs notify too."}{" "}
          <Link to="/settings/notifications" className="underline underline-offset-2">
            Where you get them
          </Link>
        </FieldDescription>
      </div>
    );
  },
});
