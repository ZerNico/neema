import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { ModelSelect } from "~/modules/providers/ui/model-select.tsx";
import { OptionalMark } from "~/ui/form/form-fields.tsx";
import {
  getScanReading,
  retryOcrModelDownload,
  testMistralOcr,
  updateScanReading,
} from "~/modules/tools/server/functions.ts";
import { useConfirm } from "~/ui/confirm-context.ts";
import { toastError } from "~/ui/error-toast.ts";
import { FormActions, ListRow } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Field, FieldDescription, FieldError, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";
import { SaveLabel } from "~/ui/save-status.tsx";
import { useSaveStatus } from "~/ui/use-save-status.ts";
import { cn } from "~/ui/utils";
import { scanReadingQuery } from "../../tools/client/queries.ts";

type Mode = "off" | "local" | "mistral" | "model";
type Quality = "accurate" | "fast";
type Settings = NonNullable<Awaited<ReturnType<typeof getScanReading>>>;
type FileStatus = Settings["localFiles"][Quality];

const MODES: ReadonlyArray<{ value: Mode; label: string; detail: string }> = [
  {
    value: "off",
    label: "None",
    detail: "Pages without a text layer are skipped.",
  },
  {
    value: "local",
    label: "Local (PP-OCRv6)",
    detail: "Runs on this server. Pages never leave it.",
  },
  {
    value: "mistral",
    label: "Mistral OCR",
    detail: "Sends scanned pages to Mistral.",
  },
  {
    value: "model",
    label: "Vision LLM",
    detail: "Sends each scanned page to a model as an image.",
  },
];
const QUALITIES: ReadonlyArray<{ value: Quality; label: string; detail: string }> = [
  { value: "accurate", label: "Accurate (small, 31 MB)", detail: "About a second a page" },
  {
    value: "fast",
    label: "Fast (tiny, 6 MB)",
    detail: "Three times faster, misses more on poor scans",
  },
];
/** The UI's copy of the server default; the server normalises whatever is saved. */
const DEFAULT_BASE_URL = "https://api.mistral.ai/v1";

const megabytes = (bytes: number) => Math.round(bytes / 1_000_000);

function fileStatusText(status: FileStatus) {
  switch (status.state) {
    case "ready":
      return "Ready.";
    case "missing":
      return "Not downloaded yet. Saving starts the download.";
    case "downloading":
      return `Downloading… ${megabytes(status.done)} of ${megabytes(status.total)} MB`;
    case "failed":
      return `Download failed: ${status.error}`;
    case "unsupported":
      return "This server’s platform can’t run local OCR. Choose another provider.";
  }
}

/** Where pages go, in the words a confirmation uses. */
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
const destination = (mode: Mode, baseUrl: string, modelName: string | null) =>
  mode === "mistral" ? hostOf(baseUrl) : (modelName ?? "the model");

/**
 * The scanned-pages choice inside Document parsing: not read, read here, or
 * sent to Mistral or a vision model, with each option's own settings beneath.
 */
export function ScanReadingRow({ disabled }: { disabled: boolean }) {
  const { data } = useSuspenseQuery(scanReadingQuery);
  if (!data) return null;
  return <ScanReadingForm settings={data} disabled={disabled} />;
}

