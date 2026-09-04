import { useQueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { useState } from "react";
import { toast } from "sonner";
import { authClient, sessionUserQuery } from "~/modules/auth/client.ts";
import { useAppForm } from "~/ui/form/app-form.tsx";
import { ListCard, ListRow, Page, Section } from "~/ui/page-shell.tsx";
import { Avatar, AvatarFallback } from "~/ui/primitives/avatar";
import { Badge } from "~/ui/primitives/badge";
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

type PasswordStatus = { kind: "success" | "error"; message: string };

export function ProfilePage() {
  const session = authClient.useSession();
  const user = session.data?.user;
  if (!user) return null;
  return <ProfileForms user={user} />;
}

function ProfileForms({
  user,
}: {
  user: { name: string; email: string; role?: string | null | undefined };
}) {
  const queryClient = useQueryClient();
  const [passwordStatus, setPasswordStatus] = useState<PasswordStatus | null>(null);

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
      queryClient.setQueryData(sessionUserQuery.queryKey, (current) =>
        current ? { ...current, name } : current,
      );
      nameForm.reset({ name });
      // The shell observes this cache, so the patch above updates it immediately;
      // refetch in the background to reconcile with the authoritative session.
      void queryClient.invalidateQueries({
        queryKey: sessionUserQuery.queryKey,
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
      passwordForm.reset();
      setPasswordStatus({
        kind: "success",
        message: "Password updated. Other sessions were signed out.",
      });
    },
  });

  return (
    <Page
      title="Profile"
      description="Your account on this instance."
      rootPath="/settings"
      rootLabel="Settings"
    >
      <Section title="Account">
        <ListCard>
          <ListRow>
            <Avatar className="size-10">
              <AvatarFallback>{user.name.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-medium">{user.name}</span>
              <span className="text-muted-foreground truncate text-xs">{user.email}</span>
            </div>
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
                <div>
                  <nameForm.Subscribe selector={(s) => s.isDefaultValue}>
                    {(unchanged) => (
                      <nameForm.SubmitButton size="sm" disabled={unchanged}>
                        Save
                      </nameForm.SubmitButton>
                    )}
                  </nameForm.Subscribe>
                </div>
              </nameForm.AppForm>
            </form>
          </ListRow>
        </ListCard>
      </Section>

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
                    type="password"
                    autoComplete="new-password"
                    description="At least 8 characters."
                  />
                )}
              </passwordForm.AppField>
              {passwordStatus?.kind === "error" ? (
                <FieldError>{passwordStatus.message}</FieldError>
              ) : null}
              {passwordStatus?.kind === "success" ? (
                <p role="status" className="text-muted-foreground text-sm">
                  {passwordStatus.message}
                </p>
              ) : null}
              <passwordForm.AppForm>
                <div>
                  <passwordForm.SubmitButton size="sm">Update password</passwordForm.SubmitButton>
                </div>
              </passwordForm.AppForm>
            </form>
          </ListRow>
        </ListCard>
      </Section>
    </Page>
  );
}
