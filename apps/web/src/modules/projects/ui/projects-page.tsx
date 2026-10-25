import { NameDialog } from "~/ui/name-dialog.tsx";
import { ProjectDescriptionField } from "./project-description-field.tsx";
import { ArrowRight01Icon, Folder01Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { capabilitiesQuery } from "~/modules/groups/client/queries.ts";
import { relativeAgeLabel } from "~/modules/chat/ui/timestamps.ts";
import {
  EmptyState,
  ErrorState,
  ListCard,
  ListRow,
  ListSkeleton,
  Page,
  Section,
} from "~/ui/page-shell.tsx";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { projectsQuery } from "../client/queries.ts";
import { PROJECT_LIMITS, type ProjectSummary } from "../schema.ts";
import { createProject } from "../server/functions.ts";
import { roleLabel } from "./role-labels.ts";

import { m } from "~/paraglide/messages.js";
import { getLocale } from "~/paraglide/runtime.js";

const detail = (project: ProjectSummary) =>
  [
    project.description ||
      m.projects_list_updated({
        age: relativeAgeLabel(project.updatedAt, new Date(), getLocale()),
      }),
    project.role === "owner" ? null : m.projects_list_shared_by({ name: project.ownerName }),
  ]
    .filter(Boolean)
    .join(" · ");

export function ProjectsPage() {
  const projects = useQuery(projectsQuery);
  const { data: capabilities } = useQuery(capabilitiesQuery);
  const [creating, setCreating] = useState(false);
  const rows = projects.data ?? [];
  const own = rows.filter((project) => project.role === "owner");
  const shared = rows.filter((project) => project.role !== "owner");
  const newProject = capabilities?.projectsCreate ? (
    <Button size="sm" onClick={() => setCreating(true)}>
      <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
      {m.projects_list_new()}
    </Button>
  ) : null;
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- list renders this page's rows beside it
  const list = (items: ProjectSummary[]) => (
    <ListCard>
      {items.map((project) => (
        <ListRow key={project.id}>
          <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-2xl">
            <HugeiconsIcon icon={Folder01Icon} strokeWidth={2} className="size-4" />
          </div>
          <Link
            to="/projects/$projectId"
            params={{ projectId: project.id }}
            className="flex min-w-0 flex-1 flex-col"
          >
            <span className="flex items-center gap-2 text-sm font-medium">
              <span className="truncate">{project.name}</span>
              {project.role === "owner" ? null : (
                <Badge variant="outline">{roleLabel[project.role]()}</Badge>
              )}
            </span>
            <span className="text-muted-foreground truncate text-xs">{detail(project)}</span>
          </Link>
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            strokeWidth={2}
            className="text-muted-foreground size-4 shrink-0"
          />
        </ListRow>
      ))}
    </ListCard>
  );
  return (
    <Page
      title={m.projects_title()}
      description={m.projects_list_description()}
      rootPath="/"
      rootLabel={m.projects_list_root_label()}
      actions={newProject}
    >
      {projects.isError ? (
        <ErrorState
          title={m.projects_list_load_failed()}
          onRetry={() => {
            void projects.refetch();
          }}
        />
      ) : projects.data === undefined ? (
        <ListSkeleton label={m.projects_list_loading()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Folder01Icon}
          title={m.projects_list_empty_title()}
          description={
            capabilities?.projectsCreate
              ? m.projects_list_empty_create()
              : m.projects_list_empty_shared()
          }
          action={newProject}
        />
      ) : (
        <>
          {own.length > 0 ? <Section title={m.projects_list_yours()}>{list(own)}</Section> : null}
          {shared.length > 0 ? (
            <Section title={m.projects_list_shared_with_you()}>{list(shared)}</Section>
          ) : null}
        </>
      )}
      <NewProjectDialog open={creating} onOpenChange={setCreating} />
    </Page>
  );
}

function NewProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [description, setDescription] = useState("");
  return (
    <NameDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setDescription("");
        onOpenChange(next);
      }}
      title={m.projects_new_title()}
      description={m.projects_new_description()}
      maxLength={PROJECT_LIMITS.name}
      placeholder={m.projects_new_placeholder()}
      submitLabel={m.projects_new_submit()}
      failure={m.projects_new_failed()}
      onSubmit={async (name) => {
        const project = await createProject({
          data: { name, description: description.trim() },
        });
        await queryClient.invalidateQueries({ queryKey: ["projects"] });
        await navigate({ to: "/projects/$projectId", params: { projectId: project.id } });
      }}
      renderExtra={(pending) => (
        <ProjectDescriptionField
          value={description}
          onChange={setDescription}
          pending={pending}
          placeholder={m.projects_new_description_placeholder()}
          hint={m.projects_new_description_hint()}
        />
      )}
    />
  );
}
