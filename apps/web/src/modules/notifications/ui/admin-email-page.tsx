import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { toast } from "sonner";
import { useConfirm } from "~/ui/confirm-context.ts";
import { toastError } from "~/ui/error-toast.ts";
import { FormActions, Page, Section } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";
import { smtpSettingsQuery } from "../client/queries.ts";
import { clearSmtpSettings, saveSmtpSettings, sendTestEmail } from "../server/functions.ts";
import { m } from "~/paraglide/messages.js";

type Security = "tls" | "starttls" | "none";
const securities = () =>
  [
    { value: "starttls", label: "STARTTLS", port: 587 },
    { value: "tls", label: "TLS", port: 465 },
    { value: "none", label: m.notifications_email_security_none(), port: 25 },
  ] as const satisfies ReadonlyArray<{ value: Security; label: string; port: number }>;

/** The server notification email goes out through. Without it, nobody gets email. */
export function AdminEmailPage() {
  const id = useId();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { data: saved } = useSuspenseQuery(smtpSettingsQuery);
  const SECURITY = securities();
  const [draft, setDraft] = useState({
    host: saved?.host ?? "",
    port: String(saved?.port ?? 587),
    security: saved?.security ?? ("starttls" as Security),
    username: saved?.username ?? "",
    password: "",
    fromAddress: saved?.fromAddress ?? "",
  });
  const patch = (changes: Partial<typeof draft>) => setDraft({ ...draft, ...changes });
  const refresh = () => queryClient.invalidateQueries({ queryKey: smtpSettingsQuery.queryKey });
  const save = useMutation({
    mutationFn: () =>
      saveSmtpSettings({
        data: {
          host: draft.host.trim(),
          port: Number(draft.port),
          security: draft.security,
          username: draft.username.trim() || null,
          // Empty keeps the stored password, unless signing in is turned off.
          ...(draft.password
            ? { password: draft.password }
            : draft.username.trim()
              ? {}
              : { password: null }),
          fromAddress: draft.fromAddress.trim(),
        },
      }),
    onSuccess: () => {
      patch({ password: "" });
      toast.success(m.notifications_email_saved());
    },
    onError: (error) => toastError(m.notifications_email_error_save(), error),
    onSettled: refresh,
  });
  const test = useMutation({
    mutationFn: () => sendTestEmail(),
    onSuccess: () => toast.success(m.notifications_email_test_sent()),
    onError: (error) => toastError(m.notifications_email_error_test(), error),
  });
  const clear = useMutation({
    mutationFn: () => clearSmtpSettings(),
    onError: (error) => toastError(m.notifications_email_error_remove(), error),
    onSettled: refresh,
  });
  const port = Number(draft.port);
  const complete =
    draft.host.trim() !== "" &&
    Number.isInteger(port) &&
    port > 0 &&
    port < 65536 &&
    draft.fromAddress.includes("@");
  const busy = save.isPending || test.isPending || clear.isPending;

  return (
    <Page title={m.notifications_email_title()} description={m.notifications_email_description()}>
      <Section title={m.notifications_email_smtp()}>
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (complete) save.mutate();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${id}-host`}>{m.notifications_email_host()}</FieldLabel>
              <Input
                id={`${id}-host`}
                value={draft.host}
                onChange={(event) => patch({ host: event.target.value })}
                // oxlint-disable-next-line i18n/no-literal-text -- an example host, not words
                placeholder="smtp.example.com"
                autoComplete="off"
                disabled={busy}
              />
            </Field>
            <div className="grid gap-6 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor={`${id}-security`}>
                  {m.notifications_email_encryption()}
                </FieldLabel>
                <Select
                  items={SECURITY}
                  value={draft.security}
                  onValueChange={(security: Security | null) => {
                    const choice = SECURITY.find((each) => each.value === security);
                    if (choice) patch({ security: choice.value, port: String(choice.port) });
                  }}
                  disabled={busy}
                >
                  <SelectTrigger id={`${id}-security`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SECURITY.map((choice) => (
                      <SelectItem key={choice.value} value={choice.value}>
                        {choice.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-port`}>{m.notifications_email_port()}</FieldLabel>
                <Input
                  id={`${id}-port`}
                  inputMode="numeric"
                  value={draft.port}
                  onChange={(event) => patch({ port: event.target.value })}
                  disabled={busy}
                />
              </Field>
            </div>
            <div className="grid gap-6 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor={`${id}-username`}>
                  {m.notifications_email_username()}
                </FieldLabel>
                <Input
                  id={`${id}-username`}
                  value={draft.username}
                  onChange={(event) => patch({ username: event.target.value })}
                  autoComplete="off"
                  disabled={busy}
                />
                <FieldDescription>{m.notifications_email_username_hint()}</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-password`}>
                  {m.notifications_email_password()}
                </FieldLabel>
                <Input
                  id={`${id}-password`}
                  type="password"
                  autoComplete="off"
                  placeholder={
                    saved?.passwordSet ? m.notifications_email_password_unchanged() : undefined
                  }
                  value={draft.password}
                  onChange={(event) => patch({ password: event.target.value })}
                  disabled={busy || !draft.username.trim()}
                />
                {saved?.passwordSet ? (
                  <FieldDescription>{m.notifications_email_password_hint()}</FieldDescription>
                ) : null}
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor={`${id}-from`}>{m.notifications_email_from()}</FieldLabel>
              <Input
                id={`${id}-from`}
                value={draft.fromAddress}
                onChange={(event) => patch({ fromAddress: event.target.value })}
                // oxlint-disable-next-line i18n/no-literal-text -- an example address, not words
                placeholder="neema <neema@example.com>"
                disabled={busy}
              />
            </Field>
          </FieldGroup>
          <FormActions>
            <PendingButton type="submit" pending={save.isPending} disabled={!complete || busy}>
              {m.common_save()}
            </PendingButton>
            {saved ? (
              <>
                <PendingButton
                  type="button"
                  variant="outline"
                  pending={test.isPending}
                  disabled={busy}
                  onClick={() => test.mutate()}
                >
                  {m.notifications_email_send_test()}
                </PendingButton>
                <PendingButton
                  type="button"
                  variant="ghost"
                  pending={clear.isPending}
                  disabled={busy}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: m.notifications_email_confirm_remove_title(),
                        description: m.notifications_email_confirm_remove_description(),
                        confirmLabel: m.notifications_email_remove(),
                      })
                    )
                      clear.mutate();
                  }}
                >
                  {m.notifications_email_remove()}
                </PendingButton>
              </>
            ) : null}
          </FormActions>
        </form>
      </Section>
    </Page>
  );
}
