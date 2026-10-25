import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { announceSignIn } from "~/modules/integrations/client/sign-in-channel.ts";
import { AuthScreen } from "~/modules/auth/ui/auth-screen.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "~/ui/card.tsx";
import { m } from "~/paraglide/messages.js";

interface Landing {
  attempt?: string;
  error?: string;
}

/**
 * Where a sign-in in a window of its own ends: it tells the dialog that opened
 * it and closes. A window the browser keeps open, or the system browser the
 * desktop app used, says what happened instead.
 */
export const Route = createFileRoute("/integrations/connected")({
  validateSearch: (search: Record<string, unknown>): Landing => ({
    ...(typeof search.attempt === "string" ? { attempt: search.attempt.slice(0, 100) } : {}),
    ...(typeof search.error === "string" ? { error: search.error.slice(0, 300) } : {}),
  }),
  component: SignInLanding,
});

function SignInLanding() {
  const { attempt, error } = Route.useSearch();
  useEffect(() => {
    if (!attempt) return;
    announceSignIn({ attempt, error: error ?? null });
    window.close();
  }, [attempt, error]);
  return (
    <AuthScreen>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            {error ? m.app_integration_sign_in_failed_title() : m.app_integration_signed_in_title()}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {/* Never the error itself: anyone can link here with any text in the address. */}
          <p className="text-muted-foreground text-sm">
            {error
              ? m.app_integration_sign_in_failed_description()
              : m.app_integration_signed_in_description()}
          </p>
        </CardContent>
      </Card>
    </AuthScreen>
  );
}
