import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Schema } from "effect";
import { useState } from "react";
import { toast } from "sonner";
import { authClient, meQuery } from "~/modules/auth/client.ts";
import { linkedAccountsQuery, signInOptionsQuery } from "~/modules/auth/queries.ts";
import { ConnectedAccounts } from "~/modules/auth/ui/connected-accounts.tsx";
import { useAppForm } from "~/ui/form/app-form.ts";
import { initials } from "~/ui/initials";
import { FormActions, ListCard, ListRow, Page, Section } from "~/ui/page-shell.tsx";
import { SaveLabel, SaveStatus } from "~/ui/save-status.tsx";
import { useSaveStatus } from "~/ui/use-save-status.ts";
import { Avatar, AvatarFallback } from "~/ui/primitives/avatar";
import { Badge } from "~/ui/primitives/badge";
import { PendingButton } from "~/ui/pending-button.tsx";
import { FieldError } from "~/ui/primitives/field";

const NameSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1, { message: "Enter a display name." })),
});

const PasswordSchema = Schema.Struct({
  currentPassword: Schema.String.check(
    Schema.isMinLength(1, { message: "Enter your current password." }),
  ),
  newPassword: Schema.String.check(
    Schema.isMinLength(8, { message: "New password must be at least 8 characters." }),
  ),
});

type PasswordStatus = { kind: "error"; message: string };

/** `linkError` is Better Auth's code when connecting a sign-in failed. */
export function ProfilePage({ linkError }: { linkError?: string | undefined }) {
  // The same session the app shell already resolved, not a second read of it:
  // `_app` cannot reach this route without it, and the name form patches this
  // cache on save, so reading anything else would show a stale display name.
  const { data: user } = useSuspenseQuery({ ...meQuery, select: (me) => me?.user ?? null });
  if (!user) return null;
  return <ProfileForms user={user} linkError={linkError} />;
}

