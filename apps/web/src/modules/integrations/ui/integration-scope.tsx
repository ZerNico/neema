import { getLocale } from "~/paraglide/runtime.js";
import { m } from "~/paraglide/messages.js";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { ListCard, Section } from "~/ui/page-shell.tsx";
import { Checkbox } from "~/ui/primitives/checkbox";
import { RadioGroup, RadioGroupItem } from "~/ui/primitives/radio-group";
import { Skeleton } from "~/ui/primitives/skeleton";
import { SearchInput } from "~/ui/search-input.tsx";
import { cn } from "~/ui/utils";
import { findIntegrationType } from "../catalog.ts";
import { integrationScopeOptionsQuery } from "../client/queries.ts";
import type { IntegrationScope } from "../manifest.ts";
import type { IntegrationConnectionView, ScopeOption, UserIntegration } from "../schema.ts";

/** Past this many, the list gets a filter field. */
const FILTER_FROM = 8;
/**
 * One list and one row shape for the items and their loading placeholders, so
 * the card keeps its size when the list arrives. Eight rows fill the capped
 * height; widths vary so they read as names rather than one bar repeated.
 */
const LIST = "divide-border border-border max-h-80 divide-y border-t";
const ROW = "flex items-center gap-3 px-4 py-2.5";
const SKELETON_WIDTHS = ["w-40", "w-56", "w-32", "w-48", "w-36", "w-52", "w-44", "w-28"];

/**
 * Limits a connection to some of the manifest scope's items: two choices,
 * the list of items nested under the second. Every change saves at once:
 * "All" as null, a limit as the ticked items, none ticked included, which
 * reaches nothing rather than falling back to everything.
 */
export function IntegrationScopeSection({
  integration,
  connection,
  onChange,
}: {
  integration: UserIntegration;
  /** The account being limited; each has its own. */
  connection: IntegrationConnectionView;
  onChange: (scope: string[] | null) => void;
}) {
  const manifest = findIntegrationType(integration.kind)!;
  const scope = manifest.scope!;
  const saved = connection.scope;
  const items = scope.plural(getLocale());
  const id = useId();
  const queryClient = useQueryClient();
  const [limited, setLimited] = useState(saved !== null);
  const [picked, setPicked] = useState<string[]>(saved ?? []);
  // What was picked when the page opened leads the list, and stays put while ticking.
  const [pinned] = useState(() => new Set(saved ?? []));
  // Fetched on the way to choosing a limit, so the list is usually there by the click.
  const prefetch = () =>
    void queryClient.prefetchQuery(integrationScopeOptionsQuery(connection.id));

  const choice = (value: "all" | "some", title: string, description: string) => (
    <label
      htmlFor={`${id}-${value}`}
      className="hover:bg-accent/50 flex cursor-pointer items-start gap-3 px-4 py-3 transition-colors"
      {...(value === "some" ? { onPointerEnter: prefetch, onFocus: prefetch } : {})}
    >
      <RadioGroupItem
        id={`${id}-${value}`}
        value={value}
        aria-labelledby={`${id}-${value}-title`}
        aria-describedby={`${id}-${value}-description`}
        className="mt-0.5"
      />
      <span className="flex flex-col gap-0.5">
        <span id={`${id}-${value}-title`} className="text-sm font-medium">
          {title}
        </span>
        <span id={`${id}-${value}-description`} className="text-muted-foreground text-xs">
          {description}
        </span>
      </span>
    </label>
  );

  return (
    <Section title={scope.label(getLocale())}>
      <ListCard>
        <RadioGroup
          variant="list"
          value={limited ? "some" : "all"}
          onValueChange={(value) => {
            const next = value === "some";
            setLimited(next);
            if (!next) onChange(null);
            else onChange(picked);
          }}
          aria-label={m.integrations_scope_which({ items })}
        >
          {choice(
            "all",
            m.integrations_scope_all({ items }),
            m.integrations_scope_all_description({ name: integration.name }),
          )}
          {choice(
            "some",
            m.integrations_scope_some({ items }),
            m.integrations_scope_some_description(),
          )}
        </RadioGroup>
        {limited ? (
          <ScopePicker
            connectionId={connection.id}
            scope={scope}
            picked={picked}
            pinned={pinned}
            onToggle={(item, on) => {
              const next = on ? [...picked, item] : picked.filter((entry) => entry !== item);
              setPicked(next);
              onChange(next);
            }}
          />
        ) : null}
      </ListCard>
    </Section>
  );
}

