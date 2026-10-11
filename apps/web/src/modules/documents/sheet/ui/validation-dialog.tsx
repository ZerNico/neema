import { useState } from "react";
import type { Validation, ValidationTest } from "@chat/sheet/model/validation";
import { Button } from "~/ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import { Field, FieldDescription, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";
import { Switch } from "~/ui/primitives/switch";
import { Textarea } from "~/ui/primitives/textarea";

const ALLOW = [
  { value: "any", label: "Any value" },
  { value: "whole", label: "Whole number" },
  { value: "decimal", label: "Decimal" },
  { value: "list", label: "List" },
  { value: "date", label: "Date" },
  { value: "length", label: "Text length" },
] as const;
type Allow = (typeof ALLOW)[number]["value"];
const TESTS: ReadonlyArray<{ value: ValidationTest; label: string }> = [
  { value: "between", label: "between" },
  { value: "notBetween", label: "not between" },
  { value: "equal", label: "equal to" },
  { value: "notEqual", label: "not equal to" },
  { value: "greater", label: "greater than" },
  { value: "less", label: "less than" },
  { value: "greaterOrEqual", label: "greater than or equal to" },
  { value: "lessOrEqual", label: "less than or equal to" },
];
const ON_ERROR = [
  { value: "stop", label: "Stop: refuse the entry" },
  { value: "warning", label: "Warning: ask before keeping it" },
  { value: "information", label: "Information: keep it and say so" },
] as const;

/** What the dialog sets: a rule with a list written out or read from a range typed as text. */
export type ValidationDraft = Omit<Validation, "id" | "box" | "rule"> & {
  readonly rule: Validation["rule"] | { readonly kind: "list"; readonly range: string };
};

/**
 * Excel's Data Validation dialog for the selection: what its cells may hold,
 * and what typing something else does. A list is written out, separated by
 * commas, or read from cells written as =A1:A9.
 */
export function ValidationDialog({
  current,
  currentRange,
  readDate,
  onApply,
  onClose,
}: {
  current: Validation | null;
  /** The current list's source cells as A1 text, when it reads cells. */
  currentRange: string | null;
  /** A date as typed, as the serial a cell would keep; null when it is not one. */
  readDate: (text: string) => number | null;
  onApply: (validation: ValidationDraft | null) => void;
  onClose: () => void;
}) {
  const rule = current?.rule;
  const [allow, setAllow] = useState<Allow>(rule?.kind ?? "any");
  const [test, setTest] = useState<ValidationTest>(
    rule && rule.kind !== "list" ? rule.test : "between",
  );
  const [first, setFirst] = useState(rule && rule.kind !== "list" ? String(rule.values[0]) : "");
  const [second, setSecond] = useState(
    rule && rule.kind !== "list" && rule.values[1] !== undefined ? String(rule.values[1]) : "",
  );
  const [list, setList] = useState(
    rule?.kind === "list"
      ? currentRange
        ? `=${currentRange}`
        : (rule.values ?? []).join(", ")
      : "",
  );
  const [allowBlank, setAllowBlank] = useState(current?.allowBlank ?? true);
  const [onError, setOnError] = useState<Validation["onError"]>(current?.onError ?? "stop");
  const [message, setMessage] = useState(current?.message ?? "");
  const two = test === "between" || test === "notBetween";
  const number = (text: string) => {
    if (allow === "date") return readDate(text);
    const read = Number(text.replace(",", "."));
    return text.trim() && Number.isFinite(read) ? read : null;
  };
  const draft = ((): ValidationDraft | null | "invalid" => {
    if (allow === "any") return null;
    const shared = {
      allowBlank,
      onError,
      ...(message.trim() ? { message: message.trim().slice(0, 255) } : {}),
    };
    if (allow === "list") {
      const text = list.trim();
      if (!text) return "invalid";
      if (text.startsWith("=")) return { ...shared, rule: { kind: "list", range: text.slice(1) } };
      const values = [
        ...new Set(
          text
            .split(",")
            .map((each) => each.trim())
            .filter(Boolean),
        ),
      ];
      return values.length ? { ...shared, rule: { kind: "list", values } } : "invalid";
    }
    const [a, b] = [number(first), two ? number(second) : null];
    if (a === null || (two && b === null)) return "invalid";
    return {
      ...shared,
      rule: { kind: allow, test, values: two ? [a, b!] : [a] },
    };
  })();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Data validation</DialogTitle>
          <DialogDescription>What the selected cells may hold.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="validation-allow">Allow</FieldLabel>
            <Select items={ALLOW} value={allow} onValueChange={(next) => next && setAllow(next)}>
              <SelectTrigger id="validation-allow" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ALLOW.map((each) => (
                  <SelectItem key={each.value} value={each.value}>
                    {each.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {allow === "list" ? (
            <Field>
              <FieldLabel htmlFor="validation-list">Source</FieldLabel>
              <Input
                id="validation-list"
                placeholder="Open, Done, Blocked"
                value={list}
                onChange={(event) => setList(event.target.value)}
              />
              <FieldDescription>
                Separate choices with commas, or read them from cells as =C1:C9.
              </FieldDescription>
            </Field>
          ) : allow !== "any" ? (
            <>
              <Field>
                <FieldLabel htmlFor="validation-test">Data</FieldLabel>
                <Select items={TESTS} value={test} onValueChange={(next) => next && setTest(next)}>
                  <SelectTrigger id="validation-test" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TESTS.map((each) => (
                      <SelectItem key={each.value} value={each.value}>
                        {each.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <div className="flex gap-3">
                <Field>
                  <FieldLabel htmlFor="validation-first">{two ? "Minimum" : "Value"}</FieldLabel>
                  <Input
                    id="validation-first"
                    value={first}
                    placeholder={allow === "date" ? "2026-01-31" : "0"}
                    onChange={(event) => setFirst(event.target.value)}
                  />
                </Field>
                {two ? (
                  <Field>
                    <FieldLabel htmlFor="validation-second">Maximum</FieldLabel>
                    <Input
                      id="validation-second"
                      value={second}
                      placeholder={allow === "date" ? "2026-12-31" : "100"}
                      onChange={(event) => setSecond(event.target.value)}
                    />
                  </Field>
                ) : null}
              </div>
            </>
          ) : null}
          {allow !== "any" ? (
            <>
              <Field orientation="horizontal">
                <FieldLabel htmlFor="validation-blank">Ignore blank</FieldLabel>
                <Switch
                  id="validation-blank"
                  checked={allowBlank}
                  onCheckedChange={setAllowBlank}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="validation-error">When something else is typed</FieldLabel>
                <Select
                  items={ON_ERROR}
                  value={onError}
                  onValueChange={(next) => next && setOnError(next)}
                >
                  <SelectTrigger id="validation-error" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ON_ERROR.map((each) => (
                      <SelectItem key={each.value} value={each.value}>
                        {each.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="validation-message">Error message</FieldLabel>
                <Textarea
                  id="validation-message"
                  placeholder="This value doesn’t match the rules for this cell."
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                />
              </Field>
            </>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              onApply(null);
              onClose();
            }}
          >
            Clear all
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={draft === "invalid"}
            onClick={() => {
              if (draft === "invalid") return;
              onApply(draft);
              onClose();
            }}
          >
            OK
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
