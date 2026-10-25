import { accountName } from "~/modules/integrations/schema.ts";
import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { toast } from "sonner";
import { ImageModelSettingRow } from "~/modules/images/ui/image-model-select.tsx";
import { PreferredModelRow } from "~/modules/chat/ui/preferred-model-row.tsx";
import { KNOWLEDGE_LIMITS } from "~/modules/knowledge/schema.ts";
import { CollectionsField } from "~/modules/knowledge/ui/collections-field.tsx";
import { CollectionDialog } from "~/modules/knowledge/ui/knowledge-page.tsx";
import { myIntegrationsQuery } from "~/modules/integrations/client/queries.ts";
import { IntegrationLogo } from "~/modules/integrations/ui/integration-logo.tsx";
import { ToggleGroup, ToggleGroupItem } from "~/ui/primitives/toggle-group";
import { SkillsField } from "~/modules/skills/ui/skills-field.tsx";
import { EMPTY_SCHEDULE_DRAFT } from "../draft-schema.ts";
import { ScheduleAllowanceFields } from "./schedule-allowance-fields.tsx";
import { ScheduleChatField } from "./schedule-chat-field.tsx";
import { ScheduleNotifyField } from "./schedule-notify-field.tsx";
import { ScheduleTimingFields } from "./schedule-timing-fields.tsx";
import { withForm } from "~/ui/form/app-form.ts";
import { ListCard, ListRow, Section } from "~/ui/page-shell.tsx";
import { Button } from "~/ui/primitives/button";
import { Switch } from "~/ui/primitives/switch";
import { m } from "~/paraglide/messages.js";

