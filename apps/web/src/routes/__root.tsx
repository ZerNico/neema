import type { QueryClient } from "@tanstack/react-query";
import {
  ClientOnly,
  HeadContent,
  Scripts,
  createRootRouteWithContext,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import appCss from "~/styles/app.css?url";
import { Toaster } from "~/ui/primitives/sonner";
import { themeInitScript } from "~/ui/theme.tsx";
import {
  DesktopChromeFrame,
  DesktopChromeProvider,
  desktopChromeInitScript,
} from "~/ui/desktop-chrome.tsx";
import { RouteError, RouteNotFound } from "~/ui/route-error.tsx";
import { StartupPending } from "~/ui/startup-pending.tsx";

interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "neema" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      // Follows the browser chrome, not the app theme: the tab strip is the browser's.
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      {
        rel: "icon",
        type: "image/svg+xml",
        href: "/favicon-light.svg",
        media: "(prefers-color-scheme: dark)",
      },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
      { rel: "manifest", href: "/site.webmanifest" },
    ],
  }),
  shellComponent: RootDocument,
  errorComponent: RouteError,
  notFoundComponent: RouteNotFound,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Applies the stored theme before first paint to avoid flashing */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <script dangerouslySetInnerHTML={{ __html: desktopChromeInitScript }} />
        <HeadContent />
      </head>
      <body>
        <DesktopChromeFrame />
        <ClientOnly fallback={<StartupPending />}>
          <DesktopChromeProvider>
            {children}
            <Toaster position="bottom-right" />
          </DesktopChromeProvider>
        </ClientOnly>
        <Scripts />
      </body>
    </html>
  );
}
