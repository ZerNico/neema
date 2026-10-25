import { createFileRoute, Link } from "@tanstack/react-router";
import { Schema } from "effect";
import { useState } from "react";
import { authClient } from "~/modules/auth/client.ts";
import { guardSignInPage } from "~/modules/auth/signed-in-guard.ts";
import { AuthScreen } from "~/modules/auth/ui/auth-screen.tsx";
import { useAppForm } from "~/ui/form/app-form.ts";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "~/ui/card.tsx";
import { buttonVariants } from "~/ui/primitives/button";
import { FieldError } from "~/ui/primitives/field";
import { cn } from "~/ui/utils";
import { m } from "~/paraglide/messages.js";

// A function, so the messages read in the locale of the page that shows them.
const forgotSchema = () =>
  Schema.Struct({
    email: Schema.String.check(Schema.isMinLength(3, { message: m.app_auth_email_required() })),
  });

export const Route = createFileRoute("/forgot-password")({
  beforeLoad: async ({ context }) => {
    await guardSignInPage(context.queryClient, undefined);
  },
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useAppForm({
    defaultValues: { email: "" },
    validators: { onSubmit: Schema.toStandardSchemaV1(forgotSchema()) },
    onSubmit: async ({ value }) => {
      setServerError(null);
      // The answer is the same for every address, so nobody learns who has an account.
      const { error } = await authClient.requestPasswordReset({
        email: value.email,
        redirectTo: "/reset-password",
      });
      if (error) {
        setServerError(error.message ?? m.app_forgot_error());
        return;
      }
      setSentTo(value.email);
    },
  });

  return (
    <AuthScreen>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{sentTo ? m.app_register_check_email() : m.app_forgot_title()}</CardTitle>
          {sentTo ? (
            <CardDescription>{m.app_forgot_sent({ email: sentTo })}</CardDescription>
          ) : null}
        </CardHeader>
        {sentTo ? null : (
          <CardContent>
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                void form.handleSubmit();
              }}
            >
              <form.AppField name="email">
                {(field) => (
                  <field.TextField label={m.app_auth_email()} type="email" autoComplete="email" />
                )}
              </form.AppField>
              {serverError ? <FieldError>{serverError}</FieldError> : null}
              <form.AppForm>
                <form.SubmitButton className="w-full">{m.app_forgot_submit()}</form.SubmitButton>
              </form.AppForm>
            </form>
          </CardContent>
        )}
        <CardFooter>
          <Link to="/login" className={cn(buttonVariants({ variant: "link" }), "h-auto p-0")}>
            {m.app_auth_back_to_sign_in()}
          </Link>
        </CardFooter>
      </Card>
    </AuthScreen>
  );
}
