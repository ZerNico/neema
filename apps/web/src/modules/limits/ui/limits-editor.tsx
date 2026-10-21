import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { modelsQuery } from "~/modules/admin/client/queries.ts";
import { readServerError } from "~/server-error.ts";
import { useConfirm } from "~/ui/confirm-context.ts";
import { toastError } from "~/ui/error-toast.ts";
import { ListCard, ListRow, Section } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Button } from "~/ui/primitives/button";
import { Checkbox } from "~/ui/primitives/checkbox";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "~/ui/primitives/combobox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";
import { usageLimitRulesQuery } from "../client/queries.ts";
import {
  formatAmount,
  limitKey,
  PERIOD_WORDS,
  type LimitMetric,
  type LimitPeriod,
  type LimitRule,
} from "../rules.ts";
import { deleteUsageLimit, saveUsageLimit, setLimitTimeZone } from "../server/functions.ts";

const METRICS: ReadonlyArray<{ value: LimitMetric; label: string }> = [
  { value: "cost", label: "Cost in USD" },
  { value: "answers", label: "Answers" },
];
const PERIODS: ReadonlyArray<{ value: LimitPeriod; label: string }> = [
  { value: "day", label: "Per day" },
  { value: "week", label: "Per week" },
  { value: "month", label: "Per month" },
];

// UTC first: it is the default, and the list browsers give leaves it out.
const TIMEZONES: ReadonlyArray<string> = (() => {
  try {
    return ["UTC", ...Intl.supportedValuesOf("timeZone").filter((zone) => zone !== "UTC")];
  } catch {
    return ["UTC"];
  }
})();

type ModelName = (id: string) => string;

/** "$10.00 per month", "20 answers per day with Opus", "No limit per day". */
const describe = (rule: LimitRule, name: ModelName) => {
  const amount =
    rule.amount === null ? "No limit" : `Up to ${formatAmount(rule.metric, rule.amount)}`;
  const models = rule.modelIds
    ? rule.modelIds.length
      ? ` with ${rule.modelIds.map(name).join(", ")}`
      : " with removed models, so it limits nothing"
    : "";
  const what = rule.amount === null ? ` on ${rule.metric === "cost" ? "cost" : "answers"}` : "";
  return `${amount}${what} per ${PERIOD_WORDS[rule.period].noun}${models}`;
};

/**
 * One scope's limits: everyone's, or a group's beside the everyone rules it
 * inherits, each of which it may change for its members or lift.
 */
