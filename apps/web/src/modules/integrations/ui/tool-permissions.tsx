import {
  ArrowDown01Icon,
  CheckmarkCircle02Icon,
  HandIcon,
  MoreHorizontalCircle01Icon,
  UnavailableIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";
import { ToggleGroup, ToggleGroupItem } from "~/ui/primitives/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { cn } from "~/ui/utils";
import { findIntegrationType } from "../catalog.ts";
import { permissionFor, type ToolPermission } from "../consent.ts";
import type { IntegrationToolInfo } from "../manifest.ts";

const CHOICES: ReadonlyArray<{ value: ToolPermission; label: string; icon: typeof HandIcon }> = [
  { value: "allow", label: "Always allow", icon: CheckmarkCircle02Icon },
  { value: "ask", label: "Needs approval", icon: HandIcon },
  { value: "block", label: "Blocked", icon: UnavailableIcon },
];

const GROUP_ITEMS = [
  ...CHOICES.map((choice) => ({ value: choice.value, label: choice.label })),
  { value: "custom", label: "Custom" },
];

/**
 * Per-tool permissions for one connection, grouped by what the tools can do.
 * A group's select sets every tool in it and reads "Custom" once they differ.
 */
export function ToolPermissions({
  kind,
  tools: given,
  permissions,
  disabled,
  onChange,
}: {
  /** The integration type whose tools these are. */
  kind: string;
  /** The integration's own tools; a shipped type's are its manifest's. */
  tools?: ReadonlyArray<IntegrationToolInfo>;
  permissions: Readonly<Record<string, ToolPermission>>;
  disabled?: boolean;
  /** Only the tools that changed; the server merges them in. */
  onChange: (changes: Record<string, ToolPermission>) => void;
}) {
  const manifest = findIntegrationType(kind);
  const tools = given ?? manifest?.tools ?? [];
  // Their own group, so allowing every change at once never also lets mail go out unasked.
  const reaching = new Set(manifest?.allowances.flatMap((allowance) => allowance.tools) ?? []);
  const groups = [
    {
      key: "read",
      title: "Read-only tools",
      tools: tools.filter((t) => t.access === "read"),
    },
    {
      key: "write",
      title: "Write and delete tools",
      tools: tools.filter((t) => t.access !== "read" && !reaching.has(t.name)),
    },
    {
      key: "reach",
      title: "Tools that contact people",
      tools: tools.filter((t) => reaching.has(t.name)),
    },
  ].filter((group) => group.tools.length > 0);

  return (
    <div className="flex flex-col gap-3">
      {groups.map((group) => (
        <ToolGroup
          key={group.key}
          title={group.title}
          tools={group.tools}
          permissions={permissions}
          disabled={disabled}
          onChange={onChange}
        />
      ))}
    </div>
  );
}

function ToolGroup({
  title,
  tools,
  permissions,
  disabled,
  onChange,
}: {
  title: string;
  tools: ReadonlyArray<IntegrationToolInfo>;
  permissions: Readonly<Record<string, ToolPermission>>;
  disabled: boolean | undefined;
  onChange: (changes: Record<string, ToolPermission>) => void;
}) {
  const [open, setOpen] = useState(true);
  const values = tools.map((tool) => permissionFor(tool, permissions));
  const shared = values.every((value) => value === values[0]) ? values[0]! : "custom";
  const current = CHOICES.find((choice) => choice.value === shared);

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="text-foreground flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            strokeWidth={2}
            className={cn("size-3.5 shrink-0 transition-transform", !open && "-rotate-90")}
            aria-hidden
          />
          {title}
          <span className="text-muted-foreground text-xs tabular-nums">{tools.length}</span>
        </button>
        <Select
          value={shared}
          items={GROUP_ITEMS}
          disabled={disabled}
          onValueChange={(value) => {
            const choice = CHOICES.find((entry) => entry.value === value);
            if (choice)
              onChange(Object.fromEntries(tools.map((tool) => [tool.name, choice.value])));
          }}
        >
          <SelectTrigger size="sm" aria-label={`${title} permission`} className="w-44">
            <HugeiconsIcon
              icon={current?.icon ?? MoreHorizontalCircle01Icon}
              strokeWidth={2}
              aria-hidden
            />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CHOICES.map((choice) => (
              <SelectItem key={choice.value} value={choice.value}>
                {choice.label}
              </SelectItem>
            ))}
            {/* Shown only as the mixed state; picking it would mean nothing. */}
            {shared === "custom" ? (
              <SelectItem value="custom" disabled>
                Custom
              </SelectItem>
            ) : null}
          </SelectContent>
        </Select>
      </div>
      {open ? (
        <ul className="divide-border mt-1 flex flex-col divide-y">
          {tools.map((tool) => {
            const value = permissionFor(tool, permissions);
            return (
              <li key={tool.name} className="flex items-center gap-3 py-2 pl-5.5">
                <span className="min-w-0 flex-1 truncate text-sm" title={tool.description}>
                  {tool.title}
                </span>
                <ToggleGroup
                  value={[value]}
                  onValueChange={(next) => {
                    const choice = next.at(-1);
                    if (choice === "allow" || choice === "ask" || choice === "block")
                      onChange({ [tool.name]: choice });
                  }}
                  variant="outline"
                  size="sm"
                  spacing={0}
                  disabled={disabled}
                  aria-label={`${tool.title} permission`}
                >
                  {CHOICES.map((choice) => (
                    <Tooltip key={choice.value}>
                      <TooltipTrigger
                        render={<ToggleGroupItem value={choice.value} aria-label={choice.label} />}
                      >
                        <HugeiconsIcon icon={choice.icon} strokeWidth={2} />
                      </TooltipTrigger>
                      <TooltipContent>{choice.label}</TooltipContent>
                    </Tooltip>
                  ))}
                </ToggleGroup>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
