import { useId } from "react";
import { Section } from "~/ui/page-shell.tsx";
import { Field, FieldLabel } from "~/ui/primitives/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";
import { SEARCH_ENGINES, useSearchEngine, type SearchEngine } from "../client/search-engine.ts";
import { useDesktopBrowser } from "../client/use-desktop-browser.ts";

const engines = Object.entries(SEARCH_ENGINES).map(([value, { label }]) => ({ value, label }));

/** Settings › Devices: what the browser's address bar searches with on this computer. */
export function BrowserSearchSetting() {
  const browser = useDesktopBrowser();
  const { engine, setEngine } = useSearchEngine();
  const id = useId();
  if (!browser) return null;
  return (
    <Section
      title="Browser"
      description="What the browser in the side panel searches with when you type something that isn’t an address."
    >
      <Field>
        <FieldLabel htmlFor={id}>Search engine</FieldLabel>
        <Select
          value={engine}
          onValueChange={(value) => {
            if (value) setEngine(value as SearchEngine);
          }}
          items={engines}
        >
          <SelectTrigger id={id} className="w-full sm:w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {engines.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </Section>
  );
}