/** The detail page and the chat draft panel share these; each host owns persistence. */
export const ScheduleSettingsFields = withForm({
  defaultValues: EMPTY_SCHEDULE_DRAFT,
  render: function ScheduleSettingsFields({ form }) {
    const integrations = useQuery(myIntegrationsQuery);
    const [creatingCollection, setCreatingCollection] = useState(false);
    return (
      <>
        <div className="flex flex-col gap-5">
          <form.AppField name="name">
            {(field) => (
              <field.TextField
                label={m.common_name()}
                placeholder={m.schedules_settings_name_placeholder()}
              />
            )}
          </form.AppField>
        </div>
        <ScheduleTimingFields form={form} />
        <ScheduleChatField form={form} />
        <ScheduleNotifyField form={form} />
        <div>
          <form.AppField name="prompt">
            {(field) => (
              <field.TextareaField
                label={m.schedules_settings_prompt()}
                placeholder={m.schedules_settings_prompt_placeholder()}
                rows={6}
              />
            )}
          </form.AppField>
        </div>
        <Section title={m.schedules_settings_model_and_tools()}>
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
                  description={m.schedules_settings_image_model_description()}
                />
              )}
            </form.Field>
            <ListRow>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium">{m.schedules_settings_web_search()}</span>
              </div>
              <form.Field name="searchEnabled">
                {(field) => (
                  <Switch
                    checked={field.state.value}
                    onCheckedChange={(checked) => field.handleChange(checked)}
                    aria-label={m.schedules_settings_web_search()}
                  />
                )}
              </form.Field>
            </ListRow>
            <ListRow>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium">{m.schedules_settings_deep_research()}</span>
              </div>
              <form.Field name="researchEnabled">
                {(field) => (
                  <Switch
                    checked={field.state.value}
                    onCheckedChange={(checked) => field.handleChange(checked)}
                    aria-label={m.schedules_settings_deep_research()}
                  />
                )}
              </form.Field>
            </ListRow>
          </ListCard>
        </Section>
        <Section
          title={m.schedules_settings_knowledge()}
          description={m.schedules_settings_access_at_fire_time()}
        >
          <form.Field name="collectionIds">
            {(field) => (
              <CollectionsField
                value={field.state.value}
                onChange={field.handleChange}
                errors={field.state.meta.errors}
              >
                <div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      if (field.state.value.length < KNOWLEDGE_LIMITS.maxCollectionsPerSelection)
                        setCreatingCollection(true);
                      else toast.error(m.schedules_settings_too_many_collections());
                    }}
                  >
                    <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
                    {m.schedules_settings_new_collection()}
                  </Button>
                </div>
              </CollectionsField>
            )}
          </form.Field>
        </Section>
        <Section
          title={m.schedules_settings_integrations()}
          description={m.schedules_settings_integrations_description()}
        >
          <form.Field name="integrationGrants">
            {(field) => {
              const grants = field.state.value ?? [];
              // One row per account a run could act as, plus any granted one since lost.
              const rows = (integrations.data ?? []).flatMap((integration) => {
                const several = integration.connections.length > 1;
                return integration.connections
                  .filter(
                    (account) =>
                      account.status === "active" ||
                      grants.some((grant) => grant.connectionId === account.id),
                  )
                  .map((account) => ({
                    integration,
                    connectionId: account.id,
                    title: several
                      ? `${integration.name} · ${accountName(account)}`
                      : integration.name,
                    detail:
                      account.status === "active"
                        ? account.accountLabel
                        : account.status === "unavailable"
                          ? m.schedules_settings_integration_turned_off()
                          : m.schedules_settings_integration_not_connected(),
                  }));
              });
              // Keyed by place in the saved list, which is all that tells two lost grants apart.
              const lost = grants.flatMap((grant, place) =>
                grant.connectionId === null ? [{ grant, key: `lost-${place}` }] : [],
              );
              if (rows.length === 0 && lost.length === 0)
                return (
                  <p className="text-muted-foreground text-sm">
                    {m.schedules_settings_integrations_empty()}
                  </p>
                );
              return (
                <ListCard>
                  {rows.map(({ integration, connectionId, title, detail }) => {
                    const grant = grants.find((entry) => entry.connectionId === connectionId);
                    const value = grant?.access ?? "none";
                    const rest = grants.filter((entry) => entry.connectionId !== connectionId);
                    return (
                      <Fragment key={connectionId}>
                        <ListRow>
                          <IntegrationLogo integrationId={integration.id} variant="tile" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{title}</p>
                            <p className="text-muted-foreground truncate text-xs">{detail}</p>
                          </div>
                          <ToggleGroup
                            value={[value]}
                            onValueChange={(values) => {
                              const next = values.at(-1);
                              if (next === "read" || next === "write")
                                field.handleChange([
                                  ...rest,
                                  { connectionId, integrationId: integration.id, access: next },
                                ]);
                              else if (next === "none") field.handleChange(rest);
                            }}
                            variant="outline"
                            size="sm"
                            spacing={0}
                            aria-label={m.schedules_settings_integration_access({ name: title })}
                          >
                            <ToggleGroupItem value="none">
                              {m.schedules_settings_access_off()}
                            </ToggleGroupItem>
                            <ToggleGroupItem value="read">
                              {m.schedules_settings_access_read()}
                            </ToggleGroupItem>
                            <ToggleGroupItem value="write">
                              {m.schedules_settings_access_write()}
                            </ToggleGroupItem>
                          </ToggleGroup>
                        </ListRow>
                        {grant?.connectionId ? (
                          <ScheduleAllowanceFields
                            kind={integration.kind}
                            grant={{
                              ...grant,
                              connectionId: grant.connectionId,
                              integrationId: integration.id,
                            }}
                            onChange={(next) => field.handleChange([...rest, next])}
                          />
                        ) : null}
                      </Fragment>
                    );
                  })}
                  {lost.map(({ grant, key }) => {
                    const integration = integrations.data?.find(
                      (entry) => entry.id === grant.integrationId,
                    );
                    const deleted = grant.integrationId === null;
                    const title = deleted
                      ? m.schedules_settings_integration_deleted()
                      : (integration?.name ?? m.schedules_settings_integration_unknown());
                    return (
                      <ListRow key={key}>
                        {integration ? (
                          <IntegrationLogo integrationId={integration.id} variant="tile" />
                        ) : null}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{title}</p>
                          <p className="text-muted-foreground truncate text-xs">
                            {deleted
                              ? m.schedules_settings_integration_deleted_hint()
                              : m.schedules_settings_integration_disconnected_hint()}
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          aria-label={m.schedules_settings_turn_off_named({ name: title })}
                          onClick={() =>
                            field.handleChange(grants.filter((entry) => entry !== grant))
                          }
                        >
                          {m.schedules_settings_turn_off()}
                        </Button>
                      </ListRow>
                    );
                  })}
                </ListCard>
              );
            }}
          </form.Field>
        </Section>
        <Section
          title={m.schedules_settings_skills()}
          description={m.schedules_settings_access_at_fire_time()}
        >
          <form.Field name="skillIds">
            {(field) => (
              <SkillsField
                value={field.state.value ?? []}
                onChange={field.handleChange}
                errors={field.state.meta.errors}
                unavailableHint={m.schedules_settings_skill_unavailable_hint()}
              />
            )}
          </form.Field>
        </Section>
        {creatingCollection ? (
          <CollectionDialog
            open
            onOpenChange={setCreatingCollection}
            onCreated={(collectionId) => {
              const current = form.getFieldValue("collectionIds");
              if (current.length < KNOWLEDGE_LIMITS.maxCollectionsPerSelection)
                form.setFieldValue("collectionIds", [...current, collectionId]);
            }}
          />
        ) : null}
      </>
    );
  },
});
