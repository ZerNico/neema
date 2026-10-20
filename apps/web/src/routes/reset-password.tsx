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

const ResetSchema = Schema.Struct({
  password: Schema.String.check(
    Schema.isMinLength(8, { message: "Password must be at least 8 characters." }),
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
    validators: { onSubmit: Schema.toStandardSchemaV1(ResetSchema) },
    onSubmit: async ({ value }) => {
      if (!token) return;
      setServerError(null);
      const { error } = await authClient.resetPassword({ newPassword: value.password, token });
      if (error) {
        setServerError(error.message ?? "Could not reset the password.");
        return;
      }
      await navigate({ to: "/login" });
    },
  });

  return (
    <AuthScreen>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Choose a new password</CardTitle>
          {token ? null : (
            <CardDescription>This link has expired or was already used.</CardDescription>
          )}
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
                    label="New password"
                    type="password"
                    autoComplete="new-password"
                  />
                )}
              </form.AppField>
              {serverError ? <FieldError>{serverError}</FieldError> : null}
              <form.AppForm>
                <form.SubmitButton className="w-full">Save password</form.SubmitButton>
              </form.AppForm>
            </form>
          </CardContent>
        ) : null}
        <CardFooter>
          <Link
            to={token ? "/login" : "/forgot-password"}
            className={cn(buttonVariants({ variant: "link" }), "h-auto p-0")}
          >
            {token ? "Back to sign in" : "Send a new link"}
          </Link>
        </CardFooter>
      </Card>
    </AuthScreen>
  );
}