function ScanReadingForm({ settings, disabled }: { settings: Settings; disabled: boolean }) {
  const id = useId();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const saved = settings.scans;
  const [mode, setMode] = useState<Mode>(saved.mode);
  const [quality, setQuality] = useState<Quality>(
    saved.mode === "local" ? saved.quality : "accurate",
  );
  // Blank means Mistral's own endpoint, as on a provider; only a different one is shown.
  const [baseUrl, setBaseUrl] = useState(
    saved.mode === "mistral" && saved.baseUrl !== DEFAULT_BASE_URL ? saved.baseUrl : "",
  );
  const effectiveBaseUrl = baseUrl.trim() || DEFAULT_BASE_URL;
  const [modelId, setModelId] = useState<string | null>(
    saved.mode === "model" ? saved.modelId : null,
  );
  const [secret, setSecret] = useState("");
  const [test, setTest] = useState<
    { ok: true; latencyMs: number } | { ok: false; error: string } | null
  >(null);
  const { justSaved, markSaved } = useSaveStatus();

  const changed =
    mode !== saved.mode ||
    (mode === "local" && saved.mode === "local" && quality !== saved.quality) ||
    (mode === "mistral" && saved.mode === "mistral" && effectiveBaseUrl !== saved.baseUrl) ||
    (mode === "model" && saved.mode === "model" && modelId !== saved.modelId) ||
    secret.trim() !== "" ||
    (mode === "model" && settings.needsApproval);
  const complete =
    mode !== "model"
      ? mode !== "mistral" || settings.keyConfigured || secret.trim() !== ""
      : modelId !== null;

  const refresh = () => queryClient.invalidateQueries({ queryKey: scanReadingQuery.queryKey });
  const save = useMutation({
    mutationFn: () =>
      updateScanReading({
        data: {
          scans:
            mode === "off"
              ? { mode }
              : mode === "local"
                ? { mode, quality }
                : mode === "mistral"
                  ? { mode, ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}) }
                  : { mode, modelId: modelId! },
          ...(secret.trim() ? { secret: secret.trim() } : {}),
        },
      }),
    onSuccess: async () => {
      setSecret("");
      markSaved();
      await refresh();
    },
    onError: (error) => toastError("Could not save the OCR provider.", error),
  });
  const retry = useMutation({
    mutationFn: () =>
      retryOcrModelDownload({
        data: { quality: saved.mode === "local" ? saved.quality : quality },
      }),
    onSuccess: refresh,
    onError: (error) => toastError("Could not start the download.", error),
  });
  const runTest = useMutation({
    mutationFn: () =>
      testMistralOcr({
        data: {
          ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
          ...(secret.trim() ? { secret: secret.trim() } : {}),
        },
      }),
    onSuccess: setTest,
    onError: (error) => toastError("Could not test the OCR service.", error),
  });

  const submit = async () => {
    const outbound = mode === "mistral" || mode === "model";
    const sameTarget =
      (mode === "mistral" && saved.mode === "mistral" && saved.baseUrl === effectiveBaseUrl) ||
      (mode === "model" &&
        saved.mode === "model" &&
        saved.modelId === modelId &&
        !settings.needsApproval);
    if (outbound && !sameTarget) {
      const modelName =
        settings.visionModels.find((model) => model.id === modelId)?.displayName ?? null;
      const ok = await confirm({
        destructive: false,
        title: `Send scanned pages to ${destination(mode, effectiveBaseUrl, modelName)}?`,
        description:
          "Pages without a text layer are sent there to be read: from PDFs attached in chats, project files, documents in collections, files tools return and PDFs read from the web. Pages with text, and every other file, stay on this server.",
        confirmLabel: "Send pages",
      });
      if (!ok) return;
    }
    save.mutate();
  };

  const busy = disabled || save.isPending;
  const files = settings.localFiles[quality];
  const current = MODES.find((option) => option.value === mode)!;

  return (
    <ListRow className="flex-col items-stretch gap-3">
      <Field>
        <FieldLabel htmlFor={`${id}-mode`}>OCR provider</FieldLabel>
        <Select
          items={MODES.map(({ value, label }) => ({ value, label }))}
          value={mode}
          onValueChange={(next) => {
            if (!next) return;
            setMode(next as Mode);
            setTest(null);
          }}
          disabled={busy}
        >
          <SelectTrigger id={`${id}-mode`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODES.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>{current.detail}</FieldDescription>
      </Field>

      {mode === "local" ? (
        <Field>
          <FieldLabel htmlFor={`${id}-quality`}>Quality</FieldLabel>
          <Select
            items={QUALITIES.map(({ value, label }) => ({ value, label }))}
            value={quality}
            onValueChange={(next) => next && setQuality(next as Quality)}
            disabled={busy}
          >
            <SelectTrigger id={`${id}-quality`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {QUALITIES.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                  <span className="text-muted-foreground ml-2 text-xs">{option.detail}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-2">
            <p
              role="status"
              className={cn(
                "text-xs",
                files.state === "failed" || files.state === "unsupported"
                  ? "text-destructive"
                  : "text-muted-foreground",
              )}
            >
              {fileStatusText(files)}
            </p>
            {files.state === "failed" && saved.mode === "local" ? (
              <PendingButton
                size="xs"
                variant="outline"
                pending={retry.isPending}
                disabled={busy}
                onClick={() => retry.mutate()}
              >
                Retry
              </PendingButton>
            ) : null}
          </div>
        </Field>
      ) : null}

      {mode === "mistral" ? (
        <>
          <Field>
            <FieldLabel htmlFor={`${id}-base-url`}>
              Base URL <OptionalMark />
            </FieldLabel>
            <Input
              id={`${id}-base-url`}
              autoComplete="off"
              placeholder={DEFAULT_BASE_URL}
              value={baseUrl}
              onChange={(event) => {
                setBaseUrl(event.target.value);
                setTest(null);
              }}
              disabled={busy}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-key`}>API key</FieldLabel>
            <Input
              id={`${id}-key`}
              type="password"
              autoComplete="off"
              placeholder={settings.keyConfigured ? "Unchanged" : undefined}
              value={secret}
              onChange={(event) => {
                setSecret(event.target.value);
                setTest(null);
              }}
              disabled={busy}
            />
            <FieldDescription>
              {settings.keyConfigured ? "Leave empty to keep the stored one. " : ""}
              Get a key at{" "}
              <a href="https://console.mistral.ai/api-keys" target="_blank" rel="noreferrer">
                console.mistral.ai
              </a>
              .
            </FieldDescription>
          </Field>
          {test ? (
            <p
              role="status"
              className={cn("text-xs", test.ok ? "text-success" : "text-destructive")}
            >
              {test.ok
                ? `Works: read the sample page in ${test.latencyMs}ms.`
                : `Didn’t work: ${test.error}`}
            </p>
          ) : null}
        </>
      ) : null}

      {mode === "model" ? (
        <Field>
          <FieldLabel htmlFor={`${id}-model`}>Model</FieldLabel>
          <ModelSelect
            id={`${id}-model`}
            aria-label="Model that reads scanned pages"
            models={settings.visionModels}
            value={modelId}
            onChange={setModelId}
            disabled={busy}
            emptyPlaceholder="Add a public model that can see images first"
          />
          {settings.needsApproval && saved.mode === "model" ? (
            <FieldError>
              The model or its provider was edited, so no pages are sent to it. Save to approve it
              again.
            </FieldError>
          ) : null}
        </Field>
      ) : null}

      <FormActions>
        <PendingButton
          size="sm"
          pending={save.isPending}
          disabled={busy || !changed || !complete}
          onClick={() => void submit()}
        >
          <SaveLabel justSaved={justSaved}>Save</SaveLabel>
        </PendingButton>
        {mode === "mistral" ? (
          <PendingButton
            size="sm"
            variant="outline"
            pending={runTest.isPending}
            disabled={busy || (!settings.keyConfigured && !secret.trim())}
            onClick={() => {
              setTest(null);
              runTest.mutate();
            }}
          >
            Test
          </PendingButton>
        ) : null}
      </FormActions>
    </ListRow>
  );
}
