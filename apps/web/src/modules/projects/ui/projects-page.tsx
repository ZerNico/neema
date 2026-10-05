import { ArrowRight01Icon, Folder01Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
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
import { PendingButton } from "~/ui/pending-button.tsx";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { Textarea } from "~/ui/primitives/textarea";
import { projectsQuery } from "../client/queries.ts";
import { PROJECT_LIMITS, type ProjectSummary } from "../schema.ts";
import { createProject } from "../server/functions.ts";
import { roleLabel } from "./role-labels.ts";

const detail = (project: ProjectSummary) =>
  [
    project.description || `Updated ${relativeAgeLabel(project.updatedAt)}`,
    project.role === "owner" ? null : `Shared by ${project.ownerName}`,
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
      New project
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
                <Badge variant="outline">{roleLabel[project.role]}</Badge>
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
      title="Projects"
      description="Instructions, documents and memory shared by everyone working on something. Your chats in a project stay yours."
      rootPath="/"
      rootLabel="Chat"
      actions={newProject}
    >
      {projects.isError ? (
        <ErrorState
          title="Could not load projects"
          onRetry={() => {
            void projects.refetch();
          }}
        />
      ) : projects.data === undefined ? (
        <ListSkeleton label="Loading projects" />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Folder01Icon}
          title="No projects yet"
          description={
            capabilities?.projectsCreate
              ? "Start a project for work you keep coming back to, alone or with others."
              : "No projects are shared with you yet."
          }
          action={newProject}
        />
      ) : (
        <>
          {own.length > 0 ? <Section title="Your projects">{list(own)}</Section> : null}
          {shared.length > 0 ? <Section title="Shared with you">{list(shared)}</Section> : null}
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
  const id = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const reset = () => {
    setName("");
    setDescription("");
  };
  const save = useMutation({
    mutationFn: () =>
      createProject({ data: { name: name.trim(), description: description.trim() } }),
    onSuccess: async (project) => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      onOpenChange(false);
      reset();
      await navigate({ to: "/projects/$projectId", params: { projectId: project.id } });
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          if (save.isPending) return;
          reset();
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Name the work. You can add instructions, documents and people next.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) save.mutate();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
              <Input
                id={`${id}-name`}
                value={name}
                maxLength={PROJECT_LIMITS.name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Website relaunch"
                disabled={save.isPending}
                autoFocus
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-description`}>Description</FieldLabel>
              <Textarea
                id={`${id}-description`}
                value={description}
                maxLength={PROJECT_LIMITS.description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What it is for, in a sentence"
                disabled={save.isPending}
              />
              <FieldDescription>Optional. Shown to everyone in the project.</FieldDescription>
            </Field>
          </FieldGroup>
          {save.isError ? <FieldError>Could not create the project.</FieldError> : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={save.isPending} />}>
              Cancel
            </DialogClose>
            <PendingButton type="submit" pending={save.isPending} disabled={!name.trim()}>
              Create project
            </PendingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
