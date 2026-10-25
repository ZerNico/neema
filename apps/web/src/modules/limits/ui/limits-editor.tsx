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
  type LimitMetric,
  type LimitPeriod,
  type LimitRule,
} from "../rules.ts";
import { deleteUsageLimit, saveUsageLimit, setLimitTimeZone } from "../server/functions.ts";
import { m } from "~/paraglide/messages.js";

const metrics = (): ReadonlyArray<{ value: LimitMetric; label: string }> => [
  { value: "cost", label: m.limits_metric_cost() },
  { value: "answers", label: m.limits_metric_answers() },
];
const periods = (): ReadonlyArray<{ value: LimitPeriod; label: string }> => [
  { value: "day", label: m.limits_period_day() },
  { value: "week", label: m.limits_period_week() },
  { value: "month", label: m.limits_period_month() },
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
  const scope = rule.modelIds ? (rule.modelIds.length ? "models" : "none") : "all";
  const models = rule.modelIds?.map(name).join(", ") ?? "";
  return rule.amount === null
    ? m.limits_rule_lifted({ metric: rule.metric, period: rule.period, scope, models })
    : m.limits_rule({
        period: rule.period,
        scope,
        amount: formatAmount(rule.metric, rule.amount),
        models,
      });
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
    chatModels.find((model) => model.id === id)?.displayName ?? m.limits_removed_model();
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
    onError: (error) => toastError(m.limits_error_remove(), error),
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
        title: inherited ? m.limits_confirm_restore_title() : m.limits_confirm_remove_title(),
        description: inherited
          ? m.limits_confirm_restore_description()
          : groupId === null
            ? m.limits_confirm_remove_everyone()
            : m.limits_confirm_remove_group(),
        confirmLabel: inherited
          ? m.limits_confirm_restore_action()
          : m.limits_confirm_remove_action(),
      })
    )
      remove.mutate(rule.id);
  };

  return (
    <Section
      title={m.limits_title()}
      description={
        groupId === null ? m.limits_description_everyone() : m.limits_description_group()
      }
      actions={
        <Button
          size="sm"
          variant="outline"
          onClick={() => setEditing({ rule: null, inherited: null })}
        >
          <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
          {m.limits_add()}
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
                      {override
                        ? m.limits_everyone_else({ rule: describe(rule, name) })
                        : m.limits_everyone()}
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
                      {m.limits_change_group()}
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
                        {m.common_edit()}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void removeRule(override ?? rule, inherited)}
                      >
                        {inherited ? m.limits_use_everyone() : m.limits_remove()}
                      </Button>
                    </>
                  )}
                </div>
              </ListRow>
            );
          })}
        </ListCard>
      ) : (
        <p className="text-muted-foreground text-sm">{m.limits_empty()}</p>
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
    onError: (error) => toastError(m.limits_error_time_zone(), error),
  });
  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-1 text-sm">
      {m.limits_time_zone_prefix()}
      <Combobox
        items={[...TIMEZONES]}
        value={timeZone}
        onValueChange={(value: string | null) => {
          if (value && value !== timeZone) save.mutate(value);
        }}
      >
        <ComboboxTrigger
          aria-label={m.limits_time_zone_label({ zone: timeZone })}
          render={<Button variant="ghost" size="xs" />}
          disabled={save.isPending}
        >
          {timeZone}
        </ComboboxTrigger>
        <ComboboxContent align="start" className="w-72">
          <ComboboxInput placeholder={m.limits_time_zone_search()} showTrigger={false} />
          <ComboboxEmpty>{m.limits_time_zone_empty()}</ComboboxEmpty>
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
    onError: (failure) => setError(readServerError(failure).reason ?? m.limits_error_save()),
  });

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {fixed ? m.limits_change_group() : rule ? m.limits_dialog_edit() : m.limits_add()}
          </DialogTitle>
          <DialogDescription>
            {fixed
              ? m.limits_everyone_else_sentence({
                  rule: describe(
                    inherited,
                    (id) =>
                      models.find((model) => model.id === id)?.displayName ??
                      m.limits_removed_model(),
                  ),
                })
              : m.limits_dialog_description()}
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
                  <FieldLabel htmlFor={`${fieldId}-metric`}>{m.limits_field_metric()}</FieldLabel>
                  <Select
                    value={metric}
                    items={metrics()}
                    onValueChange={(value) => setMetric(value as LimitMetric)}
                  >
                    <SelectTrigger id={`${fieldId}-metric`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {metrics().map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${fieldId}-period`}>{m.limits_field_period()}</FieldLabel>
                  <Select
                    value={period}
                    items={periods()}
                    onValueChange={(value) => setPeriod(value as LimitPeriod)}
                  >
                    <SelectTrigger id={`${fieldId}-period`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {periods().map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel>{m.limits_field_models()}</FieldLabel>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={chosen === null}
                      onCheckedChange={(all) => setChosen(all ? null : [])}
                    />
                    {m.limits_all_models()}
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
                {metric === "cost" ? m.limits_field_amount_cost() : m.limits_field_amount_answers()}
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
                  {m.limits_unlimited_group()}
                </label>
              ) : null}
            </Field>
          </FieldGroup>
          {groupChanges > 0 && rule && (metric !== rule.metric || period !== rule.period) ? (
            <p className="text-muted-foreground text-sm">
              {m.limits_group_changes_removed({ count: groupChanges })}
            </p>
          ) : null}
          {error ? <FieldError>{error}</FieldError> : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={save.isPending} />}>
              {m.common_cancel()}
            </DialogClose>
            <PendingButton
              type="submit"
              pending={save.isPending}
              disabled={!unlimited && !(Number(amount) > 0)}
            >
              {m.common_save()}
            </PendingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
