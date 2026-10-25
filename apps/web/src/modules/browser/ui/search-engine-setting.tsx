import { useId } from "react";
import { m } from "~/paraglide/messages.js";
import { ListCard, ListRow, Section } from "~/ui/page-shell.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";
import {
  SEARCH_ENGINES,
  useLinkTarget,
  useSearchEngine,
  type LinkTarget,
  type SearchEngine,
} from "../client/search-engine.ts";
import { useDesktopBrowser } from "../client/use-desktop-browser.ts";

const engines = Object.entries(SEARCH_ENGINES).map(([value, { label }]) => ({ value, label }));
const linkTargets: ReadonlyArray<{ value: LinkTarget; label: () => string }> = [
  { value: "panel", label: m.browser_settings_links_panel },
  { value: "external", label: m.browser_settings_links_external },
];

/** One choice as a row of the card: what it is on the left, the choice on the right. */
function ChoiceRow<T extends string>({
  label,
  description,
  value,
  options,
  onChange,
}: {
  label: string;
  description: string;
  value: T;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: T) => void;
}) {
  const id = useId();
  return (
    <ListRow className="flex-wrap">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <span className="text-muted-foreground text-xs">{description}</span>
      </div>
      <Select
        value={value}
        onValueChange={(next) => {
          const chosen = options.find((option) => option.value === next);
          if (chosen) onChange(chosen.value as T);
        }}
        items={options}
      >
        <SelectTrigger id={id} className="w-full sm:w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </ListRow>
  );
}

/** Settings › This computer: how the side panel's browser behaves here. */
export function BrowserSearchSetting() {
  const browser = useDesktopBrowser();
  const { engine, setEngine } = useSearchEngine();
  const [linkTarget, setLinkTarget] = useLinkTarget();
  if (!browser) return null;
  return (
    <Section title={m.browser_settings_title()}>
      <ListCard>
        <ChoiceRow<LinkTarget>
          label={m.browser_settings_links_label()}
          description={m.browser_settings_links_description()}
          value={linkTarget}
          options={linkTargets.map(({ value, label }) => ({ value, label: label() }))}
          onChange={setLinkTarget}
        />
        <ChoiceRow<SearchEngine>
          label={m.browser_settings_engine_label()}
          description={m.browser_settings_engine_description()}
          value={engine}
          options={engines}
          onChange={setEngine}
        />
      </ListCard>
    </Section>
  );
}
