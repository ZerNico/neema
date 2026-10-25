import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import { useState } from "react";
import { authClient } from "~/modules/auth/client.ts";
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
const resetSchema = () =>
  Schema.Struct({
    password: Schema.String.check(
      Schema.isMinLength(8, { message: m.app_auth_password_too_short() }),
    ),
  });

/** Better Auth sends the emailed link here with a token, or with an error once it lapsed. */
export const Route = createFileRoute("/reset-password")({
  validateSearch: (search: Record<string, unknown>): { token?: string } =>
    typeof search["token"] === "string" && !search["error"] ? { token: search["token"] } : {},
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const navigate = useNavigate();
  const { token } = Route.useSearch();
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useAppForm({
    defaultValues: { password: "" },
    validators: { onSubmit: Schema.toStandardSchemaV1(resetSchema()) },
    onSubmit: async ({ value }) => {
      if (!token) return;
      setServerError(null);
      const { error } = await authClient.resetPassword({ newPassword: value.password, token });
      if (error) {
        setServerError(error.message ?? m.app_reset_error());
        return;
      }
      await navigate({ to: "/login" });
    },
  });

  return (
    <AuthScreen>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{m.app_reset_title()}</CardTitle>
          {token ? null : <CardDescription>{m.app_reset_link_expired()}</CardDescription>}
        </CardHeader>
        {token ? (
          <CardContent>
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                void form.handleSubmit();
              }}
            >
              <form.AppField name="password">
                {(field) => (
                  <field.TextField
                    label={m.app_reset_new_password()}
                    type="password"
                    autoComplete="new-password"
                  />
                )}
              </form.AppField>
              {serverError ? <FieldError>{serverError}</FieldError> : null}
              <form.AppForm>
                <form.SubmitButton className="w-full">{m.app_reset_submit()}</form.SubmitButton>
              </form.AppForm>
            </form>
          </CardContent>
        ) : null}
        <CardFooter>
          <Link
            to={token ? "/login" : "/forgot-password"}
            className={cn(buttonVariants({ variant: "link" }), "h-auto p-0")}
          >
            {token ? m.app_auth_back_to_sign_in() : m.app_reset_send_new_link()}
          </Link>
        </CardFooter>
      </Card>
    </AuthScreen>
  );
}
