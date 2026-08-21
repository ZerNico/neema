import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import { useState } from "react";
import { authClient } from "~/modules/auth/client.ts";
import { useAppForm } from "~/shared/ui/form/app-form.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "~/shared/ui/primitives/card";

const RegisterSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  email: Schema.String.check(Schema.isMinLength(3)),
  password: Schema.String.check(Schema.isMinLength(8)),
});

export const Route = createFileRoute("/register")({
  component: RegisterPage,
});

function RegisterPage() {
  const navigate = useNavigate();
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
        setServerError(error.message ?? "Registration failed");
        return;
      }
      await navigate({ to: "/" });
    },
  });

  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Create account</CardTitle>
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
            {serverError ? <p className="text-destructive text-sm">{serverError}</p> : null}
            <form.AppForm>
              <form.SubmitButton>Create account</form.SubmitButton>
            </form.AppForm>
          </form>
          <p className="text-muted-foreground mt-4 text-sm">
            Already have an account?{" "}
            <Link to="/login" className="text-foreground underline">
              Sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
