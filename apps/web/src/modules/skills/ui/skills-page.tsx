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
import type { SkillSummary } from "../schema.ts";

export function SkillsPage() {
  const query = useQuery(skillsQuery);
  const [search, setSearch] = useState("");
  const rows = (query.data ?? []).filter((skill) =>
    `${skill.name} ${skill.description} ${skill.ownerName ?? ""}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const create = (
    <CreateSplitButton
      label="New skill"
      options={[
        { label: "Write it yourself", icon: PencilEdit02Icon, link: <Link to="/skills/new" /> },
        { label: "Import a skill", icon: FileImportIcon, link: <Link to="/skills/import" /> },
      ]}
    />
  );
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
      title="Skills"
      rootPath="/"
      rootLabel="Chat"
      actions={create}
    >
      {/* Searching an empty library is noise; the empty state says more. */}
      {query.data?.length ? (
        <SearchInput
          aria-label="Search your skills"
          placeholder="Search your skills…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      ) : null}
      {query.isError ? (
        <ErrorState
          title="Could not load skills"
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : null}
      {query.isPending ? <ListSkeleton label="Loading skills" /> : null}
      {query.data?.length === 0 ? (
        <EmptyState
          icon={Book02Icon}
          title="No skills yet"
          description="Create a skill or import an editable copy."
          action={create}
        />
      ) : null}
      {query.data?.length && rows.length === 0 ? (
        <EmptyState
          icon={Book02Icon}
          title="No matching skills"
          description="Try another name or description."
          action={
            <Button variant="ghost" onClick={() => setSearch("")}>
              Clear search
            </Button>
          }
        />
      ) : null}
      {rows.some((skill) => skill.canEdit) ? (
        <Section title="Your skills">{list(rows.filter((skill) => skill.canEdit))}</Section>
      ) : null}
      {rows.some((skill) => !skill.canEdit) ? (
        <Section title="Shared with you">{list(rows.filter((skill) => !skill.canEdit))}</Section>
      ) : null}
    </Page>
  );
}
