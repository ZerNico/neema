import { m } from "~/paraglide/messages.js";
import { LinkSquare02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { toastError } from "~/ui/error-toast.ts";
import { OptionalMark } from "~/ui/form/form-fields.tsx";
import { Button } from "~/ui/primitives/button";
import { Card, CardContent } from "~/ui/primitives/card";
import { Checkbox } from "~/ui/primitives/checkbox";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";
import { Switch } from "~/ui/primitives/switch";
import { pendingIntegrationCallsQuery } from "../client/queries.ts";
import type {
  ElicitationField,
  ElicitationPrompt,
  ElicitationValue,
  PendingIntegrationCall,
} from "../schema.ts";
import { answerIntegrationElicitation } from "../server/functions.ts";
import { IntegrationLogo } from "./integration-logo.tsx";

type Values = Record<string, ElicitationValue>;
type Action = "accept" | "decline" | "cancel";

const INPUT_TYPE = {
  text: "text",
  email: "email",
  url: "url",
  date: "date",
  datetime: "datetime-local",
  number: "number",
  integer: "number",
} as const;

const initialValues = (prompt: ElicitationPrompt): Values => {
  if (prompt.mode !== "form") return {};
  const values: Values = {};
  for (const field of prompt.fields) {
    if (field.default !== undefined) values[field.key] = field.default;
    else if (field.kind === "boolean") values[field.key] = false;
    else if (field.kind === "choices") values[field.key] = [];
  }
  return values;
};

/** What is sent: a local date and time becomes an instant, as the spec's `date-time` wants. */
const outgoing = (prompt: ElicitationPrompt, values: Values): Values => {
  if (prompt.mode !== "form") return values;
  const next = { ...values };
  for (const field of prompt.fields) {
    const value = next[field.key];
    // Nothing picked in an optional list leaves it out, rather than answering with none.
    if (!field.required && Array.isArray(value) && value.length === 0) delete next[field.key];
    if (field.kind === "datetime" && typeof value === "string" && !Number.isNaN(Date.parse(value)))
      next[field.key] = new Date(value).toISOString();
  }
  return next;
};

const missing = (prompt: ElicitationPrompt, values: Values) =>
  prompt.mode === "form" &&
  prompt.fields.some((field) => {
    const value = values[field.key];
    // How many to pick is part of the question; the server checks it again.
    if (field.kind === "choices") {
      const picked = Array.isArray(value) ? value.length : 0;
      if (picked === 0) return field.required && (field.min ?? 0) > 0;
      return (
        (field.min !== undefined && picked < field.min) ||
        (field.max !== undefined && picked > field.max)
      );
    }
    return field.required && (value === undefined || value === "");
  });

/**
 * A service asking the person something while a call runs. It stays on
 * screen as long as the call waits; nothing goes back until a button is
 * pressed, and a link is never opened for them.
 */
export function ElicitationCard({ call, name }: { call: PendingIntegrationCall; name: string }) {
  const prompt = call.prompt!;
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Values>(() => initialValues(prompt));
  const answer = useMutation({
    mutationFn: (action: Action) =>
      answerIntegrationElicitation({
        data: {
          callId: call.callId,
          promptId: call.promptId!,
          action,
          ...(action === "accept" && prompt.mode === "form"
            ? { values: outgoing(prompt, values) }
            : {}),
        },
      }),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: pendingIntegrationCallsQuery.queryKey }),
    onError: (error) => toastError(m.integrations_answer_send_error(), error),
  });

  return (
    <Card className="mb-3 gap-0 py-4">
      <CardContent className="flex min-w-0 flex-col gap-3 px-4">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <IntegrationLogo integrationId={call.integrationId} />
          <span className="min-w-0 truncate">{m.integrations_elicit_asking({ name })}</span>
        </div>
        {prompt.message ? (
          <p className="text-sm [overflow-wrap:anywhere] whitespace-pre-wrap">{prompt.message}</p>
        ) : null}
        {prompt.mode === "url" ? (
          <UrlPrompt
            url={prompt.url}
            pending={answer.isPending}
            onAnswer={(action) => answer.mutate(action)}
          />
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!missing(prompt, values)) answer.mutate("accept");
            }}
          >
            <FieldGroup>
              {prompt.fields.map((field) => (
                <ElicitationInput
                  key={field.key}
                  field={field}
                  value={values[field.key]}
                  disabled={answer.isPending}
                  onChange={(value) =>
                    setValues((current) => {
                      const next = { ...current };
                      if (value === undefined) delete next[field.key];
                      else next[field.key] = value;
                      return next;
                    })
                  }
                />
              ))}
            </FieldGroup>
            <p className="text-muted-foreground text-xs">
              {m.integrations_elicit_goes_to({ name })}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                type="submit"
                disabled={answer.isPending || missing(prompt, values)}
              >
                {m.integrations_elicit_send()}
              </Button>
              <Button
                size="sm"
                variant="outline"
                type="button"
                disabled={answer.isPending}
                onClick={() => answer.mutate("decline")}
              >
                {m.integrations_elicit_decline()}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                type="button"
                disabled={answer.isPending}
                onClick={() => answer.mutate("cancel")}
              >
                {m.common_cancel()}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

