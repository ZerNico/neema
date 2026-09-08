import {
  Delete02Icon,
  MoreHorizontalIcon,
  PlusSignIcon,
  Share01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import { useState } from "react";
import { toast } from "sonner";
import { agentQuery } from "../client/queries.ts";
import { AGENT_LIMITS, AgentIcon, AgentSettings, type AgentDetail } from "../schema.ts";
import { createAgent, deleteAgent, updateAgent } from "../server/functions.ts";
import { chatModelsQuery } from "~/modules/chat/client/queries.ts";
import { AGENT_ICONS } from "~/modules/chat/ui/context-picker.tsx";
import { ModelPicker } from "~/modules/chat/ui/model-picker.tsx";
import { knowledgeCollectionsQuery } from "~/modules/knowledge/client/queries.ts";
import { KNOWLEDGE_LIMITS } from "~/modules/knowledge/schema.ts";
import { CollectionDialog } from "~/modules/knowledge/ui/knowledge-page.tsx";
import { ShareDialog } from "~/modules/sharing/ui/share-dialog.tsx";
import { useConfirm } from "~/ui/confirm.tsx";
import { useAppForm } from "~/ui/form/app-form.tsx";
import { ErrorState, ListCard, ListRow, Page, Section } from "~/ui/page-shell.tsx";
import { Badge } from "~/ui/primitives/badge";
import { Button, buttonVariants } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { Field, FieldDescription, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { Switch } from "~/ui/primitives/switch";
import { ToggleGroup, ToggleGroupItem } from "~/ui/primitives/toggle-group";

const message = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

const empty: AgentSettings = {
  name: "",
  description: "",
  icon: "robot",
  instructions: "",
  modelId: null,
  searchEnabled: false,
  planEnabled: false,
  starters: [],
  collectionIds: [],
};

// Owner-only editor. Recipients start chats from the agent list instead.
export function AgentEditorPage({ agentId }: { agentId: string | null }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const detail = useQuery({ ...agentQuery(agentId ?? ""), enabled: agentId !== null });
  if (agentId !== null && detail.isError)
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
          title="This agent isn't yours to edit"
          description="You can start a chat with it from the Agents list."
        />
      </Page>
    );
  return (
    <AgentForm
      key={agent ? `${agent.id}:${agent.configRevision}` : "new"}
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
  const { data: models } = useSuspenseQuery(chatModelsQuery);
  const collections = useQuery(knowledgeCollectionsQuery);
  const [sharing, setSharing] = useState(false);
  const [creatingCollection, setCreatingCollection] = useState(false);
  const form = useAppForm({
    defaultValues: agent
      ? ({
          name: agent.name,
          description: agent.description,
          icon: agent.icon as AgentSettings["icon"],
          instructions: agent.instructions,
          modelId: agent.modelId,
          searchEnabled: agent.searchEnabled,
          planEnabled: agent.planEnabled,
          starters: [...agent.starters],
          collectionIds: agent.collections.map((collection) => collection.id),
        } satisfies AgentSettings)
      : empty,
    validators: { onSubmit: Schema.toStandardSchemaV1(AgentSettings) },
    onSubmit: async ({ value }) => {
      try {
        const settings: AgentSettings = {
          ...value,
          starters: value.starters.map((starter) => starter.trim()).filter(Boolean),
        };
        if (agent) {
          await updateAgent({
            data: { agentId: agent.id, expectedRevision: agent.configRevision, ...settings },
          });
          await onSaved(agent.id);
          toast.success("Agent saved. Changes apply to new chats.");
        } else {
          const id = await createAgent({ data: settings });
          await onSaved(id);
        }
      } catch (error) {
        toast.error(message(error, "Could not save the agent."));
      }
    },
  });
  const remove = useMutation({ mutationFn: async () => onDelete?.() });
  const selectedModel = (id: string | null) => models.find((model) => model.id === id) ?? null;

  return (
    <Page
      title={agent ? agent.name : "New agent"}
      backTo="/agents"
      backLabel="Agents"
      actions={
        agent ? (
          <>
            <Link
              to="/"
              search={{ agent: agent.id }}
              className={buttonVariants({ size: "sm", variant: "outline" })}
            >
              Start chat
            </Link>
            <Button size="sm" variant="outline" onClick={() => setSharing(true)}>
              <HugeiconsIcon icon={Share01Icon} strokeWidth={2} data-icon="inline-start" />
              Share
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button size="icon-sm" variant="ghost" aria-label="Agent actions" />}
              >
                <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
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
        ) : undefined
      }
    >
      <form
        className="flex flex-col gap-8"
        onSubmit={(event) => {
          event.preventDefault();
          if (!form.state.isSubmitting) void form.handleSubmit();
        }}
      >
        <Section title="Identity">
          <div className="flex flex-col gap-5">
            <form.AppField name="name">
              {(field) => <field.TextField label="Name" placeholder="Contract reviewer" />}
            </form.AppField>
            <form.AppField name="description">
              {(field) => (
                <field.TextField
                  label="Description"
                  placeholder="What this agent is for, in one line."
                />
              )}
            </form.AppField>
            <form.Field name="icon">
              {(field) => (
                <Field>
                  <FieldLabel>Icon</FieldLabel>
                  <ToggleGroup
                    value={[field.state.value]}
                    onValueChange={(value) => {
                      const next = value.at(-1);
                      if (next && Schema.is(AgentIcon)(next)) field.handleChange(next);
                    }}
                    aria-label="Icon"
                  >
                    {(Object.keys(AGENT_ICONS) as Array<keyof typeof AGENT_ICONS>).map((icon) => (
                      <ToggleGroupItem key={icon} value={icon} aria-label={icon}>
                        <HugeiconsIcon icon={AGENT_ICONS[icon]} strokeWidth={2} />
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </Field>
              )}
            </form.Field>
          </div>
        </Section>
        <Section title="Instructions">
          <form.AppField name="instructions">
            {(field) => (
              <field.TextareaField
                label="Instructions"
                description={`How the agent should answer. Up to ${AGENT_LIMITS.maxInstructions.toLocaleString()} characters. Application rules always apply above these.`}
                rows={8}
              />
            )}
          </form.AppField>
        </Section>
        <Section title="Model and tools">
          <ListCard>
            <ListRow>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium">Preferred model</span>
                <span className="text-muted-foreground text-xs">
                  A preference, not a rule: people without access to it pick their own.
                </span>
              </div>
              <form.Field name="modelId">
                {(field) => (
                  <div className="flex items-center gap-1">
                    <ModelPicker
                      models={models}
                      value={field.state.value}
                      onChange={(modelId) => field.handleChange(modelId)}
                      side="bottom"
                      align="end"
                      trigger={<Button size="sm" variant="outline" className="max-w-52" />}
                    >
                      <span className="truncate">
                        {selectedModel(field.state.value)?.displayName ??
                          (field.state.value ? "Unavailable model" : "Chooser's model")}
                      </span>
                    </ModelPicker>
                    {field.state.value ? (
                      <Button size="sm" variant="ghost" onClick={() => field.handleChange(null)}>
                        Clear
                      </Button>
                    ) : null}
                  </div>
                )}
              </form.Field>
            </ListRow>
            <ListRow>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium">Web search by default</span>
                <span className="text-muted-foreground text-xs">
                  Turns the composer's search on for new messages; it can still be switched off per
                  message.
                </span>
              </div>
              <form.Field name="searchEnabled">
                {(field) => (
                  <Switch
                    checked={field.state.value}
                    onCheckedChange={(checked) => field.handleChange(checked)}
                    aria-label="Web search by default"
                  />
                )}
              </form.Field>
            </ListRow>
            <ListRow>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium">Working checklist</span>
                <span className="text-muted-foreground text-xs">
                  Let the model keep a checklist for multi-step requests.
                </span>
              </div>
              <form.Field name="planEnabled">
                {(field) => (
                  <Switch
                    checked={field.state.value}
                    onCheckedChange={field.handleChange}
                    aria-label="Working checklist"
                  />
                )}
              </form.Field>
            </ListRow>
          </ListCard>
        </Section>
        <Section
          title="Knowledge"
          description="Collections the agent can search and read. Sharing the agent does not share these."
          actions={
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (
                  form.getFieldValue("collectionIds").length <
                  KNOWLEDGE_LIMITS.maxCollectionsPerSelection
                )
                  setCreatingCollection(true);
                else toast.error("Select at most five knowledge collections.");
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
              Create collection
            </Button>
          }
        >
          <form.Field name="collectionIds">
            {(field) => {
              const selected = new Set(field.state.value);
              const known = collections.data ?? [];
              const unavailable = field.state.value.filter((id) => !known.some((c) => c.id === id));
              return (
                <ListCard>
                  {known.length === 0 && unavailable.length === 0 ? (
                    <ListRow>
                      <span className="text-muted-foreground text-sm">
                        No collections yet.{" "}
                        <Link to="/knowledge" className="underline underline-offset-2">
                          Manage knowledge
                        </Link>
                      </span>
                    </ListRow>
                  ) : null}
                  {known.map((collection) => (
                    <ListRow key={collection.id}>
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm font-medium">{collection.name}</span>
                        <span className="text-muted-foreground truncate text-xs">
                          {collection.documentCount} documents
                          {collection.ownerName ? ` · shared by ${collection.ownerName}` : ""}
                        </span>
                      </div>
                      <Switch
                        checked={selected.has(collection.id)}
                        disabled={
                          !selected.has(collection.id) &&
                          selected.size >= KNOWLEDGE_LIMITS.maxCollectionsPerSelection
                        }
                        onCheckedChange={(checked) =>
                          field.handleChange(
                            checked
                              ? [...field.state.value, collection.id]
                              : field.state.value.filter((id) => id !== collection.id),
                          )
                        }
                        aria-label={`Attach ${collection.name}`}
                      />
                    </ListRow>
                  ))}
                  {unavailable.map((id) => (
                    <ListRow key={id}>
                      <span className="flex-1 text-sm">A collection you can no longer read</span>
                      <Badge variant="destructive">Unavailable</Badge>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          field.handleChange(field.state.value.filter((c) => c !== id))
                        }
                      >
                        Remove
                      </Button>
                    </ListRow>
                  ))}
                </ListCard>
              );
            }}
          </form.Field>
        </Section>
        <Section
          title="Conversation starters"
          description="Optional prompts shown when the agent is selected."
        >
          <form.Field name="starters">
            {(field) => (
              <div className="flex flex-col gap-2">
                {field.state.value.map((starter, index) => (
                  <div key={index} className="flex gap-2">
                    <Input
                      value={starter}
                      onChange={(event) =>
                        field.handleChange(
                          field.state.value.map((s, i) => (i === index ? event.target.value : s)),
                        )
                      }
                      maxLength={200}
                      aria-label={`Starter ${index + 1}`}
                    />
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Remove starter ${index + 1}`}
                      onClick={() =>
                        field.handleChange(field.state.value.filter((_, i) => i !== index))
                      }
                    >
                      <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                    </Button>
                  </div>
                ))}
                {field.state.value.length < AGENT_LIMITS.maxStarters ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-fit"
                    onClick={() => field.handleChange([...field.state.value, ""])}
                  >
                    <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
                    Add starter
                  </Button>
                ) : null}
                <FieldDescription>Up to {AGENT_LIMITS.maxStarters}.</FieldDescription>
              </div>
            )}
          </form.Field>
        </Section>
        <form.AppForm>
          <div className="flex gap-2">
            <form.SubmitButton>{agent ? "Save changes" : "Create agent"}</form.SubmitButton>
          </div>
        </form.AppForm>
      </form>
      {agent ? (
        <ShareDialog
          resource={{ kind: "agent", id: agent.id }}
          title={agent.name}
          open={sharing}
          onOpenChange={setSharing}
          href={`/?agent=${encodeURIComponent(agent.id)}`}
        />
      ) : null}
      <CollectionDialog
        open={creatingCollection}
        onOpenChange={setCreatingCollection}
        onCreated={(collectionId) => {
          if (
            form.getFieldValue("collectionIds").length >=
            KNOWLEDGE_LIMITS.maxCollectionsPerSelection
          )
            return;
          form.setFieldValue("collectionIds", [
            ...form.getFieldValue("collectionIds"),
            collectionId,
          ]);
        }}
      />
    </Page>
  );
}
