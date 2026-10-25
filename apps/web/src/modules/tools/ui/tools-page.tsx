import { NumberField } from "./tool-fields.tsx";
import { useInvalidateTools } from "../client/use-invalidate-tools.ts";
import { integerBetween } from "./integer-between.ts";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Schema } from "effect";
import { toast } from "sonner";
import { useAppForm } from "~/ui/form/app-form.ts";
import { FormActions, ListCard, ListRow, Page, Section } from "~/ui/page-shell.tsx";
import { SaveLabel, SaveStatus } from "~/ui/save-status.tsx";
import { useSaveStatus } from "~/ui/use-save-status.ts";
import { Switch } from "~/ui/primitives/switch";
import { RESEARCH_SEARCH_BUDGET, type WebSearchConfig } from "../schema.ts";
import { updateToolSettings } from "../server/functions.ts";
import { toastError } from "~/ui/error-toast.ts";
import { PresentationFontsRow } from "~/modules/presentations/ui/presentation-fonts.tsx";
import { SearchProviderRows } from "./search-providers.tsx";
import {
  memoryToolQuery,
  webSearchToolQuery,
  urlReaderToolQuery,
  officeFilesToolQuery,
  interactiveUiToolQuery,
  mapsToolQuery,
  imageGenerationToolQuery,
} from "../client/queries.ts";
import { readInteractiveUi, readMaps, type MapServices } from "~/modules/genui/settings.ts";

const WebSearchForm = Schema.Struct({
  maxResults: integerBetween(1, 20),
  researchMaxSearchQueries: integerBetween(RESEARCH_SEARCH_BUDGET.min, RESEARCH_SEARCH_BUDGET.max),
});

const UrlReaderForm = Schema.Struct({
  perPageCharCap: integerBetween(1000, 20000),
});

export function ToolsPage() {
  return (
    <Page
      title="Tools"
      description="Web tools, memory, Office files, interactive answers and maps available in chats."
    >
      <MemorySection />
      <WebSearchSection />
      <UrlReaderSection />
      <OfficeFilesSection />
      <ImageGenerationSection />
      <InteractiveUiSection />
      <MapsSection />
    </Page>
  );
}

function MemorySection() {
  const { data: tool } = useSuspenseQuery(memoryToolQuery);
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => updateToolSettings({ data: { tool: "memory", enabled } }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin", "tools"] }),
        queryClient.invalidateQueries({ queryKey: ["memory"] }),
      ]),
    onError: (error) => toastError("Could not update memory.", error),
  });

  return (
    <Section title="Memory">
      <ListCard>
        <ListRow>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">Assistant memory</span>
            <span className="text-muted-foreground text-xs">
              Let models use what they have saved about someone, and save more as they chat. People
              can still manage their own memories while this is off.
            </span>
          </div>
          <Switch
            checked={tool.enabled}
            onCheckedChange={(checked) => toggle.mutate(checked)}
            disabled={toggle.isPending}
            aria-label="Memory enabled"
          />
        </ListRow>
      </ListCard>
    </Section>
  );
}

