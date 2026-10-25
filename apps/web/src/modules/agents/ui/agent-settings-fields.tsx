import { Cancel01Icon, Delete02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { Schema } from "effect";
import { useState } from "react";
import { toast } from "sonner";
import { EMPTY_AGENT_DRAFT } from "../draft-schema.ts";
import { AGENT_LIMITS, AgentIcon } from "../schema.ts";
import { ImageModelSettingRow } from "~/modules/images/ui/image-model-select.tsx";
import { AGENT_ICONS } from "~/modules/chat/ui/agent-icons.ts";
import { PreferredModelRow } from "~/modules/chat/ui/preferred-model-row.tsx";
import { usableCustomToolsQuery } from "~/modules/custom-tools/client/queries.ts";
import { integrationLook } from "~/modules/integrations/client/directory.ts";
import { myIntegrationsQuery } from "~/modules/integrations/client/queries.ts";
import { IntegrationLogo } from "~/modules/integrations/ui/integration-logo.tsx";
import { ResourcePicker } from "~/ui/resource-picker.tsx";
import { KNOWLEDGE_LIMITS } from "~/modules/knowledge/schema.ts";
import { CollectionsField } from "~/modules/knowledge/ui/collections-field.tsx";
import { CollectionDialog } from "~/modules/knowledge/ui/knowledge-page.tsx";
import { SkillsField } from "~/modules/skills/ui/skills-field.tsx";
import { withForm } from "~/ui/form/app-form.ts";
import { ErrorState, ListCard, ListRow, Section } from "~/ui/page-shell.tsx";
import { Button } from "~/ui/primitives/button";
import { Field, FieldError, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { Switch } from "~/ui/primitives/switch";
import { ToggleGroup, ToggleGroupItem } from "~/ui/primitives/toggle-group";

/** The page and the draft rail use the same fields; each host owns its form and persistence. */
export const AgentSettingsFields = withForm({
  defaultValues: EMPTY_AGENT_DRAFT,
  render: function AgentSettingsFields({ form }) {
    const integrations = useQuery(myIntegrationsQuery);
    const customTools = useQuery(usableCustomToolsQuery);
    const [customToolPickerOpen, setCustomToolPickerOpen] = useState(false);
    const [customToolAnchor, setCustomToolAnchor] = useState<HTMLButtonElement | null>(null);
    const [creatingCollection, setCreatingCollection] = useState(false);
    return (
      <>
        <div className="flex flex-col gap-5">
          <form.AppField name="name">
            {(field) => <field.TextField label="Name" placeholder="Contract reviewer" />}
          </form.AppField>
          <form.AppField name="description">
            {(field) => (
              <field.TextField
                label="Description"
                optional
                placeholder="What this agent is for, in one line."
              />
            )}
          </form.AppField>
        </div>
        <div>
          <form.AppField name="instructions">
            {(field) => (
              <field.TextareaField
                label="Instructions"
                placeholder="What should this agent do?"
                rows={8}
              />
            )}
          </form.AppField>
        </div>
        <Section
          title="Knowledge"
          description="People using this agent need their own access to these."
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
              New collection
            </Button>
          }
        >
          <form.Field name="collectionIds">
            {(field) => (
              <CollectionsField
                value={field.state.value}
                onChange={field.handleChange}
                errors={field.state.meta.errors}
                showOwner
              />
            )}
          </form.Field>
        </Section>
        <Section
          title="Skills"
          description="People using this agent need their own access to these."
        >
          <form.Field name="skillIds">
            {(field) => (
              <SkillsField
                value={field.state.value ?? []}
                onChange={field.handleChange}
                errors={field.state.meta.errors}
                unavailableHint="Remove this dependency or restore access before using the agent."
              />
            )}
          </form.Field>
        </Section>
        <Section
          title="Custom tools"
          description="Extra actions set up by an admin. A chat without an agent can use all of them; this agent uses only the ones picked here."
        >
          <form.Field name="customToolIds">
            {(field) => {
              const ids = field.state.value ?? [];
              return (
                <div className="space-y-3">
                  {ids.length > 0 ? (
                    <ListCard>
                      {ids.map((id) => {
                        const tool = customTools.data?.find((candidate) => candidate.id === id);
                        return (
                          <ListRow key={id}>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium">
                                {tool?.name ?? "Unavailable custom tool"}
                              </p>
                              <p className="text-muted-foreground truncate text-xs">
                                {tool?.description ??
                                  "Remove this dependency or ask an admin to re-enable it."}
                              </p>
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Remove ${tool?.name ?? "unavailable custom tool"}`}
                              onClick={() =>
                                field.handleChange(ids.filter((value) => value !== id))
                              }
                            >
                              <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
                            </Button>
                          </ListRow>
                        );
                      })}
                    </ListCard>
                  ) : null}
                  {customTools.isError ? (
                    <ErrorState
                      title="Could not load custom tools"
                      onRetry={() => void customTools.refetch()}
                    />
                  ) : (
                    <Button
                      ref={setCustomToolAnchor}
                      type="button"
                      variant="outline"
                      disabled={!customTools.data || customTools.data.length === 0}
                      onClick={() => setCustomToolPickerOpen(true)}
                    >
                      <HugeiconsIcon icon={PlusSignIcon} data-icon="inline-start" strokeWidth={2} />
                      Add custom tools
                    </Button>
                  )}
                  <ResourcePicker
                    items={customTools.data ?? []}
                    selectedIds={ids}
                    onChange={field.handleChange}
                    open={customToolPickerOpen}
                    onOpenChange={setCustomToolPickerOpen}
                    anchor={customToolAnchor}
                    limit={20}
                    placeholder="Search custom tools…"
                    empty="No matching custom tools."
                  />
                  <FieldError errors={field.state.meta.errors} />
                </div>
              );
            }}
          </form.Field>
        </Section>
        <Section
          title="Integrations"
          description="Services this agent uses by default. Each person uses their own connected account; someone who hasn’t connected one simply won’t have it."
        >
          <form.Field name="integrationIds">
            {(field) => {
              const ids = field.state.value ?? [];
              // What the author may attach now; saving refuses anything else.
              const usable = (integrations.data ?? []).filter((entry) => entry.available);
              const lost = ids.filter((id) => !usable.some((entry) => entry.id === id));
              if (usable.length === 0 && lost.length === 0)
                return (
                  <p className="text-muted-foreground text-sm">
                    No integrations are available to you yet.
                  </p>
                );
              return (
                <ListCard>
                  {usable.map((integration) => (
                    <ListRow key={integration.id}>
                      <IntegrationLogo integrationId={integration.id} variant="tile" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{integration.name}</p>
                        <p className="text-muted-foreground truncate text-xs">
                          {integrationLook(integration)?.description}
                        </p>
                      </div>
                      <Switch
                        checked={ids.includes(integration.id)}
                        aria-label={`Use ${integration.name}`}
                        onCheckedChange={(checked) =>
                          field.handleChange(
                            checked
                              ? [...ids, integration.id]
                              : ids.filter((id) => id !== integration.id),
                          )
                        }
                      />
                    </ListRow>
                  ))}
                  {lost.map((id) => (
                    <ListRow key={id}>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">Unavailable integration</p>
                        <p className="text-muted-foreground truncate text-xs">
                          Remove this dependency or ask an admin to share it with you.
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Remove unavailable integration"
                        onClick={() => field.handleChange(ids.filter((value) => value !== id))}
                      >
                        <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
                      </Button>
                    </ListRow>
                  ))}
                </ListCard>
              );
            }}
          </form.Field>
        </Section>
        <form.Field name="icon">
          {(field) => (
            <Field>
              <FieldLabel>Icon</FieldLabel>
              <ToggleGroup
                aria-invalid={field.state.meta.errors.length > 0 || undefined}
                value={[field.state.value]}
                onValueChange={(value) => {
                  const next = value.at(-1);
                  if (next && Schema.is(AgentIcon)(next)) field.handleChange(next);
                }}
                aria-label="Icon"
                className="w-full flex-wrap"
              >
                {(Object.keys(AGENT_ICONS) as Array<keyof typeof AGENT_ICONS>).map((icon) => (
                  <ToggleGroupItem key={icon} value={icon} aria-label={icon}>
                    <HugeiconsIcon icon={AGENT_ICONS[icon]} strokeWidth={2} />
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <FieldError errors={field.state.meta.errors} />
            </Field>
          )}
        </form.Field>
        <Section title="Model and tools">
          <ListCard>
            <form.Field name="modelId">
              {(field) => (
                <PreferredModelRow
                  value={field.state.value}
                  onChange={field.handleChange}
                  errors={field.state.meta.errors}
                />
              )}
            </form.Field>
            <form.Field name="imageModelId">
              {(field) => (
                <ImageModelSettingRow
                  value={field.state.value}
                  onChange={(modelId) => field.handleChange(modelId)}
                  description="A new chat draws with it."
                />
              )}
            </form.Field>
            <ListRow>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium">Web search by default</span>
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
                <span className="text-muted-foreground text-xs">For multi-step requests.</span>
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
          title="Conversation starters"
          description="Shown when someone starts a chat with this agent."
        >
          <form.Field name="starters">
            {(field) => (
              <div className="flex flex-col gap-2">
                {field.state.value.map((_, index) => (
                  // oxlint-disable-next-line react/no-array-index-key -- Starter fields are positional; keying by editable text would remount them on every keystroke.
                  <form.Field key={index} name={`starters[${index}]`}>
                    {(starterField) => (
                      <Field data-invalid={starterField.state.meta.errors.length > 0 || undefined}>
                        <div className="flex gap-2">
                          <Input
                            value={starterField.state.value}
                            onChange={(event) => starterField.handleChange(event.target.value)}
                            onBlur={starterField.handleBlur}
                            aria-invalid={starterField.state.meta.errors.length > 0 || undefined}
                            aria-label={`Starter ${index + 1}`}
                          />
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Remove starter ${index + 1}`}
                            onClick={() => field.removeValue(index)}
                          >
                            <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                          </Button>
                        </div>
                        <FieldError errors={starterField.state.meta.errors} />
                      </Field>
                    )}
                  </form.Field>
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
                <FieldError errors={field.state.meta.errors} />
              </div>
            )}
          </form.Field>
        </Section>
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
      </>
    );
  },
});