function ProfileForms({
  user,
  linkError,
}: {
  user: { name: string; email: string; emailVerified: boolean; role?: string | null | undefined };
  linkError: string | undefined;
}) {
  const { data: options } = useSuspenseQuery(signInOptionsQuery);
  const { data: accounts } = useQuery(linkedAccountsQuery);
  // A provider that is its accounts' only sign-in leaves no password to change.
  const exclusive = accounts?.some(
    (a) => options.providers.find((p) => p.id === a.providerId)?.exclusive,
  );
  const queryClient = useQueryClient();
  const [passwordStatus, setPasswordStatus] = useState<PasswordStatus | null>(null);

  const { justSaved: nameJustSaved, markSaved: markNameSaved } = useSaveStatus();
  const { justSaved: passwordJustSaved, markSaved: markPasswordSaved } = useSaveStatus();
  const nameForm = useAppForm({
    defaultValues: { name: user.name },
    validators: { onSubmit: Schema.toStandardSchemaV1(NameSchema) },
    onSubmit: async ({ value }) => {
      const name = value.name.trim();
      const { error } = await authClient.updateUser({ name });
      if (error) {
        toast.error("Could not save the profile.");
        return;
      }
      // Confirm before the reset: resetting ends the submit, and in between the
      // button would show its idle label for a moment.
      markNameSaved();
      queryClient.setQueryData(meQuery.queryKey, (current) =>
        current ? { ...current, user: { ...current.user, name } } : current,
      );
      const currentName = nameForm.state.values.name;
      nameForm.reset({ name });
      if (currentName !== value.name) nameForm.setFieldValue("name", currentName);
      // The shell observes this cache, so the patch above updates it immediately;
      // refetch in the background to reconcile with the authoritative session.
      void queryClient.invalidateQueries({
        queryKey: meQuery.queryKey,
        exact: true,
      });
    },
  });

  const passwordForm = useAppForm({
    defaultValues: { currentPassword: "", newPassword: "" },
    validators: { onSubmit: Schema.toStandardSchemaV1(PasswordSchema) },
    onSubmit: async ({ value }) => {
      setPasswordStatus(null);
      const { error } = await authClient.changePassword({
        currentPassword: value.currentPassword,
        newPassword: value.newPassword,
        revokeOtherSessions: true,
      });
      if (error) {
        setPasswordStatus({
          kind: "error",
          message: error.message ?? "Could not update the password.",
        });
        return;
      }
      markPasswordSaved();
      passwordForm.reset();
    },
  });

  return (
    <Page title="Profile" rootPath="/settings" rootLabel="Settings">
      <Section title="Account">
        <ListCard>
          <ListRow>
            <Avatar className="size-10">
              <AvatarFallback>{initials(user.name)}</AvatarFallback>
            </Avatar>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="min-w-0 truncate text-sm font-medium" title={user.name}>
                {user.name}
              </span>
              <span className="text-muted-foreground truncate text-xs">{user.email}</span>
            </div>
            {!user.emailVerified && options.mail ? <VerifyEmail email={user.email} /> : null}
            {user.role === "admin" ? <Badge variant="outline">Admin</Badge> : null}
          </ListRow>
          <ListRow className="flex-col items-stretch gap-3">
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                void nameForm.handleSubmit();
              }}
            >
              <nameForm.AppField name="name">
                {(field) => <field.TextField label="Display name" autoComplete="name" />}
              </nameForm.AppField>
              <nameForm.AppForm>
                <FormActions>
                  <nameForm.Subscribe selector={(s) => s.isDefaultValue}>
                    {(unchanged) => (
                      <>
                        <nameForm.SubmitButton size="sm" disabled={unchanged}>
                          <SaveLabel justSaved={nameJustSaved}>Save</SaveLabel>
                        </nameForm.SubmitButton>
                        <SaveStatus justSaved={nameJustSaved} />
                      </>
                    )}
                  </nameForm.Subscribe>
                </FormActions>
              </nameForm.AppForm>
            </form>
          </ListRow>
        </ListCard>
      </Section>

      <ConnectedAccounts error={linkError} />

      {options.passwordLogin && !exclusive ? (
        <Section title="Password">
          <ListCard>
            <ListRow className="flex-col items-stretch gap-3">
              <form
                className="flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void passwordForm.handleSubmit();
                }}
              >
                <passwordForm.AppField name="currentPassword">
                  {(field) => (
                    <field.TextField
                      label="Current password"
                      type="password"
                      autoComplete="current-password"
                    />
                  )}
                </passwordForm.AppField>
                <passwordForm.AppField name="newPassword">
                  {(field) => (
                    <field.TextField
                      label="New password"
                      description="Changing it signs you out on your other devices."
                      type="password"
                      autoComplete="new-password"
                    />
                  )}
                </passwordForm.AppField>
                {passwordStatus?.kind === "error" ? (
                  <FieldError>{passwordStatus.message}</FieldError>
                ) : null}
                <passwordForm.AppForm>
                  <FormActions>
                    <passwordForm.SubmitButton size="sm">
                      <SaveLabel justSaved={passwordJustSaved} savedLabel="Password updated">
                        Update password
                      </SaveLabel>
                    </passwordForm.SubmitButton>
                    <SaveStatus justSaved={passwordJustSaved} savedLabel="Password updated" />
                  </FormActions>
                </passwordForm.AppForm>
              </form>
            </ListRow>
          </ListCard>
        </Section>
      ) : null}
    </Page>
  );
}

/** Proves the address by a mailed link, which comes back here once opened. */
function VerifyEmail({ email }: { email: string }) {
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  if (sent) return <span className="text-muted-foreground text-xs">Link sent</span>;
  return (
    <PendingButton
      size="sm"
      variant="outline"
      pending={pending}
      onClick={async () => {
        setPending(true);
        const { error } = await authClient.sendVerificationEmail({
          email,
          callbackURL: "/settings/profile",
        });
        setPending(false);
        if (error) toast.error(error.message ?? "Could not send the link.");
        else setSent(true);
      }}
    >
      Verify email
    </PendingButton>
  );
}