function WebSearchSection() {
  const { data: tool } = useSuspenseQuery(webSearchToolQuery);
  const invalidate = useInvalidateTools();
  const config = tool.config as Partial<WebSearchConfig>;

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => updateToolSettings({ data: { tool: "web_search", enabled } }),
    onSuccess: invalidate,
    onError: (error) => toastError("Could not update web search.", error),
  });

  const { justSaved, markSaved } = useSaveStatus();
  const form = useAppForm({
    defaultValues: {
      maxResults: String(config.maxResults ?? 8),
      researchMaxSearchQueries: String(
        config.researchMaxSearchQueries ?? RESEARCH_SEARCH_BUDGET.default,
      ),
    },
    validators: { onSubmit: Schema.toStandardSchemaV1(WebSearchForm) },
    onSubmit: async ({ value }) => {
      try {
        await updateToolSettings({
          data: {
            tool: "web_search",
            maxResults: Number(value.maxResults),
            researchMaxSearchQueries: Number(value.researchMaxSearchQueries),
          },
        });
      } catch {
        toast.error("Could not save the web search settings.");
        return;
      }
      markSaved();
      form.reset(value);
      await invalidate();
    },
  });

  return (
    <Section title="Web search">
      <ListCard>
        <ListRow>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">Web search</span>
            <span className="text-muted-foreground text-xs">
              Returns titles and snippets from the providers below. Every chat model can use web
              search.
            </span>
          </div>
          <Switch
            checked={tool.enabled}
            onCheckedChange={(checked) => toggle.mutate(checked)}
            disabled={toggle.isPending}
            aria-label="Web search enabled"
          />
        </ListRow>

        <SearchProviderRows onChanged={invalidate} />

        <ListRow className="flex-col items-stretch gap-3">
          <form
            noValidate
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void form.handleSubmit();
            }}
          >
            <form.Field
              name="maxResults"
              validators={{ onSubmit: Schema.toStandardSchemaV1(integerBetween(1, 20)) }}
            >
              {(field) => (
                <NumberField
                  field={field}
                  label="Max results per query"
                  description="Some providers return at most ten per request."
                  min={1}
                  max={20}
                />
              )}
            </form.Field>
            <form.Field
              name="researchMaxSearchQueries"
              validators={{
                onSubmit: Schema.toStandardSchemaV1(WebSearchForm.fields.researchMaxSearchQueries),
              }}
            >
              {(field) => (
                <NumberField
                  field={field}
                  label="Search queries per research run"
                  description="A ceiling for the whole research run, not a goal it aims for. Takes effect on the next run started."
                  min={RESEARCH_SEARCH_BUDGET.min}
                  max={RESEARCH_SEARCH_BUDGET.max}
                  step={1}
                />
              )}
            </form.Field>
            <FormActions>
              <form.AppForm>
                <form.SubmitButton size="sm">
                  <SaveLabel justSaved={justSaved}>Save</SaveLabel>
                </form.SubmitButton>
              </form.AppForm>
              <SaveStatus justSaved={justSaved} />
            </FormActions>
          </form>
        </ListRow>
      </ListCard>
    </Section>
  );
}

// Lets the model fetch pages from user messages or search results.
// Fetches go out from this server with SSRF guarding (private addresses and
// redirects to them are refused); the page is extracted to markdown locally.
function UrlReaderSection() {
  const { data: tool } = useSuspenseQuery(urlReaderToolQuery);
  const invalidate = useInvalidateTools();

  const config = tool.config as { perPageCharCap?: number };

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => updateToolSettings({ data: { tool: "read_url", enabled } }),
    onSuccess: invalidate,
    onError: (error) => toastError("Could not update the URL reader.", error),
  });

  const { justSaved, markSaved } = useSaveStatus();
  const form = useAppForm({
    defaultValues: { perPageCharCap: String(config.perPageCharCap ?? 12000) },
    validators: { onSubmit: Schema.toStandardSchemaV1(UrlReaderForm) },
    onSubmit: async ({ value }) => {
      try {
        await updateToolSettings({
          data: { tool: "read_url", perPageCharCap: Number(value.perPageCharCap) },
        });
      } catch {
        toast.error("Could not save the URL reader settings.");
        return;
      }
      markSaved();
      form.reset({ perPageCharCap: value.perPageCharCap });
      await invalidate();
    },
  });

  return (
    <Section title="URL reader">
      <ListCard>
        <ListRow>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">Read linked pages</span>
            <span className="text-muted-foreground text-xs">
              Lets the model open links from your messages and search results and read what is on
              the page.
            </span>
          </div>
          <Switch
            checked={tool.enabled}
            onCheckedChange={(checked) => toggle.mutate(checked)}
            disabled={toggle.isPending}
            aria-label="URL reader enabled"
          />
        </ListRow>
        <ListRow className="flex-col items-stretch gap-3">
          <form
            noValidate
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void form.handleSubmit();
            }}
          >
            <div className="grid grid-cols-2 gap-3">
              <form.Field
                name="perPageCharCap"
                validators={{ onSubmit: Schema.toStandardSchemaV1(integerBetween(1000, 20000)) }}
              >
                {(field) => (
                  <NumberField
                    field={field}
                    label="Per-page character cap"
                    min={1000}
                    max={20000}
                    step={1000}
                  />
                )}
              </form.Field>
            </div>
            <FormActions>
              <form.AppForm>
                <form.SubmitButton size="sm">
                  <SaveLabel justSaved={justSaved}>Save</SaveLabel>
                </form.SubmitButton>
              </form.AppForm>
              <SaveStatus justSaved={justSaved} />
            </FormActions>
          </form>
        </ListRow>
      </ListCard>
    </Section>
  );
}

