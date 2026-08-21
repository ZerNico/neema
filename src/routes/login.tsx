import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import { useState } from "react";
import { authClient } from "~/modules/auth/client.ts";
import { useAppForm } from "~/shared/ui/form/app-form.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "~/shared/ui/primitives/card";

const LoginSchema = Schema.Struct({
  email: Schema.String.check(Schema.isMinLength(3)),
  password: Schema.String.check(Schema.isMinLength(8)),
});

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
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
        setServerError(error.message ?? "Sign in failed");
        return;
      }
      await navigate({ to: "/" });
    },
  });

  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
        </CardHeader>
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
            <form.AppField name="password">
              {(field) => (
                <field.TextField label="Password" type="password" autoComplete="current-password" />
              )}
            </form.AppField>
            {serverError ? <p className="text-destructive text-sm">{serverError}</p> : null}
            <form.AppForm>
              <form.SubmitButton>Sign in</form.SubmitButton>
            </form.AppForm>
          </form>
          <p className="text-muted-foreground mt-4 text-sm">
            No account?{" "}
            <Link to="/register" className="text-foreground underline">
              Register
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
