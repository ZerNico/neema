import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { authClient } from "~/modules/auth/client.ts";
import { redirectSearch, safeRedirect } from "~/modules/auth/redirect.ts";
import { leaveIfSignedIn, setUpFirst } from "~/modules/auth/signed-in-guard.ts";
import { SignInProviders } from "~/modules/auth/ui/sign-in-providers.tsx";
import { signInProvidersQuery } from "~/modules/auth/queries.ts";
import { useAppForm } from "~/ui/form/app-form.ts";
import { buttonVariants } from "~/ui/primitives/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "~/ui/card.tsx";
import { FieldError } from "~/ui/primitives/field";
import { cn } from "~/ui/utils";
import { AuthScreen } from "~/modules/auth/ui/auth-screen.tsx";

const RegisterSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1, { message: "Enter your name." })),
  email: Schema.String.check(Schema.isMinLength(3, { message: "Enter your email." })),
  password: Schema.String.check(
    Schema.isMinLength(8, { message: "Password must be at least 8 characters." }),
  ),
});

export const Route = createFileRoute("/register")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    redirectSearch(safeRedirect(search["redirect"])),
  beforeLoad: async ({ context, search }) => {
    await setUpFirst(context.queryClient, search.redirect);
    await leaveIfSignedIn(context.queryClient, search.redirect);
  },
  loader: ({ context }) => context.queryClient.ensureQueryData(signInProvidersQuery),
  component: RegisterPage,
});

function RegisterPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { redirect } = Route.useSearch();
  const destination = redirect ?? "/";
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useAppForm({
    defaultValues: { name: "", email: "", password: "" },
    validators: { onSubmit: Schema.toStandardSchemaV1(RegisterSchema) },
    onSubmit: async ({ value }) => {
      setServerError(null);
      const { error } = await authClient.signUp.email({
        name: value.name,
        email: value.email,
        password: value.password,
      });
      if (error) {
        setServerError(error.message ?? "Could not create the account.");
        return;
      }
      // This page's guard cached "signed out"; the app guard would read that
      // and send the new session straight back here. Sign-out clears the same.
      queryClient.clear();
      await navigate({ href: destination });
    },
  });

  return (
    <AuthScreen>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Create account</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <SignInProviders callbackURL={destination} />
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
            {serverError ? <FieldError>{serverError}</FieldError> : null}
            <form.AppForm>
              <form.SubmitButton className="w-full">Create account</form.SubmitButton>
            </form.AppForm>
          </form>
        </CardContent>
        <CardFooter>
          <p className="text-muted-foreground text-sm">
            Already have an account?{" "}
            <Link
              to="/login"
              search={redirectSearch(redirect)}
              className={cn(buttonVariants({ variant: "link" }), "h-auto p-0")}
            >
              Sign in
            </Link>
          </p>
        </CardFooter>
      </Card>
    </AuthScreen>
  );
}
