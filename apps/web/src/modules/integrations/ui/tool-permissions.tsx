import { m } from "~/paraglide/messages.js";
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
import type { IntegrationToolInfo, ToolAccess } from "../manifest.ts";
import { toolText } from "../tool-text.ts";

const CHOICES: ReadonlyArray<{
  value: ToolPermission;
  label: () => string;
  icon: typeof HandIcon;
}> = [
  { value: "allow", label: m.integrations_permission_allow, icon: CheckmarkCircle02Icon },
  { value: "ask", label: m.integrations_permission_ask, icon: HandIcon },
  { value: "block", label: m.integrations_permission_block, icon: UnavailableIcon },
];

/** What a tool does, for whoever may correct a server that says too little. */
export const accessChoices = (): ReadonlyArray<{ value: ToolAccess; label: string }> => [
  { value: "read", label: m.integrations_access_read() },
  { value: "write", label: m.integrations_access_write() },
  { value: "destructive", label: m.integrations_access_destructive() },
];

const groupItems = () => [
  ...CHOICES.map((choice) => ({ value: choice.value, label: choice.label() })),
  { value: "custom", label: m.integrations_permission_custom() },
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
  onAccessChange,
}: {
  /** The integration type whose tools these are. */
  kind: string;
  /** The integration's own tools; a shipped type's are its manifest's. */
  tools?: ReadonlyArray<IntegrationToolInfo>;
  permissions: Readonly<Record<string, ToolPermission>>;
  disabled?: boolean;
  /** Only the tools that changed; the server merges them in. */
  onChange: (changes: Record<string, ToolPermission>) => void;
  /** Given to whoever may say what each tool does: the owner of their own server. */
  onAccessChange?: ((tool: string, access: ToolAccess) => void) | undefined;
}) {
  const manifest = findIntegrationType(kind);
  const tools = (given ?? manifest?.tools ?? []).map((tool) => ({
    ...tool,
    title: toolText(kind, tool).title,
  }));
  // Their own group, so allowing every change at once never also lets mail go out unasked.
  const reaching = new Set(manifest?.allowances.flatMap((allowance) => allowance.tools) ?? []);
  const groups = [
    {
      key: "read",
      title: m.integrations_permission_group_read(),
      tools: tools.filter((t) => t.access === "read"),
    },
    {
      key: "write",
      title: m.integrations_permission_group_write(),
      tools: tools.filter((t) => t.access !== "read" && !reaching.has(t.name)),
    },
    {
      key: "reach",
      title: m.integrations_permission_group_reach(),
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
          onAccessChange={onAccessChange}
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
  onAccessChange,
}: {
  title: string;
  tools: ReadonlyArray<IntegrationToolInfo>;
  permissions: Readonly<Record<string, ToolPermission>>;
  disabled: boolean | undefined;
  onChange: (changes: Record<string, ToolPermission>) => void;
  onAccessChange: ((tool: string, access: ToolAccess) => void) | undefined;
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
          items={groupItems()}
          disabled={disabled}
          onValueChange={(value) => {
            const choice = CHOICES.find((entry) => entry.value === value);
            if (choice)
              onChange(Object.fromEntries(tools.map((tool) => [tool.name, choice.value])));
          }}
        >
          <SelectTrigger
            size="sm"
            aria-label={m.integrations_permission_label({ name: title })}
            className="w-44"
          >
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
                {choice.label()}
              </SelectItem>
            ))}
            {/* Shown only as the mixed state; picking it would mean nothing. */}
            {shared === "custom" ? (
              <SelectItem value="custom" disabled>
                {m.integrations_permission_custom()}
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
                {onAccessChange ? (
                  <Select
                    value={tool.access}
                    items={accessChoices()}
                    disabled={disabled}
                    onValueChange={(access) => {
                      const choice = accessChoices().find((entry) => entry.value === access);
                      if (choice) onAccessChange(tool.name, choice.value);
                    }}
                  >
                    <SelectTrigger
                      size="sm"
                      aria-label={m.integrations_tool_access_label({ tool: tool.title })}
                      className="w-40"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {accessChoices().map((choice) => (
                        <SelectItem key={choice.value} value={choice.value}>
                          {choice.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
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
                  aria-label={m.integrations_permission_label({ name: tool.title })}
                >
                  {CHOICES.map((choice) => (
                    <Tooltip key={choice.value}>
                      <TooltipTrigger
                        render={
                          <ToggleGroupItem value={choice.value} aria-label={choice.label()} />
                        }
                      >
                        <HugeiconsIcon icon={choice.icon} strokeWidth={2} />
                      </TooltipTrigger>
                      <TooltipContent>{choice.label()}</TooltipContent>
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