/**
 * The items to tick. A saved item the service no longer lists still appears,
 * so it can be unticked.
 */
function ScopePicker({
  connectionId,
  scope,
  picked,
  pinned,
  onToggle,
}: {
  connectionId: string;
  scope: IntegrationScope;
  picked: ReadonlyArray<string>;
  pinned: ReadonlySet<string>;
  onToggle: (item: string, on: boolean) => void;
}) {
  const id = useId();
  const items = scope.plural(getLocale());
  const [filter, setFilter] = useState("");
  const options = useQuery(integrationScopeOptionsQuery(connectionId));
  const known = options.data?.ok ? options.data.options : [];
  const listed: ReadonlyArray<ScopeOption> = [
    ...known,
    ...picked
      .filter((item) => !known.some((option) => option.id === item))
      .map((item) => ({ id: item, label: item })),
  ].toSorted((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)));
  const query = filter.trim().toLowerCase();
  const shown = query
    ? listed.filter((item) => `${item.label} ${item.detail ?? ""}`.toLowerCase().includes(query))
    : listed;

  return (
    <div className="border-border flex flex-col border-t">
      <div className="flex min-h-15 items-center gap-3 px-4 py-3">
        {options.isPending ? (
          <Skeleton className="h-9 w-64" />
        ) : listed.length > FILTER_FROM ? (
          <SearchInput
            className="max-w-64"
            placeholder={m.integrations_scope_filter({ items })}
            aria-label={m.integrations_scope_filter({ items })}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        ) : null}
        <span className="text-muted-foreground ml-auto text-sm tabular-nums">
          {picked.length
            ? m.integrations_scope_selected({ count: picked.length })
            : m.integrations_scope_none_selected()}
        </span>
      </div>
      {options.isPending ? (
        // As tall as the list it stands in for, so nothing jumps when it arrives.
        <ul aria-busy className={cn(LIST, "overflow-hidden")}>
          <li className="sr-only">{m.integrations_scope_loading({ items })}</li>
          {SKELETON_WIDTHS.map((width) => (
            <li key={width} className={ROW}>
              <Skeleton className="size-4" />
              {/* A line of text is 20px; the bar sits inside one. */}
              <span className="flex h-5 flex-1 items-center">
                <Skeleton className={cn("h-3.5", width)} />
              </span>
              <Skeleton className="h-3 w-10" />
            </li>
          ))}
        </ul>
      ) : options.data && !options.data.ok ? (
        <p className="text-destructive border-border border-t px-4 py-3 text-sm">
          {options.data.error}
        </p>
      ) : shown.length === 0 ? (
        <p className="text-muted-foreground border-border border-t px-4 py-3 text-sm">
          {m.integrations_scope_no_match({ items })}
        </p>
      ) : (
        <ul className={cn(LIST, "overflow-y-auto")}>
          {shown.map((item) => {
            const checkbox = `${id}-${item.id}`;
            return (
              <li key={item.id}>
                <label
                  htmlFor={checkbox}
                  className={cn(ROW, "hover:bg-accent/50 cursor-pointer transition-colors")}
                >
                  <Checkbox
                    id={checkbox}
                    // Base UI labels its hidden input; the visible control needs its own name.
                    aria-label={item.detail ? `${item.label} (${item.detail})` : item.label}
                    checked={picked.includes(item.id)}
                    onCheckedChange={(on) => onToggle(item.id, on)}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
                  {item.detail ? (
                    <span className="text-muted-foreground shrink-0 font-mono text-xs">
                      {item.detail}
                    </span>
                  ) : null}
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
