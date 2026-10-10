import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "~/ui/primitives/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/ui/primitives/tabs";
import { ChartCustomize } from "./customize.tsx";
import { ChartSetup } from "./setup.tsx";
import type { EditorContext } from "./setup-model.ts";

/**
 * The chart editor beside the grid, as Excel and Sheets have it: Setup for
 * what the chart draws, Customize for how it looks. Every change is one
 * patch through the connection, so it shows for everyone and undoes.
 */
export function ChartEditor({ onClose, ...context }: EditorContext & { onClose: () => void }) {
  return (
    <aside
      aria-label="Chart editor"
      className="border-border bg-background flex w-80 shrink-0 flex-col border-l"
    >
      <div className="border-border flex h-11 shrink-0 items-center justify-between border-b pr-2 pl-4">
        <h2 className="text-sm font-medium">Chart editor</h2>
        <Button size="icon-sm" variant="ghost" aria-label="Close chart editor" onClick={onClose}>
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
        </Button>
      </div>
      <Tabs defaultValue="setup" className="flex min-h-0 flex-1 flex-col">
        <div className="px-4 pt-3">
          <TabsList className="w-full">
            <TabsTrigger value="setup">Setup</TabsTrigger>
            <TabsTrigger value="customize">Customize</TabsTrigger>
          </TabsList>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <TabsContent value="setup">
            <ChartSetup {...context} />
          </TabsContent>
          <TabsContent value="customize">
            <ChartCustomize {...context} />
          </TabsContent>
        </div>
      </Tabs>
    </aside>
  );
}
