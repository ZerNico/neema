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

const ForgotSchema = Schema.Struct({
  email: Schema.String.check(Schema.isMinLength(3, { message: "Enter your email." })),
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
    validators: { onSubmit: Schema.toStandardSchemaV1(ForgotSchema) },
    onSubmit: async ({ value }) => {
      setServerError(null);
      // The answer is the same for every address, so nobody learns who has an account.
      const { error } = await authClient.requestPasswordReset({
        email: value.email,
        redirectTo: "/reset-password",
      });
      if (error) {
        setServerError(error.message ?? "Could not send the link.");
        return;
      }
      setSentTo(value.email);
    },
  });

  return (
    <AuthScreen>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{sentTo ? "Check your email" : "Reset password"}</CardTitle>
          {sentTo ? (
            <CardDescription>
              If {sentTo} has an account, a link to reset its password is on the way.
            </CardDescription>
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
                {(field) => <field.TextField label="Email" type="email" autoComplete="email" />}
              </form.AppField>
              {serverError ? <FieldError>{serverError}</FieldError> : null}
              <form.AppForm>
                <form.SubmitButton className="w-full">Send link</form.SubmitButton>
              </form.AppForm>
            </form>
          </CardContent>
        )}
        <CardFooter>
          <Link to="/login" className={cn(buttonVariants({ variant: "link" }), "h-auto p-0")}>
            Back to sign in
          </Link>
        </CardFooter>
      </Card>
    </AuthScreen>
  );
}
