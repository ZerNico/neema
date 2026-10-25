import {
  ArrowRight01Icon,
  Book02Icon,
  FileImportIcon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  EmptyState,
  ErrorState,
  ListCard,
  ListRow,
  ListSkeleton,
  Page,
  Section,
} from "~/ui/page-shell.tsx";
import { CreateSplitButton } from "~/ui/create-split-button.tsx";
import { Button } from "~/ui/primitives/button";
import { SearchInput } from "~/ui/search-input.tsx";
import { skillsQuery } from "../client/queries.ts";
import { capabilitiesQuery } from "~/modules/groups/client/queries.ts";
import type { SkillSummary } from "../schema.ts";

import { m } from "~/paraglide/messages.js";

export function SkillsPage() {
  const query = useQuery(skillsQuery);
  const { data: capabilities } = useQuery(capabilitiesQuery);
  const [search, setSearch] = useState("");
  const rows = (query.data ?? []).filter((skill) =>
    `${skill.name} ${skill.description} ${skill.ownerName ?? ""}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const create = (
    <CreateSplitButton
      label={m.skills_list_new()}
      options={[
        {
          label: m.skills_list_write(),
          icon: PencilEdit02Icon,
          link: <Link to="/skills/new" />,
        },
        {
          label: m.skills_list_import(),
          icon: FileImportIcon,
          link: <Link to="/skills/import" />,
        },
      ]}
    />
  );
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- list renders this page's rows beside it
  const list = (items: SkillSummary[]) => (
    <ListCard>
      {items.map((skill) => (
        <Link key={skill.id} to="/skills/$skillId" params={{ skillId: skill.id }} className="block">
          <ListRow interactive>
            <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-2xl">
              <HugeiconsIcon icon={Book02Icon} strokeWidth={2} className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{skill.name}</p>
              <p className="text-muted-foreground truncate text-xs">
                {skill.description}
                {skill.ownerName ? ` · ${skill.ownerName}` : ""}
              </p>
            </div>
            <HugeiconsIcon
              strokeWidth={2}
              icon={ArrowRight01Icon}
              className="text-muted-foreground size-4 shrink-0"
            />
          </ListRow>
        </Link>
      ))}
    </ListCard>
  );
  return (
    <Page
      title={m.skills_title()}
      rootPath="/"
      rootLabel={m.skills_list_root_label()}
      actions={capabilities?.skillsCreate ? create : null}
    >
      {/* Searching an empty library is noise; the empty state says more. */}
      {query.data?.length ? (
        <SearchInput
          aria-label={m.skills_list_search()}
          placeholder={m.skills_list_search_placeholder()}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      ) : null}
      {query.isError ? (
        <ErrorState
          title={m.skills_list_load_failed()}
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : null}
      {query.isPending ? <ListSkeleton label={m.skills_list_loading()} /> : null}
      {query.data?.length === 0 ? (
        <EmptyState
          icon={Book02Icon}
          title={m.skills_list_empty_title()}
          description={
            capabilities?.skillsCreate ? m.skills_list_empty_create() : m.skills_list_empty_shared()
          }
          action={capabilities?.skillsCreate ? create : null}
        />
      ) : null}
      {query.data?.length && rows.length === 0 ? (
        <EmptyState
          icon={Book02Icon}
          title={m.skills_list_no_matches()}
          description={m.skills_list_no_matches_description()}
          action={
            <Button variant="ghost" onClick={() => setSearch("")}>
              {m.skills_list_clear_search()}
            </Button>
          }
        />
      ) : null}
      {rows.some((skill) => skill.canEdit) ? (
        <Section title={m.skills_list_yours()}>
          {list(rows.filter((skill) => skill.canEdit))}
        </Section>
      ) : null}
      {rows.some((skill) => !skill.canEdit) ? (
        <Section title={m.skills_list_shared_with_you()}>
          {list(rows.filter((skill) => !skill.canEdit))}
        </Section>
      ) : null}
    </Page>
  );
}
