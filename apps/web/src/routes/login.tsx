import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import { useState } from "react";
import { authClient } from "~/modules/auth/client.ts";
import { redirectSearch, safeRedirect } from "~/modules/auth/redirect.ts";
import { leaveIfSignedIn } from "~/modules/auth/signed-in-guard.ts";
import { SignInProviders, signInProvidersQuery } from "~/modules/auth/ui/sign-in-providers.tsx";
import { useAppForm } from "~/ui/form/app-form.tsx";
import { buttonVariants } from "~/ui/primitives/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "~/ui/card.tsx";
import { FieldError } from "~/ui/primitives/field";
import { cn } from "~/ui/utils";

const LoginSchema = Schema.Struct({
  email: Schema.String.check(Schema.isMinLength(3, { message: "Enter your email." })),
  password: Schema.String.check(
    Schema.isMinLength(8, { message: "Password must be at least 8 characters." }),
  ),
});

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    redirectSearch(safeRedirect(search["redirect"])),
  beforeLoad: ({ context, search }) => leaveIfSignedIn(context.queryClient, search.redirect),
  loader: ({ context }) => context.queryClient.ensureQueryData(signInProvidersQuery),
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const { redirect } = Route.useSearch();
  const destination = redirect ?? "/";
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useAppForm({
    defaultValues: { email: "", password: "" },
    validators: { onSubmit: Schema.toStandardSchemaV1(LoginSchema) },
    onSubmit: async ({ value }) => {
      setServerError(null);
      const { error } = await authClient.signIn.email({
        email: value.email,
        password: value.password,
      });
      if (error) {
        setServerError(error.message ?? "Could not sign in.");
        return;
      }
      await navigate({ href: destination });
    },
  });

  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
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
            <form.AppField name="email">
              {(field) => <field.TextField label="Email" type="email" autoComplete="email" />}
            </form.AppField>
            <form.AppField name="password">
              {(field) => (
                <field.TextField label="Password" type="password" autoComplete="current-password" />
              )}
            </form.AppField>
            {serverError ? <FieldError>{serverError}</FieldError> : null}
            <form.AppForm>
              <form.SubmitButton className="w-full">Sign in</form.SubmitButton>
            </form.AppForm>
          </form>
        </CardContent>
        <CardFooter>
          <p className="text-muted-foreground text-sm">
            No account?{" "}
            <Link
              to="/register"
              search={redirectSearch(redirect)}
              className={cn(buttonVariants({ variant: "link" }), "h-auto p-0")}
            >
              Register
            </Link>
          </p>
        </CardFooter>
      </Card>
    </div>
  );
}
