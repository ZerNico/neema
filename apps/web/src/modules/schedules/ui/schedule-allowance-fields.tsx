import { useId, useState } from "react";
import { findIntegrationType } from "~/modules/integrations/catalog.ts";
import { ALLOWANCE_LIMITS, type IntegrationGrant } from "~/modules/integrations/grant.ts";
import type { IntegrationAllowance } from "~/modules/integrations/manifest.ts";
import { parseMailbox } from "~/modules/integrations/mailbox.ts";
import { ListRow } from "~/ui/page-shell.tsx";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxValue,
  useComboboxAnchor,
} from "~/ui/primitives/combobox";
import { FieldDescription } from "~/ui/primitives/field";
import { Switch } from "~/ui/primitives/switch";
import { m } from "~/paraglide/messages.js";

/**
 * One switch per allowance the integration declares, shown under "Read and
 * write"; on, it takes the exact addresses runs may contact that way.
 */
export function ScheduleAllowanceFields({
  kind,
  grant,
  onChange,
}: {
  /** The integration's type, which declares the allowances. */
  kind: string;
  grant: IntegrationGrant;
  onChange: (grant: IntegrationGrant) => void;
}) {
  const allowances = findIntegrationType(kind)?.allowances ?? [];
  if (grant.access !== "write" || allowances.length === 0) return null;
  const current = grant.allowances ?? {};
  const set = (id: string, targets: ReadonlyArray<string> | null) => {
    const { [id]: _removed, ...rest } = current;
    const next = targets ? { ...rest, [id]: { targets } } : rest;
    onChange({
      connectionId: grant.connectionId,
      integrationId: grant.integrationId,
      access: grant.access,
      ...(Object.keys(next).length ? { allowances: next } : {}),
    });
  };
  return allowances.map((allowance) => {
    const targets = current[allowance.id]?.targets ?? null;
    return (
      <ListRow key={allowance.id} className="flex-col items-stretch gap-2">
        <div className="flex items-center gap-3">
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">{allowance.label}</span>
            <span className="text-muted-foreground text-xs">{allowance.description}</span>
          </div>
          <Switch
            checked={targets !== null}
            onCheckedChange={(checked) => set(allowance.id, checked ? [] : null)}
            aria-label={allowance.label}
          />
        </div>
        {targets !== null ? (
          <AllowanceTargets
            allowance={allowance}
            targets={targets}
            onChange={(next) => set(allowance.id, next)}
          />
        ) : null}
      </ListRow>
    );
  });
}

function AllowanceTargets({
  allowance,
  targets,
  onChange,
}: {
  allowance: IntegrationAllowance;
  targets: ReadonlyArray<string>;
  onChange: (targets: ReadonlyArray<string>) => void;
}) {
  const id = useId();
  const anchor = useComboboxAnchor();
  const [text, setText] = useState("");
  const [rejected, setRejected] = useState<string | null>(null);
  const full = targets.length >= ALLOWANCE_LIMITS.targets;
  // Typed or pasted text becomes chips at a separator; anything unparsable stays put.
  const commit = (raw: string) => {
    const parts = raw
      .split(/[\s,;]+/)
      .map((part) => part.trim())
      .filter(Boolean);
    const added: string[] = [];
    const left: string[] = [];
    for (const part of parts) {
      const address = parseMailbox(part);
      if (address && targets.length + added.length < ALLOWANCE_LIMITS.targets) {
        if (!targets.includes(address) && !added.includes(address)) added.push(address);
      } else left.push(part);
    }
    if (added.length) onChange([...targets, ...added]);
    setText(left.join(" "));
    setRejected(left[0] ?? null);
  };
  return (
    <div className="flex flex-col gap-1.5">
      <Combobox
        multiple
        items={[...targets]}
        value={[...targets]}
        onValueChange={(next: string[]) => onChange(next)}
        inputValue={text}
        onInputValueChange={(value: string) => {
          setRejected(null);
          if (/[\s,;]/.test(value)) commit(value);
          else setText(value);
        }}
      >
        <ComboboxChips ref={anchor} aria-invalid={targets.length === 0 || rejected !== null}>
          <ComboboxValue>
            {(value: string[]) => (
              <>
                {value.map((address) => (
                  <ComboboxChip key={address} aria-label={address}>
                    {address}
                  </ComboboxChip>
                ))}
                <ComboboxChipsInput
                  id={id}
                  aria-label={m.schedules_allowance_addresses({ label: allowance.label })}
                  disabled={full}
                  placeholder={value.length ? "" : "name@example.com"}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && text.trim()) {
                      event.preventDefault();
                      commit(text);
                    }
                  }}
                  onBlur={() => {
                    if (text.trim()) commit(text);
                  }}
                />
              </>
            )}
          </ComboboxValue>
        </ComboboxChips>
      </Combobox>
      <FieldDescription>
        {rejected
          ? m.schedules_allowance_not_plain({ address: rejected })
          : targets.length === 0
            ? m.schedules_allowance_add_one()
            : m.schedules_allowance_cap({ cap: allowance.cap })}
      </FieldDescription>
    </div>
  );
}