export function LimitsSection({ groupId }: { groupId: string | null }) {
  const { data } = useQuery(usageLimitRulesQuery);
  const { data: allModels = [] } = useQuery(modelsQuery);
  const chatModels = allModels.filter((model) => model.type === "chat");
  const name: ModelName = (id) =>
    chatModels.find((model) => model.id === id)?.displayName ?? "a removed model";
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<{
    rule: LimitRule | null;
    inherited: LimitRule | null;
  } | null>(null);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: usageLimitRulesQuery.queryKey }),
      queryClient.invalidateQueries({ queryKey: ["my-limits"] }),
      queryClient.invalidateQueries({ queryKey: ["chat-models"] }),
    ]);
  const remove = useMutation({
    mutationFn: (id: string) => deleteUsageLimit({ data: { id } }),
    onSuccess: refresh,
    onError: (error) => toastError("Could not remove the limit.", error),
  });

  const rules = data?.rules ?? [];
  const everyone = rules.filter((rule) => rule.groupId === null);
  const own = groupId === null ? everyone : rules.filter((rule) => rule.groupId === groupId);
  const byKey = new Map(own.map((rule) => [limitKey(rule), rule]));
  // A group's page lists everyone's rules with this group's word on each, then its own extras.
  const inheritedKeys = new Set(everyone.map(limitKey));
  const extras = groupId === null ? [] : own.filter((rule) => !inheritedKeys.has(limitKey(rule)));

  const removeRule = async (rule: LimitRule, inherited: boolean) => {
    if (
      await confirm({
        title: inherited ? "Use everyone’s limit again?" : "Remove this limit?",
        description: inherited
          ? "This group goes back to the limit everyone has."
          : groupId === null
            ? "Nobody is held to it anymore, and groups’ changes to it go too."
            : "Members are no longer held to it.",
        confirmLabel: inherited ? "Use everyone’s" : "Remove",
      })
    )
      remove.mutate(rule.id);
  };

  return (
    <Section
      title="Usage limits"
      description={
        groupId === null
          ? "Everyone but admins is held to these, unless their group changes them."
          : "What this group changes of everyone’s limits, and its own."
      }
      actions={
        <Button
          size="sm"
          variant="outline"
          onClick={() => setEditing({ rule: null, inherited: null })}
        >
          <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
          Add limit
        </Button>
      }
    >
      {groupId === null ? (
        <TimeZoneRow timeZone={data?.timeZone ?? "UTC"} onSaved={refresh} />
      ) : null}
      {everyone.length || extras.length ? (
        <ListCard>
          {(groupId === null ? everyone : [...everyone, ...extras]).map((rule) => {
            const inherited = groupId !== null && rule.groupId === null;
            const override = inherited ? byKey.get(limitKey(rule)) : undefined;
            return (
              <ListRow key={rule.id} className="flex-wrap">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm font-medium">{describe(override ?? rule, name)}</span>
                  {inherited ? (
                    <span className="text-muted-foreground text-xs">
                      {override ? `Everyone else: ${describe(rule, name)}` : "Everyone’s limit"}
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  {inherited && !override && rule.modelIds?.length === 0 ? null : inherited &&
                    !override ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setEditing({ rule: null, inherited: rule })}
                    >
                      Change for this group
                    </Button>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setEditing({ rule: override ?? rule, inherited: inherited ? rule : null })
                        }
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void removeRule(override ?? rule, inherited)}
                      >
                        {inherited ? "Use everyone’s" : "Remove"}
                      </Button>
                    </>
                  )}
                </div>
              </ListRow>
            );
          })}
        </ListCard>
      ) : (
        <p className="text-muted-foreground text-sm">No limits.</p>
      )}
      {editing ? (
        <LimitDialog
          groupId={groupId}
          rule={editing.rule}
          inherited={editing.inherited}
          groupChanges={
            groupId === null && editing.rule
              ? rules.filter(
                  (other) => other.groupId !== null && limitKey(other) === limitKey(editing.rule!),
                ).length
              : 0
          }
          models={chatModels}
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          onSaved={refresh}
        />
      ) : null}
    </Section>
  );
}

