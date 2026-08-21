import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { authClient } from "~/modules/auth/client.ts";
import { AdminPage, ListCard, ListRow } from "~/modules/admin/ui/admin-shell.tsx";
import { Avatar, AvatarFallback } from "~/ui/primitives/avatar";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { Field, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";

export function ProfilePage() {
  const session = authClient.useSession();
  const user = session.data?.user;

  const [name, setName] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordStatus, setPasswordStatus] = useState<string | null>(null);

  const effectiveName = name ?? user?.name ?? "";

  const saveName = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.updateUser({ name: effectiveName.trim() });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => setName(null),
  });

  const changePassword = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });
      if (error) throw new Error(error.message ?? "Password change failed");
    },
    onSuccess: () => {
      setCurrentPassword("");
      setNewPassword("");
      setPasswordStatus("Password updated. Other sessions were signed out.");
    },
    onError: (error) => setPasswordStatus(error.message),
  });

  if (!user) return null;

  const nameDirty = name !== null && name.trim() !== user.name;

  return (
    <AdminPage
      title="Profile"
      description="Your account on this instance."
      rootPath="/settings"
      rootLabel="Settings"
    >
      <section className="flex flex-col gap-2">
        <h2 className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
          Account
        </h2>
        <ListCard>
          <ListRow>
            <Avatar className="size-10">
              <AvatarFallback>{user.name.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-medium">{user.name}</span>
              <span className="text-muted-foreground truncate text-xs">{user.email}</span>
            </div>
            {user.role === "admin" ? <Badge>admin</Badge> : null}
          </ListRow>
          <ListRow className="items-end gap-3">
            <Field className="flex-1">
              <FieldLabel>Display name</FieldLabel>
              <Input
                value={effectiveName}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
              />
            </Field>
            <Button
              size="sm"
              disabled={!nameDirty || !effectiveName.trim() || saveName.isPending}
              onClick={() => saveName.mutate()}
            >
              {saveName.isPending ? "Saving…" : "Save"}
            </Button>
          </ListRow>
        </ListCard>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
          Password
        </h2>
        <ListCard>
          <ListRow className="flex-col items-stretch gap-3">
            <Field>
              <FieldLabel>Current password</FieldLabel>
              <Input
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel>New password</FieldLabel>
              <Input
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </Field>
            {passwordStatus ? (
              <p className="text-muted-foreground text-xs">{passwordStatus}</p>
            ) : null}
            <div>
              <Button
                size="sm"
                disabled={!currentPassword || newPassword.length < 8 || changePassword.isPending}
                onClick={() => {
                  setPasswordStatus(null);
                  changePassword.mutate();
                }}
              >
                {changePassword.isPending ? "Updating…" : "Update password"}
              </Button>
            </div>
          </ListRow>
        </ListCard>
      </section>
    </AdminPage>
  );
}
