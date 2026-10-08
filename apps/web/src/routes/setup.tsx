import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { authClient, needsSetupQuery } from "~/modules/auth/client.ts";
import { redirectSearch, safeRedirect } from "~/modules/auth/redirect.ts";
import { setSignupPolicy } from "~/modules/auth/server/signup-functions.ts";
import { leaveIfSignedIn } from "~/modules/auth/signed-in-guard.ts";
import { SIGNUP_POLICIES, SIGNUP_POLICY_LABELS, type SignupPolicy } from "~/modules/auth/signup.ts";
import { AuthScreen } from "~/modules/auth/ui/auth-screen.tsx";
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

const SetupSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1, { message: "Enter your name." })),
  email: Schema.String.check(Schema.isMinLength(3, { message: "Enter your email." })),
  password: Schema.String.check(
    Schema.isMinLength(8, { message: "Password must be at least 8 characters." }),
  ),
});

const POLICY_ITEMS = SIGNUP_POLICIES.map((value) => ({
  value,
  label: SIGNUP_POLICY_LABELS[value].title,
}));

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

function SetupPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { redirect: destination = "/" } = Route.useSearch();
  const policyId = useId();
  const [policy, setPolicy] = useState<SignupPolicy>("approval");
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useAppForm({
    defaultValues: { name: "", email: "", password: "" },
    validators: { onSubmit: Schema.toStandardSchemaV1(SetupSchema) },
    onSubmit: async ({ value }) => {
      setServerError(null);
      const { data, error } = await authClient.signUp.email(value);
      if (error) {
        setServerError(error.message ?? "Could not create the account.");
        return;
      }
      // Someone who set the instance up a moment earlier gets an ordinary
      // account under their policy, and has no say over it.
      if (data.user.role === "admin") await setSignupPolicy({ data: { policy } });
      queryClient.clear();
      await navigate({ href: destination });
    },
  });

  return (
    <AuthScreen>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Set up neema</CardTitle>
          <CardDescription>This account will be the admin.</CardDescription>
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
              {(field) => <field.TextField label="Name" autoComplete="name" />}
            </form.AppField>
            <form.AppField name="email">
              {(field) => <field.TextField label="Email" type="email" autoComplete="email" />}
            </form.AppField>
            <form.AppField name="password">
              {(field) => (
                <field.TextField label="Password" type="password" autoComplete="new-password" />
              )}
            </form.AppField>
            <Field>
              <FieldLabel htmlFor={policyId}>Who can join</FieldLabel>
              <Select
                value={policy}
                onValueChange={(value) => value && setPolicy(value as SignupPolicy)}
                items={POLICY_ITEMS}
              >
                <SelectTrigger id={policyId} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {POLICY_ITEMS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>{SIGNUP_POLICY_LABELS[policy].description}</FieldDescription>
            </Field>
            {serverError ? <FieldError>{serverError}</FieldError> : null}
            <form.AppForm>
              <form.SubmitButton className="w-full">Create admin account</form.SubmitButton>
            </form.AppForm>
          </form>
        </CardContent>
      </Card>
    </AuthScreen>
  );
}
