import { Delete02Icon, MoreHorizontalIcon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useStore } from "@tanstack/react-form";
import { Link, useBlocker, useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { agentQuery } from "../client/queries.ts";
import { EMPTY_AGENT_DRAFT, agentDetailToSettings } from "../draft-schema.ts";
import { AgentSettings, AgentResourceIds, type AgentDetail } from "../schema.ts";
import { createAgent, deleteAgent, updateAgent } from "../server/functions.ts";
import { AgentSettingsFields } from "./agent-settings-fields.tsx";
import {
  AgentAuthoringLaunchButton,
  AgentAuthoringLaunchMenuItem,
} from "./agent-authoring-launch.tsx";
import { AccessDialog } from "~/modules/sharing/ui/access-dialog.tsx";
import { useConfirm } from "~/ui/confirm.tsx";
import { SaveLabel, SaveStatus, useSaveStatus } from "~/ui/save-status.tsx";
import { useAppForm } from "~/ui/form/app-form.tsx";
import { ErrorState, Page } from "~/ui/page-shell.tsx";
import { Button, buttonVariants } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { FieldError } from "~/ui/primitives/field";
import { toastError } from "~/ui/error-toast.ts";

const agentFormValidator = Schema.toStandardSchemaV1(
  Schema.Struct({
    ...AgentSettings.fields,
    skillIds: AgentResourceIds,
    customToolIds: AgentResourceIds,
  }),
);


/**
 * Owner-only editor. Recipients start chats from the agent list instead.
 */
export function AgentEditorPage({ agentId }: { agentId: string | null }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const detail = useQuery({ ...agentQuery(agentId ?? ""), enabled: agentId !== null });
  if (agentId !== null && detail.isError && !detail.data)
    return (
      <Page title="Agent" backTo="/agents" backLabel="Agents">
        <ErrorState
          title="Could not load this agent"
          description="It may have been deleted, or you no longer have access."
          onRetry={() => {
            void detail.refetch();
          }}
        />
      </Page>
    );
  if (agentId !== null && !detail.data) return null;
  const agent = detail.data ?? null;
  // A recipient can use the agent from the list; the editor is the owner's.
  // Showing "not found" rather than a read-only view keeps the page from
  // becoming a way to read instructions the owner did not choose to display.
  if (agent && !agent.canEdit)
    return (
      <Page title="Agent" backTo="/agents" backLabel="Agents">
        <ErrorState
          title="This agent isn’t yours to edit"
          description="You can start a chat with it from the Agents list."
        />
      </Page>
    );
  return (
    <AgentForm
      key={agent?.id ?? "new"}
      agent={agent}
      onSaved={async (id) => {
        await queryClient.invalidateQueries({ queryKey: ["agents"] });
        if (!agent) await navigate({ to: "/agents/$agentId", params: { agentId: id } });
      }}
      onDelete={
        agent
          ? async () => {
              await confirm({
                title: `Delete “${agent.name}”?`,
                description:
                  "Chats that used it keep the instructions they ran with; nobody can select it again.",
                confirmLabel: "Delete agent",
              }).then(async (confirmed) => {
                if (!confirmed) return;
                try {
                  await deleteAgent({ data: { agentId: agent.id } });
                  await queryClient.invalidateQueries({ queryKey: ["agents"] });
                  await navigate({ to: "/agents" });
                } catch {
                  toast.error("Could not delete the agent.");
                }
              });
            }
          : undefined
      }
    />
  );
}

function AgentForm({
  agent,
  onSaved,
  onDelete,
}: {
  agent: AgentDetail | null;
  onSaved: (agentId: string) => Promise<void>;
  onDelete: (() => Promise<void>) | undefined;
}) {
  const formElement = useRef<HTMLFormElement>(null);
  const formId = useId();
  const confirm = useConfirm();
  const [invalidSubmit, setInvalidSubmit] = useState(false);
  const [sharing, setSharing] = useState(false);
  // Dirty values retain the revision they came from, not the latest query revision.
  const revision = useRef(agent?.configRevision ?? null);
  const form = useAppForm({
    defaultValues: agent ? agentDetailToSettings(agent) : EMPTY_AGENT_DRAFT,
    validators: { onSubmit: agentFormValidator },
    onSubmit: async ({ value, formApi }) => {
      try {
        const settings: AgentSettings = {
          ...value,
          starters: value.starters.map((starter) => starter.trim()).filter(Boolean),
        };
        if (agent) {
          await updateAgent({
            data: { agentId: agent.id, expectedRevision: revision.current!, ...settings },
          });
          revision.current = revision.current! + 1;
          if (JSON.stringify(formApi.state.values) === JSON.stringify(value))
            formApi.reset(value, { keepDefaultValues: true });
          await onSaved(agent.id);
          markSaved();
        } else {
          const id = await createAgent({ data: settings });
          await onSaved(id);
        }
      } catch (error) {
        toastError("Could not save the agent.", error);
      }
    },
  });
  const externalChange = useStore(
    form.store,
    (state) => state.isDirty && !!agent && agent.configRevision !== revision.current,
  );
  const dirty = useStore(form.store, (state) => state.isDirty);
  const { justSaved, markSaved } = useSaveStatus();
  const submitting = useStore(form.store, (state) => state.isSubmitting);
  // A save resets the form on success, so `dirty` is also "not yet saved".
  useBlocker({
    shouldBlockFn: async () =>
      dirty &&
      !submitting &&
      !(await confirm({
        title: "Discard unsaved changes?",
        description: "Your agent has not been saved.",
        confirmLabel: "Discard changes",
      })),
    enableBeforeUnload: dirty,
  });
  useEffect(() => {
    if (!agent || agent.configRevision === revision.current || form.state.isDirty) return;
    revision.current = agent.configRevision;
    form.reset(agentDetailToSettings(agent), { keepDefaultValues: true });
  }, [agent, form]);
  const remove = useMutation({ mutationFn: async () => onDelete?.() });

  return (
    <Page
      title={agent ? agent.name : "New agent"}
      backTo="/agents"
      backLabel="Agents"
      actions={
        <>
          <SaveStatus justSaved={justSaved} />
          {agent ? (
            <>
              <Link
                to="/"
                search={{ agent: agent.id }}
                className={buttonVariants({ size: "sm", variant: "outline" })}
              >
                Start chat
              </Link>
              <Button size="sm" variant="outline" onClick={() => setSharing(true)}>
                <HugeiconsIcon icon={UserGroupIcon} strokeWidth={2} data-icon="inline-start" />
                Access
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<Button size="icon-sm" variant="ghost" aria-label="Agent actions" />}
                >
                  <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <AgentAuthoringLaunchMenuItem agentId={agent.id} />
                  <DropdownMenuSeparator />
                  {/* A menu item closes on activation, so it cannot carry a
                    spinner; disabling it is the pending signal. */}
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate()}
                  >
                    <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                    Delete agent
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : (
            <AgentAuthoringLaunchButton />
          )}
          <form.AppForm>
            <form.SubmitButton size="sm" form={formId} disabled={!!agent && !dirty}>
              <SaveLabel justSaved={justSaved}>{agent ? "Save changes" : "Create agent"}</SaveLabel>
            </form.SubmitButton>
          </form.AppForm>
        </>
      }
    >
      <form
        id={formId}
        ref={formElement}
        className="flex flex-col gap-8"
        onSubmit={(event) => {
          event.preventDefault();
          if (!form.state.isSubmitting)
            void form.handleSubmit().then(() => {
              if (form.state.isValid) {
                setInvalidSubmit(false);
                return;
              }
              setInvalidSubmit(true);
              requestAnimationFrame(() => {
                formElement.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
              });
            });
        }}
      >
        {externalChange && agent ? (
          <div className="space-y-2">
            <FieldError>
              This agent changed elsewhere. Your edits are kept. Reloading replaces them with the
              current agent.
            </FieldError>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                revision.current = agent.configRevision;
                form.reset(agentDetailToSettings(agent), { keepDefaultValues: true });
              }}
            >
              Reload agent
            </Button>
          </div>
        ) : null}
        <AgentSettingsFields form={form} />
        {invalidSubmit ? (
          <FieldError>Check the highlighted fields before saving.</FieldError>
        ) : null}
      </form>
      {agent ? (
        <AccessDialog
          resource={{ kind: "agent", id: agent.id }}
          title={agent.name}
          open={sharing}
          onOpenChange={setSharing}
        />
      ) : null}
    </Page>
  );
}
