/** Storage key the theme boot script and `useTheme` must share. */
export const THEME_STORAGE_KEY = "theme";

/** Storage key the boot script and `useColorScheme` share for the colour scheme. */
export const SCHEME_STORAGE_KEY = "scheme";

/** The colour schemes `app.css` defines, the first being the default. */
export const COLOR_SCHEMES = [
  "iris",
  "stone",
  "cobalt",
  "matcha",
  "ocean",
  "clay",
  "cherry",
  "rose-pine",
  "t3-chat",
  "classic",
] as const;

/** Retired schemes and their successors, so a stored choice carries over. */
const RETIRED_SCHEMES: Record<string, (typeof COLOR_SCHEMES)[number]> = {
  slate: "cobalt",
  sage: "matcha",
  amber: "cherry",
};

/**
 * Runs before paint in `__root` to avoid a flash of the wrong theme. It also adds the
 * `theme-color` meta, light or dark until `useThemeColor` reads the page: rendered by
 * React, the meta would be hoisted and hydrate as a second copy. Runs by the CSP nonce.
 */
export const themeInitScript = `(function(){var r=document.documentElement;r.dataset.scheme="${COLOR_SCHEMES[0]}";try{var s=localStorage.getItem("${SCHEME_STORAGE_KEY}"),n=${JSON.stringify(RETIRED_SCHEMES)}[s];if(n){s=n;localStorage.setItem("${SCHEME_STORAGE_KEY}",s)}if(${JSON.stringify(COLOR_SCHEMES)}.indexOf(s)>=0)r.dataset.scheme=s;var t=localStorage.getItem("${THEME_STORAGE_KEY}");var d=t==="dark"||((!t||t==="system")&&matchMedia("(prefers-color-scheme: dark)").matches);r.classList.toggle("dark",d);var m=document.createElement("meta");m.name="theme-color";m.content=d?"#171717":"#ffffff";document.head.appendChild(m)}catch(e){}})()`;

/** Capability detection mirrors `readDesktopChrome`. Runs by the CSP nonce. */
export const desktopChromeInitScript = `(function(){var c=window.__chatDesktop&&window.__chatDesktop.chrome;if(c&&["darwin","win32","linux"].includes(c.platform)&&typeof c.getState==="function"&&typeof c.onState==="function"&&typeof c.setTheme==="function")document.documentElement.dataset.desktopChrome=c.platform})()`;
