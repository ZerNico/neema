import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { authClient, needsSetupQuery } from "~/modules/auth/client.ts";
import { redirectSearch, safeRedirect } from "~/modules/auth/redirect.ts";
import { saveAuthSettings } from "~/modules/auth/server/signup-functions.ts";
import { leaveIfSignedIn } from "~/modules/auth/signed-in-guard.ts";
import { signupModeItems, SIGNUP_MODE_LABELS, type SignupMode } from "~/modules/auth/signup.ts";
import { AuthScreen } from "~/modules/auth/ui/auth-screen.tsx";
import { DesktopSignIn } from "~/modules/auth/ui/desktop-sign-in.tsx";
import { useDesktopAuth } from "~/modules/desktop/client/bridge.ts";
import { useAppForm } from "~/ui/form/app-form.ts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/ui/card.tsx";
import { Field, FieldDescription, FieldError, FieldLabel } from "~/ui/primitives/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";
import { m } from "~/paraglide/messages.js";

// Built where used, so its messages read in the page's language.
const setupSchema = () =>
  Schema.Struct({
    name: Schema.String.check(Schema.isMinLength(1, { message: m.auth_form_enter_name() })),
    email: Schema.String.check(Schema.isMinLength(3, { message: m.auth_form_enter_email() })),
    password: Schema.String.check(
      Schema.isMinLength(8, { message: m.auth_form_password_length() }),
    ),
  });

/**
 * The first account on an instance, and the only page that creates one. Sign-in
 * providers are added by an admin, so before this there is no other way in.
 */
export const Route = createFileRoute("/setup")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    redirectSearch(safeRedirect(search["redirect"])),
  beforeLoad: async ({ context, search }) => {
    if (!(await context.queryClient.fetchQuery(needsSetupQuery)))
      throw redirect({ to: "/login", search: redirectSearch(search.redirect) });
    await leaveIfSignedIn(context.queryClient, search.redirect);
  },
  component: SetupPage,
});

/**
 * The shell shows no password form (docs/internals/desktop.md), so it gets its sign-in screen:
 * the browser page it opens leads an anonymous visitor through setup and back with a ticket.
 */
function SetupPage() {
  const desktopAuth = useDesktopAuth();
  if (desktopAuth) return <DesktopSignIn auth={desktopAuth} />;
  return <SetupForm />;
}

function SetupForm() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { redirect: destination = "/" } = Route.useSearch();
  const modeId = useId();
  const [mode, setMode] = useState<SignupMode>("approval");
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useAppForm({
    defaultValues: { name: "", email: "", password: "" },
    validators: { onSubmit: Schema.toStandardSchemaV1(setupSchema()) },
    onSubmit: async ({ value }) => {
      setServerError(null);
      const { data, error } = await authClient.signUp.email(value);
      if (error) {
        setServerError(error.message ?? m.auth_register_error());
        return;
      }
      // Someone who set the instance up a moment earlier gets an ordinary
      // account under their settings, and has no say over them.
      // A fresh instance has no providers, so password signup is every way in.
      if (data.user.role === "admin")
        await saveAuthSettings({
          data: {
            passwordSignup: mode,
            passwordLogin: true,
            requireEmailVerification: false,
            admitDomains: [],
          },
        });
      queryClient.clear();
      await navigate({ href: destination });
    },
  });

  return (
    <AuthScreen>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{m.auth_setup_title()}</CardTitle>
          <CardDescription>{m.auth_setup_description()}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void form.handleSubmit();
            }}
          >
            <form.AppField name="name">
              {(field) => <field.TextField label={m.auth_form_name()} autoComplete="name" />}
            </form.AppField>
            <form.AppField name="email">
              {(field) => (
                <field.TextField label={m.auth_form_email()} type="email" autoComplete="email" />
              )}
            </form.AppField>
            <form.AppField name="password">
              {(field) => (
                <field.TextField
                  label={m.auth_form_password()}
                  type="password"
                  autoComplete="new-password"
                />
              )}
            </form.AppField>
            <Field>
              <FieldLabel htmlFor={modeId}>{m.auth_setup_who_can_join()}</FieldLabel>
              <Select
                value={mode}
                onValueChange={(value) => value && setMode(value)}
                items={signupModeItems()}
              >
                <SelectTrigger id={modeId} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {signupModeItems().map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>{SIGNUP_MODE_LABELS[mode].description}</FieldDescription>
            </Field>
            {serverError ? <FieldError>{serverError}</FieldError> : null}
            <form.AppForm>
              <form.SubmitButton className="w-full">{m.auth_setup_submit()}</form.SubmitButton>
            </form.AppForm>
          </form>
        </CardContent>
      </Card>
    </AuthScreen>
  );
}
