import { useState } from "react";
import { authClient } from "~/modules/auth/client.ts";
import { PendingButton } from "~/ui/pending-button.tsx";
import { FieldError } from "~/ui/primitives/field";
import { Separator } from "~/ui/primitives/separator";
import type { SignInProvider } from "../oauth.ts";
import { loginErrorURL } from "../oauth-errors.ts";

/**
 * One button per provider given. Both built-in and OpenID Connect entries go
 * through `signIn.social`: the generic-oauth plugin registers its providers as
 * ordinary social providers, so there is no second sign-in call to make.
 */
export function SignInProviders({
  providers,
  callbackURL = "/",
  separated,
}: {
  providers: readonly SignInProvider[];
  callbackURL?: string;
  /** Whether a password form follows, which the "or" divider introduces. */
  separated: boolean;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (providers.length === 0) return null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        {providers.map((provider) => (
          <PendingButton
            key={provider.id}
            variant="outline"
            className="w-full"
            pending={pending === provider.id}
            disabled={pending !== null}
            onClick={async () => {
              setError(null);
              setPending(provider.id);
              const { error: failure } = await authClient.signIn.social({
                provider: provider.id,
                callbackURL,
                // Better Auth's own error page is a dead end; ours explains.
                errorCallbackURL: loginErrorURL(callbackURL),
              });
              // A success redirects away, so only a failure resumes here.
              if (failure) {
                setError(failure.message ?? `Could not sign in with ${provider.label}.`);
                setPending(null);
              }
            }}
          >
            Continue with {provider.label}
          </PendingButton>
        ))}
      </div>
      {error ? <FieldError>{error}</FieldError> : null}
      {separated ? (
        <div className="flex items-center gap-3">
          <Separator className="flex-1" />
          <span className="text-muted-foreground text-xs">or</span>
          <Separator className="flex-1" />
        </div>
      ) : null}
    </div>
  );
}
