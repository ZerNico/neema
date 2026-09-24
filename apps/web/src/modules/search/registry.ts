import type { IconSvgElement } from "@hugeicons/react";
import { useQuery, type QueryKey, type UseQueryOptions } from "@tanstack/react-query";
import { capabilitiesQuery } from "~/modules/groups/client/queries.ts";
import type { Capabilities } from "~/modules/groups/policy.ts";
import { matchesWords } from "./match.ts";
import type { Snippet } from "./text.ts";

/**
 * One row in the palette. It navigates (`href`) or runs (`run`); a snippet is
 * plain text with ranges, whatever backend produced it.
 */
export interface SearchItem {
  readonly id: string;
  readonly label: string;
  readonly detail?: string | undefined;
  readonly snippet?: Snippet | null | undefined;
  readonly icon: IconSvgElement;
  readonly href?: string;
  readonly run?: () => void;
}

/** What one search source found for the current query. */
export interface SearchResults {
  readonly heading: string;
  /** `>` narrows the palette to action sources. */
  readonly kind: "action" | "result";
  readonly items: SearchItem[];
  readonly pending: boolean;
}

/**
 * A search source is a hook: it owns its matching, its permission check and
 * its cap. `active` is false while the palette is closed or narrowed away
 * from it, so it fetches nothing then. Sources are registered by calling them
 * in `useSearchGroups` (search-sources.ts).
 */
export type SearchSource = (query: string, active: boolean) => SearchResults;

export const RESULT_LIMIT = 5;

/**
 * A kind whose whole list the browser already loads for its own pages
 * (agents, collections, skills, schedules): filtered locally, no server search.
 */
export function listSource<
  List extends ReadonlyArray<{ id: string; name: string }>,
  Key extends QueryKey,
>(config: {
  heading: string;
  icon: IconSvgElement;
  query: UseQueryOptions<List, Error, List, Key>;
  allowed: (capabilities: Capabilities) => boolean;
  /** Text matched besides the name, such as a description. */
  text?: (item: List[number]) => string;
  detail?: (item: List[number]) => string | undefined;
  href: (item: List[number]) => string;
}): SearchSource {
  return function useListSource(query, active) {
    const { data: capabilities } = useQuery(capabilitiesQuery);
    const allowed = !!capabilities && config.allowed(capabilities);
    const list = useQuery({ ...config.query, enabled: active && allowed });
    const empty = { heading: config.heading, kind: "result" as const, items: [], pending: false };
    if (!active || !allowed || !query) return empty;
    return {
      ...empty,
      items: (list.data ?? [])
        .filter((item) => matchesWords(`${item.name} ${config.text?.(item) ?? ""}`, query))
        .slice(0, RESULT_LIMIT)
        .map((item) => ({
          id: `${config.heading}:${item.id}`,
          label: item.name,
          detail: config.detail?.(item),
          icon: config.icon,
          href: config.href(item),
        })),
      pending: list.isPending,
    };
  };
}

/** A palette section: the source's heading and its rows. */
export interface SearchGroup {
  readonly value: string;
  readonly items: SearchItem[];
}

/** `>` at the start of the input asks for actions only, as in VS Code. */
export const parsePaletteQuery = (input: string) => {
  const trimmed = input.trim();
  const actionsOnly = trimmed.startsWith(">");
  return { actionsOnly, query: actionsOnly ? trimmed.slice(1).trim() : trimmed };
};

/** The non-empty sections, in the order the sources were called. */
export const collectGroups = (results: ReadonlyArray<SearchResults>) => ({
  groups: results
    .filter((result) => result.items.length > 0)
    .map((result): SearchGroup => ({ value: result.heading, items: result.items })),
  pending: results.some((result) => result.pending),
});
