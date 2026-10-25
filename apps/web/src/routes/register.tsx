import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { authClient } from "~/modules/auth/client.ts";
import { redirectSearch, safeRedirect } from "~/modules/auth/redirect.ts";
import { guardSignInPage } from "~/modules/auth/signed-in-guard.ts";
import { SignInProviders } from "~/modules/auth/ui/sign-in-providers.tsx";
import { signInOptionsQuery } from "~/modules/auth/queries.ts";
import { useAppForm } from "~/ui/form/app-form.ts";
import { buttonVariants } from "~/ui/primitives/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "~/ui/card.tsx";
import { FieldError } from "~/ui/primitives/field";
import { cn } from "~/ui/utils";
import { AuthScreen } from "~/modules/auth/ui/auth-screen.tsx";
import { m } from "~/paraglide/messages.js";

// A function, so the messages read in the locale of the page that shows them.
const registerSchema = () =>
  Schema.Struct({
    name: Schema.String.check(Schema.isMinLength(1, { message: m.app_auth_name_required() })),
    email: Schema.String.check(Schema.isMinLength(3, { message: m.app_auth_email_required() })),
    password: Schema.String.check(
      Schema.isMinLength(8, { message: m.app_auth_password_too_short() }),
    ),
  });

export const Route = createFileRoute("/register")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    redirectSearch(safeRedirect(search["redirect"])),
  beforeLoad: async ({ context, search }) => {
    await guardSignInPage(context.queryClient, search.redirect);
  },
  loader: ({ context }) => context.queryClient.ensureQueryData(signInOptionsQuery),
  component: RegisterPage,
});

function RegisterPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { redirect } = Route.useSearch();
  const destination = redirect ?? "/";
  const [serverError, setServerError] = useState<string | null>(null);
  const [awaitingProof, setAwaitingProof] = useState<string | null>(null);
  const { data: options } = useSuspenseQuery(signInOptionsQuery);
  const providers = options.providers.filter((p) => p.signup);

  const form = useAppForm({
    defaultValues: { name: "", email: "", password: "" },
    validators: { onSubmit: Schema.toStandardSchemaV1(registerSchema()) },
    onSubmit: async ({ value }) => {
      setServerError(null);
      const { data, error } = await authClient.signUp.email({
        name: value.name,
        email: value.email,
        password: value.password,
        callbackURL: destination,
      });
      if (error) {
        setServerError(error.message ?? m.app_register_error());
        return;
      }
      // With verification required there is no session until the link is opened.
      if (!data.token) {
        setAwaitingProof(value.email);
        return;
      }
      // This page's guard cached "signed out"; the app guard would read that
      // and send the new session straight back here. Sign-out clears the same.
      queryClient.clear();
      await navigate({ href: destination });
    },
  });

  if (awaitingProof) {
    return (
      <AuthScreen>
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>{m.app_register_check_email()}</CardTitle>
            <CardDescription>
              {m.app_register_check_email_description({ email: awaitingProof })}
            </CardDescription>
          </CardHeader>
        </Card>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{m.app_register_title()}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <SignInProviders
            providers={providers}
            callbackURL={destination}
            separated={options.passwordSignup}
          />
          {options.passwordSignup ? (
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                void form.handleSubmit();
              }}
            >
              <form.AppField name="name">
                {(field) => <field.TextField label={m.common_name()} autoComplete="name" />}
              </form.AppField>
              <form.AppField name="email">
                {(field) => (
                  <field.TextField label={m.app_auth_email()} type="email" autoComplete="email" />
                )}
              </form.AppField>
              <form.AppField name="password">
                {(field) => (
                  <field.TextField
                    label={m.app_auth_password()}
                    type="password"
                    autoComplete="new-password"
                  />
                )}
              </form.AppField>
              {serverError ? <FieldError>{serverError}</FieldError> : null}
              <form.AppForm>
                <form.SubmitButton className="w-full">{m.app_register_submit()}</form.SubmitButton>
              </form.AppForm>
            </form>
          ) : null}
          {!options.passwordSignup && providers.length === 0 ? (
            <p className="text-muted-foreground text-sm">{m.app_register_closed()}</p>
          ) : null}
        </CardContent>
        <CardFooter>
          <p className="text-muted-foreground text-sm">
            {m.app_register_have_account()}{" "}
            <Link
              to="/login"
              search={redirectSearch(redirect)}
              className={cn(buttonVariants({ variant: "link" }), "h-auto p-0")}
            >
              {m.app_register_sign_in()}
            </Link>
          </p>
        </CardFooter>
      </Card>
    </AuthScreen>
  );
}
