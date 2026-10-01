import { useEffect, useState } from "react";

export type PreviewJson<T> =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly preview: T };

/**
 * A server-rendered preview's JSON, fetched fresh for each URL. The answer is
 * tagged with the URL it came from, so a new URL reads as loading until its
 * own answer arrives, whether or not the component was remounted. `decode`
 * checks the shape and returns null for anything else; pass a stable function.
 */
export function usePreviewJson<T>(url: string, decode: (data: unknown) => T | null) {
  const [loaded, setLoaded] = useState<{ readonly url: string; readonly state: PreviewJson<T> }>();

  useEffect(() => {
    const controller = new AbortController();
    void fetch(url, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Preview unavailable");
        const preview = decode(await response.json());
        if (preview === null) throw new Error("Invalid preview");
        if (!controller.signal.aborted) setLoaded({ url, state: { status: "ready", preview } });
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoaded({ url, state: { status: "error" } });
      });
    return () => controller.abort();
  }, [url, decode]);

  return loaded?.url === url ? loaded.state : ({ status: "loading" } as const);
}
