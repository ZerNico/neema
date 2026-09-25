/** Storage key the theme boot script and `useTheme` must share. */
export const THEME_STORAGE_KEY = "theme";

/** Runs before paint in `__root` to avoid a flash of the wrong theme. Runs by the CSP nonce. */
export const themeInitScript = `(function(){try{var t=localStorage.getItem("${THEME_STORAGE_KEY}");var d=t==="dark"||((!t||t==="system")&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d)}catch(e){}})()`;

/** Capability detection mirrors `readDesktopChrome`. Runs by the CSP nonce. */
export const desktopChromeInitScript = `(function(){var c=window.__chatDesktop&&window.__chatDesktop.chrome;if(c&&["darwin","win32","linux"].includes(c.platform)&&typeof c.getState==="function"&&typeof c.onState==="function"&&typeof c.setTheme==="function")document.documentElement.dataset.desktopChrome=c.platform})()`;
