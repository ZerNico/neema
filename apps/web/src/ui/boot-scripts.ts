/** Storage key the theme boot script and `useTheme` must share. */
export const THEME_STORAGE_KEY = "theme";

/** Storage key the boot script and `useColorScheme` share for the colour scheme. */
export const SCHEME_STORAGE_KEY = "scheme";

/** The colour schemes `app.css` defines, the first being the default. */
export const COLOR_SCHEMES = [
  "iris",
  "stone",
  "slate",
  "sage",
  "ocean",
  "clay",
  "amber",
  "t3-chat",
  "classic",
] as const;

/** Runs before paint in `__root` to avoid a flash of the wrong theme. Runs by the CSP nonce. */
export const themeInitScript = `(function(){var r=document.documentElement;r.dataset.scheme="${COLOR_SCHEMES[0]}";try{var s=localStorage.getItem("${SCHEME_STORAGE_KEY}");if(${JSON.stringify(COLOR_SCHEMES)}.indexOf(s)>=0)r.dataset.scheme=s;var t=localStorage.getItem("${THEME_STORAGE_KEY}");var d=t==="dark"||((!t||t==="system")&&matchMedia("(prefers-color-scheme: dark)").matches);r.classList.toggle("dark",d)}catch(e){}})()`;

/** Capability detection mirrors `readDesktopChrome`. Runs by the CSP nonce. */
export const desktopChromeInitScript = `(function(){var c=window.__chatDesktop&&window.__chatDesktop.chrome;if(c&&["darwin","win32","linux"].includes(c.platform)&&typeof c.getState==="function"&&typeof c.onState==="function"&&typeof c.setTheme==="function")document.documentElement.dataset.desktopChrome=c.platform})()`;
