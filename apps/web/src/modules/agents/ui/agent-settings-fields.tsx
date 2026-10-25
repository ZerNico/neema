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
import { m } from "~/paraglide/messages.js";

const ICON_NAMES = {
  book: m.agents_icon_book,
  briefcase: m.agents_icon_briefcase,
  chart: m.agents_icon_chart,
  code: m.agents_icon_code,
  pen: m.agents_icon_pen,
  robot: m.agents_icon_robot,
  search: m.agents_icon_search,
  sparkles: m.agents_icon_sparkles,
} satisfies Record<keyof typeof AGENT_ICONS, () => string>;

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
            {(field) => (
              <field.TextField
                label={m.common_name()}
                placeholder={m.agents_settings_name_placeholder()}
              />
            )}
          </form.AppField>
          <form.AppField name="description">
            {(field) => (
              <field.TextField
                label={m.common_description()}
                optional
                placeholder={m.agents_settings_description_placeholder()}
              />
            )}
          </form.AppField>
        </div>
        <div>
          <form.AppField name="instructions">
            {(field) => (
              <field.TextareaField
                label={m.agents_settings_instructions()}
                placeholder={m.agents_settings_instructions_placeholder()}
                rows={8}
              />
            )}
          </form.AppField>
        </div>
        <Section
          title={m.agents_settings_knowledge()}
          description={m.agents_settings_own_access()}
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
                else toast.error(m.agents_settings_too_many_collections());
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
              {m.agents_settings_new_collection()}
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
        <Section title={m.agents_settings_skills()} description={m.agents_settings_own_access()}>
          <form.Field name="skillIds">
            {(field) => (
              <SkillsField
                value={field.state.value ?? []}
                onChange={field.handleChange}
                errors={field.state.meta.errors}
                unavailableHint={m.agents_settings_skill_unavailable_hint()}
              />
            )}
          </form.Field>
        </Section>
        <Section
          title={m.agents_settings_custom_tools()}
          description={m.agents_settings_custom_tools_description()}
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
                                {tool?.name ?? m.agents_settings_custom_tool_unavailable()}
                              </p>
                              <p className="text-muted-foreground truncate text-xs">
                                {tool?.description ??
                                  m.agents_settings_custom_tool_unavailable_hint()}
                              </p>
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={
                                tool
                                  ? m.agents_settings_remove_named({ name: tool.name })
                                  : m.agents_settings_remove_unavailable_custom_tool()
                              }
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
                      title={m.agents_settings_custom_tools_load_failed()}
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
                      {m.agents_settings_add_custom_tools()}
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
                    placeholder={m.agents_settings_custom_tools_search()}
                    empty={m.agents_settings_custom_tools_empty()}
                  />
                  <FieldError errors={field.state.meta.errors} />
                </div>
              );
            }}
          </form.Field>
        </Section>
        <Section
          title={m.agents_settings_integrations()}
          description={m.agents_settings_integrations_description()}
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
                    {m.agents_settings_integrations_empty()}
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
                        aria-label={m.agents_settings_use_integration({ name: integration.name })}
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
                        <p className="truncate text-sm font-medium">
                          {m.agents_settings_integration_unavailable()}
                        </p>
                        <p className="text-muted-foreground truncate text-xs">
                          {m.agents_settings_integration_unavailable_hint()}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={m.agents_settings_remove_unavailable_integration()}
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
              <FieldLabel>{m.agents_settings_icon()}</FieldLabel>
              <ToggleGroup
                aria-invalid={field.state.meta.errors.length > 0 || undefined}
                value={[field.state.value]}
                onValueChange={(value) => {
                  const next = value.at(-1);
                  if (next && Schema.is(AgentIcon)(next)) field.handleChange(next);
                }}
                aria-label={m.agents_settings_icon()}
                className="w-full flex-wrap"
              >
                {(Object.keys(AGENT_ICONS) as Array<keyof typeof AGENT_ICONS>).map((icon) => (
                  <ToggleGroupItem key={icon} value={icon} aria-label={ICON_NAMES[icon]()}>
                    <HugeiconsIcon icon={AGENT_ICONS[icon]} strokeWidth={2} />
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <FieldError errors={field.state.meta.errors} />
            </Field>
          )}
        </form.Field>
        <Section title={m.agents_settings_model_and_tools()}>
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
                  description={m.agents_settings_image_model_description()}
                />
              )}
            </form.Field>
            <ListRow>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium">
                  {m.agents_settings_web_search_default()}
                </span>
              </div>
              <form.Field name="searchEnabled">
                {(field) => (
                  <Switch
                    checked={field.state.value}
                    onCheckedChange={(checked) => field.handleChange(checked)}
                    aria-label={m.agents_settings_web_search_default()}
                  />
                )}
              </form.Field>
            </ListRow>
            <ListRow>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium">{m.agents_settings_checklist()}</span>
                <span className="text-muted-foreground text-xs">
                  {m.agents_settings_checklist_description()}
                </span>
              </div>
              <form.Field name="planEnabled">
                {(field) => (
                  <Switch
                    checked={field.state.value}
                    onCheckedChange={field.handleChange}
                    aria-label={m.agents_settings_checklist()}
                  />
                )}
              </form.Field>
            </ListRow>
          </ListCard>
        </Section>
        <Section
          title={m.agents_settings_starters()}
          description={m.agents_settings_starters_description()}
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
                            aria-label={m.agents_settings_starter({ number: index + 1 })}
                          />
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={m.agents_settings_remove_starter({ number: index + 1 })}
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
                    {m.agents_settings_add_starter()}
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
