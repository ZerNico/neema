import { ArrowRight01Icon, BookOpen01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { EmptyState, ErrorState, ListCard, ListRow, Page, Section } from "~/ui/page-shell.tsx";
import { Button, buttonVariants } from "~/ui/primitives/button";
import { Input } from "~/ui/primitives/input";
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
    <Link to="/skills/new" className={buttonVariants({ size: "sm" })}>
      Create skill
    </Link>
  );
  const list = (items: SkillSummary[]) => (
    <ListCard>
      {items.map((skill) => (
        <Link key={skill.id} to="/skills/$skillId" params={{ skillId: skill.id }} className="block">
          <ListRow interactive>
            <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-2xl">
              <HugeiconsIcon icon={BookOpen01Icon} className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{skill.name}</p>
              <p className="text-muted-foreground truncate text-xs">
                {skill.description}
                {skill.ownerName ? ` · ${skill.ownerName}` : ""}
              </p>
            </div>
            <HugeiconsIcon icon={ArrowRight01Icon} className="text-muted-foreground size-4" />
          </ListRow>
        </Link>
      ))}
    </ListCard>
  );
  return (
    <Page
      title="Skills"
      description="Reusable instructions for the tasks you do often."
      rootPath="/"
      rootLabel="Chat"
      actions={
        <>
          <Link to="/skills/import" className={buttonVariants({ size: "sm", variant: "outline" })}>
            Import
          </Link>
          {create}
        </>
      }
    >
      {/* Searching an empty library is noise; the empty state says more. */}
      {query.data?.length ? (
        <div className="relative">
          <HugeiconsIcon
            icon={Search01Icon}
            strokeWidth={2}
            aria-hidden
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
          />
          <Input
            aria-label="Search your skills"
            placeholder="Search your skills…"
            className="pl-9"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      ) : null}
      {query.isError ? (
        <ErrorState
          title="Could not load skills"
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : null}
      {query.isPending ? (
        <ListCard>
          {[0, 1, 2].map((key) => (
            <ListRow key={key}>
              <div className="bg-muted h-10 w-full animate-pulse rounded-2xl" />
            </ListRow>
          ))}
        </ListCard>
      ) : null}
      {query.data?.length === 0 ? (
        <EmptyState
          icon={BookOpen01Icon}
          title="No skills yet"
          description="Create a skill or import an editable copy."
          action={create}
        />
      ) : null}
      {query.data?.length && rows.length === 0 ? (
        <EmptyState
          icon={BookOpen01Icon}
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
