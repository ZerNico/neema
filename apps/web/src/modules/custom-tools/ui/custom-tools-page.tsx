import { ArrowRight01Icon, CodeIcon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { EmptyState, ListCard, ListRow, Page } from "~/ui/page-shell.tsx";
import { Badge } from "~/ui/primitives/badge";
import { buttonVariants } from "~/ui/primitives/button";
import { m } from "~/paraglide/messages.js";
import { customToolsQuery } from "../client/queries.ts";

export function CustomToolsPage() {
  const { data: tools } = useSuspenseQuery(customToolsQuery);
  const newModule = (
    <Link to="/admin/custom-tools/new" className={buttonVariants({ size: "sm" })}>
      <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
      {m.custom_tools_list_new()}
    </Link>
  );

  return (
    <Page
      title={m.custom_tools_list_title()}
      description={m.custom_tools_list_description()}
      actions={newModule}
    >
      {tools.length === 0 ? (
        <EmptyState
          icon={CodeIcon}
          title={m.custom_tools_list_empty_title()}
          description={m.custom_tools_list_empty_description()}
          action={newModule}
        />
      ) : (
        <ListCard>
          {tools.map((tool) => (
            <Link
              key={tool.id}
              to="/admin/custom-tools/$toolId"
              params={{ toolId: tool.id }}
              className="block"
            >
              <ListRow interactive>
                <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-2xl">
                  <HugeiconsIcon icon={CodeIcon} strokeWidth={2} className="size-4" />
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <span className="truncate">{tool.name}</span>
                    {tool.audience === "private" ? (
                      <Badge variant="outline">{m.custom_tools_list_private()}</Badge>
                    ) : null}
                    {tool.enabled ? null : (
                      <Badge variant="outline">{m.custom_tools_list_disabled()}</Badge>
                    )}
                  </span>
                  <span className="text-muted-foreground truncate text-xs">
                    {[
                      tool.slug,
                      m.custom_tools_list_function_count({ count: tool.functionCount }),
                      tool.dependencyCount > 0
                        ? m.custom_tools_list_dependency_count({ count: tool.dependencyCount })
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  strokeWidth={2}
                  className="text-muted-foreground size-4 shrink-0"
                />
              </ListRow>
            </Link>
          ))}
        </ListCard>
      )}
    </Page>
  );
}