/**
 * Whether chats may create and edit Office files, and the fonts their previews
 * draw. Previews of existing files keep working when editing is off.
 */
function OfficeFilesSection() {
  const { data: tool } = useSuspenseQuery(officeFilesToolQuery);
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      updateToolSettings({ data: { tool: "office_files", enabled } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: officeFilesToolQuery.queryKey }),
    onError: (error) => toastError("Could not update Office files.", error),
  });

  return (
    <Section title="Office files">
      <ListCard>
        <ListRow>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">Create and edit Office files</span>
            <span className="text-muted-foreground text-xs">
              Lets the model make and change PowerPoint decks, Excel workbooks and Word documents,
              check its work and deliver the file.
            </span>
          </div>
          <Switch
            checked={tool.enabled}
            onCheckedChange={(checked) => toggle.mutate(checked)}
            disabled={toggle.isPending}
            aria-label="Office files enabled"
          />
        </ListRow>
        <PresentationFontsRow />
      </ListCard>
    </Section>
  );
}

/**
 * Whether chats are offered image generation. Nothing is offered until an
 * image model exists either; images already made stay in their answers.
 */
function ImageGenerationSection() {
  const { data: tool } = useSuspenseQuery(imageGenerationToolQuery);
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      updateToolSettings({ data: { tool: "image_generation", enabled } }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: imageGenerationToolQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: ["image-models"] }),
      ]),
    onError: (error) => toastError("Could not update image generation.", error),
  });

  return (
    <Section title="Image generation">
      <ListCard>
        <ListRow>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">Create and edit images</span>
            <span className="text-muted-foreground text-xs">
              Lets the model draw with the image model each person picks. Add image models under
              Providers.
            </span>
          </div>
          <Switch
            checked={tool.enabled}
            onCheckedChange={(checked) => toggle.mutate(checked)}
            disabled={toggle.isPending}
            aria-label="Image generation enabled"
          />
        </ListRow>
      </ListCard>
    </Section>
  );
}

/**
 * Whether answers may contain interactive blocks, and whether their image
 * tags are looked up. Blocks already in earlier answers keep rendering.
 */
function InteractiveUiSection() {
  const { data: tool } = useSuspenseQuery(interactiveUiToolQuery);
  const queryClient = useQueryClient();
  const update = useMutation({
    mutationFn: (patch: { enabled?: boolean; images?: boolean }) =>
      updateToolSettings({ data: { tool: "interactive_ui", ...patch } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: interactiveUiToolQuery.queryKey }),
    onError: (error) => toastError("Could not update interactive answers.", error),
  });

  const settings = readInteractiveUi(tool);
  return (
    <Section title="Interactive answers">
      <ListCard>
        <ListRow>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">Interactive answers</span>
            <span className="text-muted-foreground text-xs">
              Lets the model answer with calculators, charts, drawings and other controls the reader
              can use.
            </span>
          </div>
          <Switch
            checked={settings.enabled}
            onCheckedChange={(checked) => update.mutate({ enabled: checked })}
            disabled={update.isPending}
            aria-label="Interactive answers enabled"
          />
        </ListRow>
        <ListRow>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">Images</span>
            <span className="text-muted-foreground text-xs">
              Finds pictures for interactive answers with web search.
            </span>
          </div>
          <Switch
            checked={settings.images}
            onCheckedChange={(checked) => update.mutate({ images: checked })}
            disabled={update.isPending || !settings.enabled}
            aria-label="Images in interactive answers"
          />
        </ListRow>
      </ListCard>
    </Section>
  );
}

