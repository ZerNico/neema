# Sign-up and sign-in methods

Every way into the instance is one method: email and password, or one OAuth provider. Each
method decides two things separately: whether it signs people in, and how it treats someone
new. Nothing is instance-wide except the domain list, verification, and the bootstrap owner.

## A mode per method

- `auth_settings.password_signup` and `oauth_providers.signup` are each `open`, `approval` or
  `closed`. The gate in `signup-gate.ts` reads the mode of the method a creation came through,
  on that creation, so a change applies to the next signup without rebuilding the auth
  instance. The method is the `callback/:id` parameter on an OAuth return, the `provider` of a
  `/sign-in/social` call that signs up with an ID token, and password only on `/sign-up/email`.
  Any other endpoint that creates a user admits nobody: a new Better Auth path has to be named
  here before it can create accounts.
- A password signup is also asked in a `before` hook, ahead of creation. With verification
  required, Better Auth answers a refused creation as success, and the person would wait for a
  link that never comes.
- `closed` refuses creation, not sign-in: an existing account still signs in through a closed
  provider. That is why the register page hides a closed method, unless a listed domain can
  still join through it, and the login page hides none.
- A provider that is switched off or deleted while someone is mid-redirect counts as closed.
- Each mode is set where its method is: password under Email and password, a provider in its
  own dialog. There is no instance-wide control on top: one that writes the others reads as a
  second setting and contradicts them as soon as they differ. Setup writes the password mode,
  the only way in a fresh instance has.

## Verified addresses

- An address counts as verified when the provider says so (`email_verified`), when the
  provider has `trust_emails`, after the person opens a link we mailed, or after an admin marks
  it. A password signup is never verified when it is created.
- `trust_emails` also puts the provider in Better Auth's `trustedProviders`, so its sign-ins
  may link to an existing account with that address. Only an identity provider that owns its
  domain should have it: anything else can hand over whatever address it likes.
- Sign-in never merges into an account whose own address is unverified
  (`requireLocalEmailVerified`). Otherwise whoever typed someone's address first would receive
  their real login. The person links from Settings instead, signed in to both, which is also
  the only place a different address may be linked (`allowDifferentEmails`).
- `require_email_verification` needs SMTP, and clearing SMTP is refused while it is on. Turning it
  on also needs the admin's own address verified (Profile sends a link), which proves the mail
  server delivers before anyone depends on it. When on, a password account cannot sign in until
  it opens its link, and email lookups (sharing, its picker, project members) only find verified
  addresses (`addressableByEmailSql`). An OAuth account the provider did not verify still signs
  in, but nobody finds it by email. When off, addresses are stored unverified and lookups ignore
  the flag. Turning it on never verifies anyone; the next sign-in mails them a link.
- Verification is baked into the Better Auth instance, so saving it, or the SMTP settings,
  calls `invalidateAuth()`. Everything else here is read per request.
- Domain admission on verification runs from the user `update` hook, since every path that marks
  an address verified (the link, a provider confirming it on a later sign-in, an admin) updates
  that row. Marking an address verified from the users page therefore also lets a waiting
  account in a listed domain in.

## Listed domains

- A verified address in `admit_domains` is created and approved whatever its method's mode, so
  `closed` plus a domain means "only this domain", and `approval` plus a domain means "this
  domain directly, everyone else waits".
- An unverified address never matches, since anyone can type one. A password signup in a
  listed domain is therefore only created while verification is required, waiting, and
  approved when its link is opened. A rejection stands: proving the address later does not
  undo it.

## Password sign-in off

- `auth_settings.password_login` off refuses every password endpoint (sign-in, sign-up, reset)
  in a `before` hook, read per request. Setup is the exception, since the first account has
  nothing else to sign in with.
- One rule guards every change that could lock someone out (`keepsWayIn`): turning passwords
  off, switching off or deleting a provider, and unlinking an account are refused when the
  person making the change would be left with no way in, which is a password of their own while
  passwords are on, or an account on an enabled provider. Whether other people keep a way in is
  the admin's call.
- `AUTH_PASSWORD_LOGIN=force` keeps password sign-in on and lifts the verification requirement,
  for the day the identity provider or the mail server breaks. Every reader of the requirement
  asks `verificationRequired()`, never the stored flag, so admission, email lookups and the
  admin pages all agree that nothing waits on a link.

## A provider as the only sign-in

- `oauth_providers.exclusive` makes a provider the only way in for every account connected to
  it, while it is enabled. Its point is offboarding: someone switched off at the identity
  provider must not keep another way in here.
- Enforced on session creation, as an allowlist: such an account gets a session only through
  that provider (its callback or an ID token), or by continuing a session it already has
  (desktop ticket, session rotation, impersonation). A password, the emailed verification link
  (which signs in by itself) and any other provider are all refused. Any new Better Auth path
  that creates sessions is refused for them until it is named. Refusing at the session rather
  than the request means a password sign-in only learns why once the password has checked out.
- A credential account cannot be created for such a user, which is how a reset would otherwise
  hand them a password, and the connection cannot be unlinked.
- Switching the provider off lifts all of this, and so does `AUTH_PASSWORD_LOGIN=force`, so an
  admin bound to a broken identity provider still has a way back.
