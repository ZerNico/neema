/** The operator's way back in when no identity provider works. */
export const passwordLoginForced = () => process.env.AUTH_PASSWORD_LOGIN?.trim() === "force";

/**
 * Whether addresses must be proven. The operator's way back in lifts it too:
 * a broken mail server would otherwise keep every password account out.
 */
export const verificationRequired = (settings: { requireEmailVerification: boolean }) =>
  settings.requireEmailVerification && !passwordLoginForced();