/**
 * Places and routes: the route tool in any chat, and the maps interactive
 * answers draw. Its own section, since it works without interactive answers.
 */
function MapsSection() {
  const { data: tool } = useSuspenseQuery(mapsToolQuery);
  const queryClient = useQueryClient();
  const update = useMutation({
    mutationFn: (enabled: boolean) => updateToolSettings({ data: { tool: "maps", enabled } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: mapsToolQuery.queryKey }),
    onError: (error) => toastError("Could not update maps.", error),
  });

  const settings = readMaps(tool);
  return (
    <Section title="Maps">
      <ListCard>
        <ListRow>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">Maps</span>
            <span className="text-muted-foreground text-xs">
              Looks up places and routes for answers, and draws them in interactive answers.
            </span>
          </div>
          <Switch
            checked={settings.enabled}
            onCheckedChange={(checked) => update.mutate(checked)}
            disabled={update.isPending}
            aria-label="Maps enabled"
          />
        </ListRow>
        {settings.enabled ? <MapServicesRow services={settings.services} /> : null}
      </ListCard>
    </Section>
  );
}

const MapServicesForm = Schema.Struct({
  styleLight: Schema.String.check(Schema.isPattern(/^https:\/\/\S+$/)),
  styleDark: Schema.String.check(Schema.isPattern(/^https:\/\/\S+$/)),
  geocoder: Schema.String.check(Schema.isPattern(/^https:\/\/\S+$/)),
  routing: Schema.String.check(Schema.isPattern(/^https:\/\/\S+$/)),
});

/** Where maps get their tiles, places and routes. The public OpenStreetMap services by default. */
function MapServicesRow({ services }: { services: MapServices }) {
  const queryClient = useQueryClient();
  const { justSaved, markSaved } = useSaveStatus();
  const defaults = { ...services };
  const form = useAppForm({
    defaultValues: defaults,
    validators: { onSubmit: Schema.toStandardSchemaV1(MapServicesForm) },
    onSubmit: async ({ value }) => {
      try {
        await updateToolSettings({ data: { tool: "maps", ...value } });
      } catch {
        toast.error("Could not save the map services.");
        return;
      }
      markSaved();
      form.reset(value);
      await queryClient.invalidateQueries({ queryKey: mapsToolQuery.queryKey });
    },
  });
  return (
    <ListRow className="flex-col items-stretch gap-3">
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void form.handleSubmit();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <form.AppField name="styleLight">
            {(field) => <field.TextField label="Light map style" type="url" />}
          </form.AppField>
          <form.AppField name="styleDark">
            {(field) => <field.TextField label="Dark map style" type="url" />}
          </form.AppField>
          <form.AppField name="geocoder">
            {(field) => <field.TextField label="Place search" type="url" />}
          </form.AppField>
          <form.AppField name="routing">
            {(field) => <field.TextField label="Routing" type="url" />}
          </form.AppField>
        </div>
        <FormActions>
          <form.AppForm>
            <form.SubmitButton size="sm">
              <SaveLabel justSaved={justSaved}>Save</SaveLabel>
            </form.SubmitButton>
          </form.AppForm>
          <SaveStatus justSaved={justSaved} />
        </FormActions>
      </form>
    </ListRow>
  );
}

// Local PDF text extraction, used when a model cannot take a PDF natively.
// Kept local on purpose, since the alternative would ship the user's document
// to a third-party parser.

// Semantic search for knowledge collections. Keyword search always works;
// this adds an embedding model. Two things are deliberately explicit here:
// enabling means document text is sent to that provider, and switching
// models asks whether existing vectors stay comparable. A name or matching
// dimension count alone never decides that.
