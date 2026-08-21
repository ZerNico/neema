import { useMutation, useQueryClient, useSuspenseQuery, queryOptions } from "@tanstack/react-query";
import { useState } from "react";
import { AdminPage, ListCard, ListRow } from "~/modules/admin/ui/admin-shell.tsx";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { Field, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { Switch } from "~/ui/primitives/switch";
import {
  getWebSearchTool,
  testSearchConnection,
  updateWebSearchTool,
} from "../server/functions.ts";

export const webSearchToolQuery = queryOptions({
  queryKey: ["admin", "tools", "web-search"],
  queryFn: () => getWebSearchTool(),
});

type TestResult =
  | { ok: true; resultCount: number; latencyMs: number }
  | { ok: false; error: string };

export function ToolsPage() {
  const queryClient = useQueryClient();
  const { data: tool } = useSuspenseQuery(webSearchToolQuery);

  // null = untouched → falls back to the stored value
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [maxResults, setMaxResults] = useState<string | null>(null);
  const [maxPagesFetched, setMaxPagesFetched] = useState<string | null>(null);
  const [perPageCharCap, setPerPageCharCap] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const config = (tool?.config ?? {}) as {
    baseUrl?: string;
    maxResults?: number;
    maxPagesFetched?: number;
    perPageCharCap?: number;
  };

  const effectiveBaseUrl = baseUrl ?? config.baseUrl ?? "";
  const effectiveMaxResults = maxResults ?? String(config.maxResults ?? 8);
  const effectiveMaxPages = maxPagesFetched ?? String(config.maxPagesFetched ?? 3);
  const effectiveCharCap = perPageCharCap ?? String(config.perPageCharCap ?? 12000);

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin", "tools"] }),
      queryClient.invalidateQueries({ queryKey: ["tools", "web-search", "availability"] }),
    ]);

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => updateWebSearchTool({ data: { enabled } }),
    onSuccess: invalidate,
  });

  const save = useMutation({
    mutationFn: () =>
      updateWebSearchTool({
        data: {
          baseUrl: effectiveBaseUrl,
          maxResults: Number(effectiveMaxResults),
          maxPagesFetched: Number(effectiveMaxPages),
          perPageCharCap: Number(effectiveCharCap),
          ...(secret ? { secret } : {}),
        },
      }),
    onSuccess: async () => {
      setSecret("");
      setBaseUrl(null);
      setMaxResults(null);
      setMaxPagesFetched(null);
      setPerPageCharCap(null);
      await invalidate();
    },
  });

  const clearSecret = useMutation({
    mutationFn: () => updateWebSearchTool({ data: { clearSecret: true } }),
    onSuccess: invalidate,
  });

  const test = useMutation({
    mutationFn: () =>
      testSearchConnection({ data: { baseUrl: effectiveBaseUrl, ...(secret ? { secret } : {}) } }),
    onSuccess: (result) => setTestResult(result),
  });

  if (!tool) {
    return (
      <AdminPage title="Tools" description="Assistant tools available in chats.">
        <p className="text-muted-foreground text-sm">
          The web_search tool row is missing — run database migrations.
        </p>
      </AdminPage>
    );
  }

  const numbersValid =
    Number(effectiveMaxResults) >= 1 &&
    Number(effectiveMaxResults) <= 10 &&
    Number(effectiveMaxPages) >= 0 &&
    Number(effectiveMaxPages) <= 5 &&
    Number(effectiveCharCap) >= 1000 &&
    Number(effectiveCharCap) <= 20000;

  return (
    <AdminPage title="Tools" description="Assistant tools available in chats.">
      <section className="flex flex-col gap-2">
        <h2 className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
          Web search
        </h2>
        <ListCard>
          <ListRow>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-medium">Web search</span>
              <span className="text-muted-foreground text-xs">
                SearXNG-backed search with page content extraction. Models with tool support get a
                search toggle in the composer.
              </span>
            </div>
            <Switch
              checked={tool.enabled}
              onCheckedChange={(checked) => toggle.mutate(checked)}
              disabled={toggle.isPending}
            />
          </ListRow>

          <ListRow className="flex-col items-stretch gap-3">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs">Backend</span>
              <Badge>SearXNG</Badge>
            </div>
            <Field>
              <FieldLabel>Base URL</FieldLabel>
              <Input
                value={effectiveBaseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://localhost:8081"
              />
            </Field>
            <Field>
              <FieldLabel>
                Bearer secret{" "}
                <span className="text-muted-foreground font-normal">
                  {tool.secretConfigured ? "(configured — leave empty to keep)" : "(optional)"}
                </span>
              </FieldLabel>
              <div className="flex gap-2">
                <Input
                  type="password"
                  autoComplete="off"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  className="flex-1"
                />
                {tool.secretConfigured ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => clearSecret.mutate()}
                    disabled={clearSecret.isPending}
                  >
                    Clear
                  </Button>
                ) : null}
              </div>
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field>
                <FieldLabel>Max results</FieldLabel>
                <Input
                  type="number"
                  min={1}
                  max={10}
                  value={effectiveMaxResults}
                  onChange={(e) => setMaxResults(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel>Pages fetched</FieldLabel>
                <Input
                  type="number"
                  min={0}
                  max={5}
                  value={effectiveMaxPages}
                  onChange={(e) => setMaxPagesFetched(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel>Chars per page</FieldLabel>
                <Input
                  type="number"
                  min={1000}
                  max={20000}
                  step={1000}
                  value={effectiveCharCap}
                  onChange={(e) => setPerPageCharCap(e.target.value)}
                />
              </Field>
            </div>
            {testResult ? (
              <p
                className={
                  testResult.ok ? "text-muted-foreground text-xs" : "text-destructive text-xs"
                }
              >
                {testResult.ok
                  ? `Connection ok — ${testResult.resultCount} results in ${testResult.latencyMs}ms`
                  : `Connection failed: ${testResult.error}`}
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => save.mutate()}
                disabled={!effectiveBaseUrl.trim() || !numbersValid || save.isPending}
              >
                {save.isPending ? "Saving…" : "Save"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setTestResult(null);
                  test.mutate();
                }}
                disabled={!effectiveBaseUrl.trim() || test.isPending}
              >
                {test.isPending ? "Testing…" : "Test connection"}
              </Button>
            </div>
          </ListRow>
        </ListCard>
      </section>
    </AdminPage>
  );
}