function TimeZoneRow({ timeZone, onSaved }: { timeZone: string; onSaved: () => Promise<unknown> }) {
  const save = useMutation({
    mutationFn: (zone: string) => setLimitTimeZone({ data: { timeZone: zone } }),
    onSuccess: onSaved,
    onError: (error) => toastError("Could not change the time zone.", error),
  });
  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-1 text-sm">
      Days, weeks and months begin in
      <Combobox
        items={[...TIMEZONES]}
        value={timeZone}
        onValueChange={(value: string | null) => {
          if (value && value !== timeZone) save.mutate(value);
        }}
      >
        <ComboboxTrigger
          aria-label={`Time zone, ${timeZone}`}
          render={<Button variant="ghost" size="xs" />}
          disabled={save.isPending}
        >
          {timeZone}
        </ComboboxTrigger>
        <ComboboxContent align="start" className="w-72">
          <ComboboxInput placeholder="Search time zones…" showTrigger={false} />
          <ComboboxEmpty>No matching time zone</ComboboxEmpty>
          <ComboboxList>
            {(zone: string) => (
              <ComboboxItem key={zone} value={zone}>
                {zone}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </div>
  );
}

/**
 * Adds or edits one rule. Changing an inherited rule for a group fixes what
 * it counts, over what and for which models: only the amount is the group's.
 */
function LimitDialog({
  groupId,
  rule,
  inherited,
  groupChanges,
  models,
  onOpenChange,
  onSaved,
}: {
  groupId: string | null;
  rule: LimitRule | null;
  inherited: LimitRule | null;
  /** Groups that changed this one of everyone's limits, whose changes go with what it counts. */
  groupChanges: number;
  models: ReadonlyArray<{ id: string; displayName: string }>;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<unknown>;
}) {
  const fieldId = useId();
  const base = rule ?? inherited;
  const [metric, setMetric] = useState<LimitMetric>(base?.metric ?? "cost");
  const [period, setPeriod] = useState<LimitPeriod>(base?.period ?? "month");
  const [chosen, setChosen] = useState<ReadonlyArray<string> | null>(base?.modelIds ?? null);
  const [amount, setAmount] = useState(
    rule?.amount != null
      ? String(rule.amount)
      : inherited?.amount != null
        ? String(inherited.amount)
        : "",
  );
  const [unlimited, setUnlimited] = useState(rule !== null && rule.amount === null);
  const [error, setError] = useState<string | null>(null);
  const fixed = inherited !== null;
  const save = useMutation({
    mutationFn: () =>
      saveUsageLimit({
        data: {
          id: rule?.id ?? null,
          groupId,
          metric,
          period,
          amount: unlimited ? null : Number(amount),
          modelIds: chosen,
        },
      }),
    onSuccess: async () => {
      await onSaved();
      onOpenChange(false);
    },
    onError: (failure) => setError(readServerError(failure).reason ?? "Could not save the limit."),
  });

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {fixed ? "Change for this group" : rule ? "Edit limit" : "Add limit"}
          </DialogTitle>
          <DialogDescription>
            {fixed
              ? `Everyone else: ${describe(inherited, (id) => models.find((m) => m.id === id)?.displayName ?? "a removed model")}.`
              : "Answers stop once it is used up, until the period starts again."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            save.mutate();
          }}
        >
          <FieldGroup>
            {fixed ? null : (
              <>
                <Field>
                  <FieldLabel htmlFor={`${fieldId}-metric`}>What it counts</FieldLabel>
                  <Select
                    value={metric}
                    items={METRICS}
                    onValueChange={(value) => setMetric(value as LimitMetric)}
                  >
                    <SelectTrigger id={`${fieldId}-metric`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {METRICS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${fieldId}-period`}>How often it starts again</FieldLabel>
                  <Select
                    value={period}
                    items={PERIODS}
                    onValueChange={(value) => setPeriod(value as LimitPeriod)}
                  >
                    <SelectTrigger id={`${fieldId}-period`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PERIODS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel>Models</FieldLabel>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={chosen === null}
                      onCheckedChange={(all) => setChosen(all ? null : [])}
                    />
                    All models
                  </label>
                  {chosen !== null ? (
                    <div className="flex max-h-48 flex-col gap-2 overflow-y-auto pl-6">
                      {models.map((model) => (
                        <label key={model.id} className="flex items-center gap-2 text-sm">
                          <Checkbox
                            checked={chosen.includes(model.id)}
                            onCheckedChange={(on) =>
                              setChosen(
                                on ? [...chosen, model.id] : chosen.filter((id) => id !== model.id),
                              )
                            }
                          />
                          {model.displayName}
                        </label>
                      ))}
                    </div>
                  ) : null}
                </Field>
              </>
            )}
            <Field>
              <FieldLabel htmlFor={`${fieldId}-amount`}>
                {metric === "cost" ? "Amount in USD" : "Number of answers"}
              </FieldLabel>
              <Input
                id={`${fieldId}-amount`}
                type="number"
                inputMode="decimal"
                min={metric === "cost" ? 0.01 : 1}
                step={metric === "cost" ? 0.01 : 1}
                value={amount}
                disabled={unlimited}
                onChange={(event) => setAmount(event.target.value)}
              />
              {fixed ? (
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={unlimited}
                    onCheckedChange={(on) => setUnlimited(Boolean(on))}
                  />
                  No limit for this group
                </label>
              ) : null}
            </Field>
          </FieldGroup>
          {groupChanges > 0 && rule && (metric !== rule.metric || period !== rule.period) ? (
            <p className="text-muted-foreground text-sm">
              {groupChanges === 1 ? "A group’s change" : `${groupChanges} groups’ changes`} to this
              limit will be removed.
            </p>
          ) : null}
          {error ? <FieldError>{error}</FieldError> : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={save.isPending} />}>
              Cancel
            </DialogClose>
            <PendingButton
              type="submit"
              pending={save.isPending}
              disabled={!unlimited && !(Number(amount) > 0)}
            >
              Save
            </PendingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
