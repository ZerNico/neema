/** The browser page the shell opens; the challenge rides along when there is one. */
export const desktopSignInPath = (challenge?: string) =>
  challenge ? `/desktop/sign-in?challenge=${encodeURIComponent(challenge)}` : "/desktop/sign-in";
