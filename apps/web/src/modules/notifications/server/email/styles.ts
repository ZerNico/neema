/**
 * The app's default scheme (iris, light) in hex, since mail clients know no
 * oklch, no CSS variables and no style sheets: each element carries its own.
 */
export const COLORS = {
  canvas: "#f1f0f6",
  sheet: "#ffffff",
  foreground: "#1b1724",
  muted: "#716a81",
  primary: "#5b3cbc",
  primaryForeground: "#fbfbfb",
  border: "#e3e2ea",
  subtle: "#f2f0f7",
};

export const APP_NAME = "neema";

/** Geist where the client loads web fonts, the platform's sans elsewhere. */
export const FONT_STACK =
  "'Geist',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export const muted = { margin: "0", fontSize: "13px", lineHeight: "20px", color: COLORS.muted };
export const footerLink = { color: COLORS.muted, textDecoration: "underline" };
export const paragraph = {
  margin: "0 0 16px",
  fontSize: "15px",
  lineHeight: "24px",
  color: COLORS.foreground,
};