/** A page to visit before the call can go on; its host is shown before anything opens. */
function UrlPrompt({
  url,
  pending,
  onAnswer,
}: {
  url: string;
  pending: boolean;
  onAnswer: (action: Action) => void;
}) {
  const host = new URL(url).host;
  const [opened, setOpened] = useState(false);
  // The sentence around the host, which is set apart, split where it goes.
  const opensIn = m.integrations_elicit_opens({ host: "\u0001" }).split("\u0001");
  return (
    <>
      <p className="bg-muted rounded-xl p-2 text-xs [overflow-wrap:anywhere]">
        {opensIn[0]}
        <span className="font-medium">{host}</span>
        {opensIn[1]}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={opened ? "outline" : "default"}
          render={<a href={url} target="_blank" rel="noopener noreferrer" />}
          onClick={() => setOpened(true)}
        >
          {m.integrations_elicit_open({ host })}
          <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={2} />
        </Button>
        <Button size="sm" disabled={pending || !opened} onClick={() => onAnswer("accept")}>
          {m.integrations_elicit_done()}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => onAnswer("cancel")}>
          {m.common_cancel()}
        </Button>
      </div>
    </>
  );
}

function ElicitationInput({
  field,
  value,
  disabled,
  onChange,
}: {
  field: ElicitationField;
  value: ElicitationValue | undefined;
  disabled: boolean;
  onChange: (value: ElicitationValue | undefined) => void;
}) {
  const id = useId();
  const label = (
    <FieldLabel htmlFor={id}>
      {field.label} {field.required ? null : <OptionalMark />}
    </FieldLabel>
  );
  const description = field.description ? (
    <FieldDescription>{field.description}</FieldDescription>
  ) : null;

  if (field.kind === "boolean")
    return (
      <Field>
        <div className="flex items-center justify-between gap-3">
          {label}
          <Switch
            id={id}
            checked={value === true}
            disabled={disabled}
            onCheckedChange={(checked) => onChange(checked)}
          />
        </div>
        {description}
      </Field>
    );

  if (field.kind === "choice")
    return (
      <Field>
        {label}
        <Select
          value={typeof value === "string" ? value : null}
          items={field.options ?? []}
          disabled={disabled}
          onValueChange={(next) => onChange(next === null ? undefined : String(next))}
        >
          <SelectTrigger id={id}>
            <SelectValue placeholder={m.integrations_elicit_choose()} />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {description}
      </Field>
    );

  if (field.kind === "choices") {
    const chosen = Array.isArray(value) ? value : [];
    return (
      <Field>
        <span className="text-sm font-medium">
          {field.label} {field.required ? null : <OptionalMark />}
        </span>
        <div className="flex flex-col gap-2">
          {(field.options ?? []).map((option) => (
            <label key={option.value} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={chosen.includes(option.value)}
                disabled={disabled}
                onCheckedChange={(checked) =>
                  onChange(
                    checked
                      ? [...chosen, option.value]
                      : chosen.filter((item) => item !== option.value),
                  )
                }
              />
              {option.label}
            </label>
          ))}
        </div>
        {description}
      </Field>
    );
  }

  const numeric = field.kind === "number" || field.kind === "integer";
  return (
    <Field>
      {label}
      <Input
        id={id}
        type={INPUT_TYPE[field.kind]}
        value={value === undefined ? "" : String(value)}
        disabled={disabled}
        required={field.required}
        {...(numeric
          ? {
              ...(field.min === undefined ? {} : { min: field.min }),
              ...(field.max === undefined ? {} : { max: field.max }),
              step: field.kind === "integer" ? 1 : "any",
            }
          : {
              ...(field.min === undefined ? {} : { minLength: field.min }),
              ...(field.max === undefined ? {} : { maxLength: field.max }),
            })}
        onChange={(event) => {
          const raw = event.target.value;
          if (raw === "") return onChange(undefined);
          if (!numeric) return onChange(raw);
          const parsed = Number(raw);
          onChange(Number.isFinite(parsed) ? parsed : undefined);
        }}
      />
      {description}
    </Field>
  );
}
